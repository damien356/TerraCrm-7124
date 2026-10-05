/** Shared credential filter for backup data, never for the live database. */
export const credentialName = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|private[_-]?key|key[_-]?hash|token[_-]?hash|client[_-]?secret|credential|(?:^|_)token(?:$|_))/i;

const secrets = Object.entries(process.env)
  .filter(([k, v]) => credentialName.test(k) && v && v.length >= 8)
  .flatMap(([, v]) => [v!, encodeURIComponent(v!)])
  .sort((a, b) => b.length - a.length);
if (process.env.SUPABASE_DB_PASSWORD_B64) {
  secrets.push(Buffer.from(process.env.SUPABASE_DB_PASSWORD_B64, "base64").toString("utf8"));
}

export function scrubBackupText(text: string): string {
  for (const value of secrets) text = text.split(value).join("[REDACTED]");
  return text
    .replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*(?:X-Amz-Signature|[?&](?:token|access_token)=)[^\s"'<>]*/gi, "$1")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED-JWT]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sb_secret_[A-Za-z0-9_-]+|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, "[REDACTED-KEY]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[=:]\s*)[^\s,;"'<>]+/gi, "$1[REDACTED]");
}

function scrubJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, credentialName.test(k) ? null : scrubJson(v)]));
  }
  return typeof value === "string" ? scrubBackupText(value) : value;
}

export function backupValue(table: string, column: string, row: Record<string, unknown>) {
  const value = row[column];
  if (credentialName.test(column)) return value == null ? value : `RESET-REQUIRED-${String(row.id ?? "")}`;
  if (table === "settings" && column === "value" && credentialName.test(String(row.key))) return "[REDACTED]";
  if (typeof value !== "string") return value;
  if (/^\s*[[{]/.test(value)) {
    try { return JSON.stringify(scrubJson(JSON.parse(value))); } catch { /* Plain text. */ }
  }
  return scrubBackupText(value);
}