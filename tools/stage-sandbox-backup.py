#!/usr/bin/env python3
"""Stage a credential-filtered copy of business files. Never changes originals."""
import base64, csv, gzip, hashlib, io, json, os, re, shutil, sqlite3, sys, tempfile, zipfile
from pathlib import Path
from urllib.parse import quote

ROOT = Path(os.environ.get('BACKUP_HOME', '/home/user'))
DEST = Path(sys.argv[1])
SECRET = re.compile(r'password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|private[_-]?key|key[_-]?hash|token[_-]?hash|client[_-]?secret|credential|(?:^|_)token(?:$|_)', re.I)
OMIT_DIRS = {'node_modules', '.git', '.cache', '.npm', '.bun', '.expo', '.turbo', '.openvscode-server', '.app-template', '.scripts', '.pm2', '.ssh', '.secrets', '.config', '.local', '.libreoffice-seed', '.app-store', '.version', '.gradle', '.kotlin', 'dist', 'dist-electron', 'web-build', 'build', 'Pods', 'coverage', 'logs'}
OMIT_EXT = {'.jks', '.keystore', '.p8', '.p12', '.key', '.mobileprovision', '.aab', '.apk', '.ipa', '.class', '.jar', '.pyc', '.tsbuildinfo', '.log'}
OMIT_NAMES = {'.bash_history', '.zsh_history', '.netrc', '.npmrc', '.yarnrc', '.wget-hsts', '.DS_Store'}
MEDIA_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.mp4', '.mov', '.mp3', '.wav', '.m4a', '.ogg', '.webm', '.ttf', '.woff', '.woff2', '.ico', '.der'}
secrets = set()
report = {'included': [], 'excluded': [], 'failed': [], 'redactedFiles': 0}

def excluded(rel):
    p = Path(rel)
    if any(part in OMIT_DIRS for part in p.parts): return 'Reinstallable tooling, caches, Git history or private credential stores'
    if p.name.startswith('.env') or p.name in OMIT_NAMES: return 'Credential/configuration file'
    if 'cookie' in p.name.lower() and p.suffix.lower() in {'', '.txt', '.jar'}: return 'Credential/configuration file'
    if p.suffix.lower() in OMIT_EXT or p.name.endswith(('-wal', '-shm', '-journal')): return 'Credential, compiled output or database sidecar'
    return None

def add_secret(v):
    if isinstance(v, str) and len(v) >= 8 and v not in ('[REDACTED]', 'RESET-REQUIRED'):
        secrets.add(v)
        secrets.add(quote(v, safe=''))

def gather_json(v):
    if isinstance(v, list):
        for x in v: gather_json(x)
    elif isinstance(v, dict):
        for k, x in v.items():
            if SECRET.search(k): add_secret(x)
            else: gather_json(x)

def gather_db(path):
    c = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    try:
        for (table,) in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'"):
            cols = c.execute(f'pragma table_info({qi(table)})').fetchall()
            for col in cols:
                if SECRET.search(col[1]):
                    for (v,) in c.execute(f'select {qi(col[1])} from {qi(table)}'): add_secret(v)
            if table == 'settings':
                for k, v in c.execute('select key, value from settings'):
                    if SECRET.search(k): add_secret(v)
    finally: c.close()

def qi(s): return '"' + s.replace('"', '""') + '"'

files = []
for base, dirs, names in os.walk(ROOT, followlinks=False):
    relbase = Path(base).relative_to(ROOT)
    for d in list(dirs):
        why = excluded(str(relbase / d))
        if why:
            dirs.remove(d)
            report['excluded'].append({'path': str(relbase / d) + '/', 'reason': why})
    for name in names:
        path = Path(base) / name
        rel = str(path.relative_to(ROOT))
        why = excluded(rel)
        if path.is_symlink(): why = 'Symlink, original destination backed up separately if in scope'
        if why:
            report['excluded'].append({'path': rel, 'reason': why})
            # Collect secret literals to remove them from logs and histories too.
            if name.startswith('.env') or rel.startswith('.secrets/'):
                try:
                    for line in path.read_text().splitlines():
                        if '=' not in line or line.startswith('#'): continue
                        k, v = line.split('=', 1)
                        v = v.strip().strip('"\'')
                        if SECRET.search(k):
                            add_secret(v)
                            if k.endswith('_B64'):
                                try: add_secret(base64.b64decode(v).decode())
                                except Exception: pass
                except Exception: pass
            continue
        files.append((path, rel))

