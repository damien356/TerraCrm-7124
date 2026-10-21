// Type error baseline for tsconfig.app.json (recorded 21 Oct 2026: 139 errors).
// Releases must not add errors. Run from packages/web:
//   bun scripts/tsc-baseline-check.ts
// Exit 0 when the total and every file/code count is at or below the baseline.
// When errors are fixed, rerun with UPDATE=1 to lower the baseline.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const BASELINE = "tsc-app-baseline.tsv";

const run = spawnSync("bunx", ["tsc", "-p", "tsconfig.app.json", "--noEmit"], {
  encoding: "utf8",
  env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1800" },
  maxBuffer: 64 * 1024 * 1024,
});
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;

const now = new Map<string, number>();
for (const line of out.split("\n")) {
  const m = /^(.+?)\(\d+,\d+\): error (TS\d+)/.exec(line);
  if (!m) continue;
  const key = `${m[1]}\t${m[2]}`;
  now.set(key, (now.get(key) ?? 0) + 1);
}

const base = new Map<string, number>();
for (const line of readFileSync(BASELINE, "utf8").split("\n")) {
  const [file, code, n] = line.split("\t");
  if (file && code && n) base.set(`${file}\t${code}`, Number(n));
}

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const worse: string[] = [];
for (const [key, n] of now) {
  const was = base.get(key) ?? 0;
  if (n > was) worse.push(`${key.replace("\t", " ")}: ${was} -> ${n}`);
}

console.log(`app type errors: baseline ${total(base)}, now ${total(now)}`);

if (process.env.UPDATE === "1") {
  if (worse.length) {
    console.log("Not updating: some counts went up.");
    for (const w of worse) console.log(`  ${w}`);
    process.exit(1);
  }
  const rows = [...now].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}\t${n}`);
  writeFileSync(BASELINE, `${rows.join("\n")}\n`);
  console.log("Baseline lowered.");
  process.exit(0);
}

if (worse.length || total(now) > total(base)) {
  console.log("FAIL: new type errors.");
  for (const w of worse) console.log(`  ${w}`);
  process.exit(1);
}
console.log("OK: no new type errors.");
