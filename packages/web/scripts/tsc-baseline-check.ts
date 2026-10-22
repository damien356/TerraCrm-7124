// Type error baseline for tsconfig.app.json (recorded 21 Oct 2026: 139 errors).
// Releases must not add errors. Run from packages/web:
//   bun scripts/tsc-baseline-check.ts
// Exit 0 only when tsc really ran and checked files, and the total and every
// file/code count is at or below the baseline.
// When errors are fixed, rerun with UPDATE=1 to lower the baseline.
//
// The run is rejected (exit 1) when:
//   - tsc could not be started (missing binary, spawn error, timeout)
//   - tsc was killed by a signal (OOM, timeout) or has no exit status
//   - tsc printed an error it did not tie to a source file (config errors
//     such as TS5058, TS5083, TS6053, TS18003)
//   - tsc reported an error inside a tsconfig file
//   - the exit status and the parsed errors disagree (non-zero with no
//     errors, or zero with errors)
//   - the --diagnostics summary is missing or says no files were checked
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const BASELINE = "tsc-app-baseline.tsv";
export const TSC_CMD = "bunx";
export const TSC_ARGS = ["tsc", "-p", "tsconfig.app.json", "--noEmit", "--pretty", "false", "--diagnostics"];
const TIMEOUT_MS = 20 * 60 * 1000;

export type TscRun = {
  error?: Error | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export function runTsc(cmd = TSC_CMD, args = TSC_ARGS, cwd = process.cwd()): TscRun {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1800" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT_MS,
  });
  return {
    error: r.error ?? null,
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

export type Counts = Map<string, number>;

export function parseBaseline(text: string): Counts {
  const base: Counts = new Map();
  for (const line of text.split("\n")) {
    const [file, code, n] = line.split("\t");
    if (file && code && n) base.set(`${file}\t${code}`, Number(n));
  }
  return base;
}

export const total = (m: Counts) => [...m.values()].reduce((a, b) => a + b, 0);

export type Verdict = {
  ok: boolean;
  /** true when the tsc run itself can be trusted (needed before UPDATE=1). */
  valid: boolean;
  now: Counts;
  problems: string[];
  worse: string[];
};

const POSITIONED = /^(.+?)\(\d+,\d+\): error (TS\d+)/;
const ANY_ERROR = /\berror TS\d+/;

export function evaluate(run: TscRun, base: Counts): Verdict {
  const problems: string[] = [];
  const now: Counts = new Map();
  const out = `${run.stdout}\n${run.stderr}`;

  if (run.error) problems.push(`tsc did not run: ${run.error.message}`);
  if (run.signal) problems.push(`tsc was killed by ${run.signal}`);
  else if (run.status === null && !run.error) problems.push("tsc gave no exit status");

  const unparsed: string[] = [];
  for (const line of out.split("\n")) {
    const m = POSITIONED.exec(line);
    if (m) {
      if (/(^|\/)tsconfig[^/]*\.json$/.test(m[1])) {
        problems.push(`config error: ${line.trim()}`);
        continue;
      }
      const key = `${m[1]}\t${m[2]}`;
      now.set(key, (now.get(key) ?? 0) + 1);
    } else if (ANY_ERROR.test(line)) {
      unparsed.push(line.trim());
    }
  }
  for (const u of unparsed) problems.push(`error not tied to a source file: ${u}`);

  if (!run.error && !run.signal && run.status !== null) {
    if (run.status !== 0 && total(now) === 0 && unparsed.length === 0 && !problems.length)
      problems.push(`tsc exited ${run.status} but reported no type errors`);
    if (run.status === 0 && total(now) > 0)
      problems.push(`tsc exited 0 but reported ${total(now)} type errors`);
  }

  const files = /^Files:\s+(\d+)\s*$/m.exec(out);
  if (!files) problems.push("tsc printed no --diagnostics summary, so it did not finish checking");
  else if (Number(files[1]) === 0) problems.push("tsc checked 0 files");

  const worse: string[] = [];
  for (const [key, n] of now) {
    const was = base.get(key) ?? 0;
    if (n > was) worse.push(`${key.replace("\t", " ")}: ${was} -> ${n}`);
  }
  const valid = problems.length === 0;
  const ok = valid && worse.length === 0 && total(now) <= total(base);
  return { ok, valid, now, problems, worse };
}

export function main(): number {
  const base = parseBaseline(readFileSync(BASELINE, "utf8"));
  const run = runTsc();
  const v = evaluate(run, base);

  console.log(`app type errors: baseline ${total(base)}, now ${total(v.now)}`);

  if (!v.valid) {
    console.log("FAIL: the tsc run cannot be trusted.");
    for (const p of v.problems) console.log(`  ${p}`);
    if (process.env.UPDATE === "1") console.log("Not updating the baseline.");
    return 1;
  }

  if (process.env.UPDATE === "1") {
    if (!v.ok) {
      console.log("Not updating: some counts went up.");
      for (const w of v.worse) console.log(`  ${w}`);
      return 1;
    }
    const rows = [...v.now].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}\t${n}`);
    writeFileSync(BASELINE, rows.length ? `${rows.join("\n")}\n` : "");
    console.log("Baseline lowered.");
    return 0;
  }

  if (!v.ok) {
    console.log("FAIL: new type errors.");
    for (const w of v.worse) console.log(`  ${w}`);
    return 1;
  }
  console.log("OK: no new type errors.");
  return 0;
}

if (import.meta.main) process.exit(main());