# Harvest historical credentials before any file is copied.
for path, rel in files:
    try:
        if path.suffix.lower() in {'.db', '.sqlite', '.sqlite3'}: gather_db(path)
        elif path.suffix.lower() == '.json': gather_json(json.loads(path.read_text()))
    except Exception: pass  # Processing below fails closed if a file cannot be read/sanitised.
ordered_secrets = sorted(secrets, key=len, reverse=True)

def clean_text(s):
    for value in ordered_secrets: s = s.replace(value, '[REDACTED]')
    s = re.sub(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', '[REDACTED-PRIVATE-KEY]', s, flags=re.S)
    s = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[REDACTED-JWT]', s)
    s = re.sub(r'\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sb_secret_[A-Za-z0-9_-]+|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b', '[REDACTED-KEY]', s)
    s = re.sub(r'(Bearer\s+)[A-Za-z0-9._~+/=-]+', r'\1[REDACTED]', s, flags=re.I)
    s = re.sub(r'(session_token(?:=|\t))[A-Za-z0-9._~+/%=-]{8,}', r'\1[REDACTED]', s, flags=re.I)
    s = re.sub(r'(https?://[^\s"\'<>?]+)\?[^\s"\'<>]*X-Amz-Signature[^\s"\'<>]*', r'\1', s, flags=re.I)
    # Only literal assignments, not references to variables in application source.
    s = re.sub(r'((?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[=:]\s*["\'])([^"\'\n]{8,})(["\'])', r'\1[REDACTED]\3', s, flags=re.I)
    s = re.sub(r'(postgres(?:ql)?://[^:\s]+:)[^@\s]+@', r'\1[REDACTED]@', s)
    return s

def clean_json(v, parent=''):
    if isinstance(v, list):
        if parent in {'session', 'verification'}: return []
        return [clean_json(x, parent) for x in v]
    if isinstance(v, dict):
        return {k: ('[REDACTED]' if SECRET.search(k) and x is not None else clean_json(x, k)) for k, x in v.items()}
    return clean_text(v) if isinstance(v, str) else v

def sanitise_db(source, target):
    src = sqlite3.connect(source)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
        dst.execute('pragma foreign_keys=OFF')
        dst.execute('pragma secure_delete=ON')
        dst.row_factory = sqlite3.Row
        names = [r[0] for r in dst.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
        for name in names:
            if name in {'session', 'verification'}:
                dst.execute(f'delete from {qi(name)}')
                continue
            cols = dst.execute(f'pragma table_info({qi(name)})').fetchall()
            for row in dst.execute(f'select rowid as _bk_rowid, * from {qi(name)}').fetchall():
                updates = {}
                for col in cols:
                    k, required = col['name'], col['notnull']
                    value = row[k]
                    if SECRET.search(k):
                        new = f'RESET-REQUIRED-{row["_bk_rowid"]}' if required else None
                    elif name == 'settings' and k == 'value' and SECRET.search(str(row['key'])):
                        new = '[REDACTED]'
                    elif isinstance(value, str):
                        try: new = json.dumps(clean_json(json.loads(value)), ensure_ascii=False) if value.lstrip().startswith(('[', '{')) else clean_text(value)
                        except ValueError: new = clean_text(value)
                    else: continue
                    if new != value: updates[k] = new
                if updates:
                    dst.execute(f'update {qi(name)} set ' + ','.join(f'{qi(k)}=?' for k in updates) + ' where rowid=?', [*updates.values(), row['_bk_rowid']])
        dst.commit()
        dst.execute('vacuum')  # Removes the original secret bytes, including free pages.
        if dst.execute('pragma integrity_check').fetchone()[0] != 'ok': raise ValueError('Integrity check failed')
    finally:
        dst.close()
        src.close()

def sanitise(data, name, depth=0):
    if depth > 5: raise ValueError('Nested archive depth exceeds safety limit')
    suffix = Path(name).suffix.lower()
    if data.startswith(b'SQLite format 3\x00'):
        with tempfile.TemporaryDirectory() as td:
            a, b = Path(td) / 'raw.db', Path(td) / 'clean.db'
            a.write_bytes(data)
            sanitise_db(a, b)
            return b.read_bytes()
    if suffix == '.sql' and re.search(rb'INSERT\s+INTO', data, re.I) and b'CREATE TABLE' in data.upper():
        with tempfile.TemporaryDirectory() as td:
            a, b = Path(td) / 'raw.db', Path(td) / 'clean.db'
            c = sqlite3.connect(a)
            try:
                c.executescript(data.decode('utf8'))
                ran = True
            except sqlite3.Error:
                # A migration that alters tables it does not create cannot run on its own,
                # so it is not a data dump. Text redaction below still applies. Fail closed
                # if it writes login rows, which text redaction cannot clean.
                if re.search(rb'INSERT\s+INTO\s+["`\[]?(account|session|verification|user)\b', data, re.I):
                    raise ValueError('SQL writes login tables and cannot be checked, review before backup')
                ran = False
            finally: c.close()
            if ran:
                sanitise_db(a, b)
                c = sqlite3.connect(b)
                try: return ('\n'.join(c.iterdump()) + '\n').encode()
                finally: c.close()
    if data.startswith(b'PK\x03\x04'):
        out = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(data)) as z, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as dest:
            for member in z.infolist():
                if member.is_dir(): continue
                why = excluded(member.filename)
                if why:
                    report['excluded'].append({'path': name + '::' + member.filename, 'reason': why})
                    continue
                dest.writestr(member.filename, sanitise(z.read(member), member.filename, depth + 1))
        return out.getvalue()
    if suffix == '.gz': return gzip.compress(sanitise(gzip.decompress(data), str(Path(name).with_suffix('')), depth + 1), mtime=0)
    if suffix in MEDIA_EXT:
        # No text edits to photos/audio/PDFs. Fail closed if a known credential occurs in their bytes.
        if any(value.encode() in data for value in ordered_secrets): raise ValueError('Known credential detected in binary media, review before backup')
        return data
    try: text = data.decode('utf8')
    except UnicodeDecodeError: raise ValueError('Unrecognised binary format, requires review before backup')
    if suffix == '.json':
        try: return (json.dumps(clean_json(json.loads(text)), ensure_ascii=False, indent=2) + '\n').encode()
        except ValueError: pass
    if suffix == '.csv':
        rows = list(csv.reader(io.StringIO(text)))
        if rows:
            for row in rows[1:]:
                for i, k in enumerate(rows[0]):
                    if i < len(row): row[i] = '[REDACTED]' if SECRET.search(k) else clean_text(row[i])
            out = io.StringIO()
            csv.writer(out).writerows(rows)
            return out.getvalue().encode()
    return clean_text(text).encode()

DEST.mkdir(parents=True, exist_ok=True)
for path, rel in files:
    try:
        data = path.read_bytes()
        safe = sanitise(data, rel)
        target = DEST / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(safe)
        if safe != data: report['redactedFiles'] += 1
        report['included'].append({'path': rel, 'bytes': len(safe), 'sha256': hashlib.sha256(safe).hexdigest()})
    except Exception as e:
        report['failed'].append({'path': rel, 'reason': clean_text(str(e))})
report['totalBytes'] = sum(x['bytes'] for x in report['included'])
(DEST / '_inventory.json').write_text(json.dumps(report, indent=2))
print(json.dumps({'files': len(report['included']), 'bytes': report['totalBytes'], 'redactedFiles': report['redactedFiles'], 'excluded': len(report['excluded']), 'failed': report['failed']}, indent=2))
if report['failed']: sys.exit(2)