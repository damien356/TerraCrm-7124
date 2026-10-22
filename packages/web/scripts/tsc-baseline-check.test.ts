// Regression tests for scripts/tsc-baseline-check.ts.
// Run from packages/web:  bun test scripts/tsc-baseline-check.test.ts
// The check used to pass ("now 0", exit 0) when tsc could not start, was
// killed, or stopped on a config error. These tests pin that it fails.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { evaluate, parseBaseline, runTsc, total, TSC_ARGS, type TscRun } from "./tsc-baseline-check";

const SCRIPT = join(import.meta.dir, "tsc-baseline-check.ts");
const DIAG = "Files:              84\nLines:           58448\nCheck time:    0.228s\n";
const base = parseBaseline("src/a.ts\tTS2322\t2\nsrc/b.ts\tTS7006\t1\n");
const run = (p: Partial<TscRun>): TscRun => ({ error: null, status: 0, signal: null, stdout: "", stderr: "", ...p });
const errs = (...l: string[]) => l.map((x) => `${x}\n`).join("");

describe("evaluate (synthetic tsc output)", () => {
  test("baseline file parses to 3", () => expect(total(base)).toBe(3));

  test("missing binary (spawn ENOENT) fails", () => {
    const e = Object.assign(new Error("spawnSync bunx ENOENT"), { code: "ENOENT" });
    const v = evaluate(run({ error: e, status: null }), base);
    expect(v.ok).toBe(false);
    expect(v.valid).toBe(false);
    expect(v.problems.join()).toContain("did not run");
  });

  test("killed by a signal fails", () => {
    const v = evaluate(run({ status: null, signal: "SIGKILL", stdout: errs("src/a.ts(1,1): error TS2322: x") }), base);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toContain("SIGKILL");
  });

  test("timeout fails", () => {
    const e = Object.assign(new Error("spawnSync bunx ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(evaluate(run({ error: e, status: null, signal: "SIGTERM" }), base).ok).toBe(false);
  });

  test("config error with no position (TS5083) fails", () => {
    const v = evaluate(run({ status: 2, stdout: errs("error TS5083: Cannot read file '/x/nope.json'.") }), base);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toContain("TS5083");
  });

  test("missing tsconfig (TS5058) fails", () => {
    expect(evaluate(run({ status: 1, stdout: errs("error TS5058: The specified path does not exist: 'x'.") }), base).ok).toBe(false);
  });

  test("TS6053 / TS18003 mixed with real errors still fails", () => {
    const v = evaluate(run({
      status: 2,
      stdout: errs("src/a.ts(1,1): error TS2322: x", "error TS6053: File 'y.ts' not found.", "error TS18003: No inputs were found") + DIAG,
    }), base);
    expect(v.ok).toBe(false);
    expect(v.problems.length).toBe(2);
  });

  test("error inside a tsconfig file fails", () => {
    const v = evaluate(run({ status: 1, stdout: errs("tsconfig.app.json(3,5): error TS5023: Unknown compiler option 'x'.") + DIAG }), base);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toContain("config error");
  });

  test("garbage output with non-zero exit fails", () => {
    const v = evaluate(run({ status: 1, stdout: "Segmentation fault\nsomething odd\n" }), base);
    expect(v.ok).toBe(false);
  });

  test("garbage output with exit 0 fails (no diagnostics summary)", () => {
    const v = evaluate(run({ status: 0, stdout: "hello\n" }), base);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toContain("--diagnostics");
  });

  test("empty output with exit 0 fails", () => {
    expect(evaluate(run({ status: 0 }), base).ok).toBe(false);
  });

  test("0 files checked fails", () => {
    expect(evaluate(run({ status: 0, stdout: "Files: 0\n" }), base).ok).toBe(false);
  });

  test("exit 0 with errors reported fails", () => {
    expect(evaluate(run({ status: 0, stdout: errs("src/a.ts(1,1): error TS2322: x") + DIAG }), base).ok).toBe(false);
  });

  test("new error in a new file fails", () => {
    const v = evaluate(run({ status: 2, stdout: errs("src/a.ts(1,1): error TS2322: x", "src/c.ts(4,2): error TS2345: y") + DIAG }), base);
    expect(v.valid).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.worse).toEqual(["src/c.ts TS2345: 0 -> 1"]);
  });

  test("one more of an existing file/code fails", () => {
    const v = evaluate(run({ status: 2, stdout: errs("src/a.ts(1,1): error TS2322: x", "src/a.ts(2,1): error TS2322: x", "src/a.ts(3,1): error TS2322: x") + DIAG }), base);
    expect(v.ok).toBe(false);
    expect(v.worse).toEqual(["src/a.ts TS2322: 2 -> 3"]);
  });

  test("equal to baseline passes", () => {
    const v = evaluate(run({ status: 2, stdout: errs("src/a.ts(1,1): error TS2322: x", "src/a.ts(9,1): error TS2322: x", "src/b.ts(2,2): error TS7006: z") + DIAG }), base);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(total(v.now)).toBe(3);
  });

  test("fewer than baseline passes", () => {
    expect(evaluate(run({ status: 2, stdout: errs("src/a.ts(1,1): error TS2322: x") + DIAG }), base).ok).toBe(true);
  });

  test("clean run that really checked files passes", () => {
    expect(evaluate(run({ status: 0, stdout: DIAG }), base).ok).toBe(true);
  });
});

describe("runTsc + evaluate (real processes)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tscbl-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "export const a: number = 1;\n");
    writeFileSync(join(dir, "kill.sh"), "#!/bin/sh\nkill -9 $$\n");
    writeFileSync(join(dir, "garbage.sh"), "#!/bin/sh\necho 'not tsc'\nexit 3\n");
    chmodSync(join(dir, "kill.sh"), 0o755);
    chmodSync(join(dir, "garbage.sh"), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = (s: object) => writeFileSync(join(dir, "tsconfig.app.json"), JSON.stringify(s));

  test("missing binary", () => {
    const r = runTsc("/nonexistent/bunx", TSC_ARGS, dir);
    expect(r.error).toBeTruthy();
    expect(evaluate(r, base).ok).toBe(false);
  });

  test("process killed by SIGKILL", () => {
    const r = runTsc(join(dir, "kill.sh"), [], dir);
    expect(r.signal).toBe("SIGKILL");
    expect(evaluate(r, base).ok).toBe(false);
  });

  test("garbage output, exit 3", () => {
    expect(evaluate(runTsc(join(dir, "garbage.sh"), [], dir), base).ok).toBe(false);
  });

  test("real tsc, tsconfig missing (TS5058)", () => {
    rmSync(join(dir, "tsconfig.app.json"), { force: true });
    const r = runTsc(undefined, undefined, dir);
    expect(`${r.stdout}${r.stderr}`).toContain("TS5058");
    expect(evaluate(r, base).ok).toBe(false);
  });

  test("real tsc, extends a missing file (TS5083)", () => {
    cfg({ extends: "./nope.json", include: ["src"] });
    const r = runTsc(undefined, undefined, dir);
    expect(`${r.stdout}${r.stderr}`).toContain("TS5083");
    expect(evaluate(r, base).ok).toBe(false);
  });

  test("real tsc, new type error fails", () => {
    cfg({ compilerOptions: { strict: true }, include: ["src"] });
    writeFileSync(join(dir, "src/c.ts"), "export const c: number = 'x';\n");
    const v = evaluate(runTsc(undefined, undefined, dir), base);
    expect(v.valid).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.worse).toEqual(["src/c.ts TS2322: 0 -> 1"]);
    rmSync(join(dir, "src/c.ts"));
  });

  test("real tsc, equal to its own baseline passes", () => {
    cfg({ compilerOptions: { strict: true }, include: ["src"] });
    writeFileSync(join(dir, "src/c.ts"), "export const c: number = 'x';\n");
    const v = evaluate(runTsc(undefined, undefined, dir), parseBaseline("src/c.ts\tTS2322\t1\n"));
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    rmSync(join(dir, "src/c.ts"));
  });

  test("script exits 1 and UPDATE=1 leaves the baseline alone on a config error", () => {
    cfg({ extends: "./nope.json", include: ["src"] });
    const tsv = "src/a.ts\tTS2322\t2\n";
    writeFileSync(join(dir, "tsc-app-baseline.tsv"), tsv);
    for (const UPDATE of ["", "1"]) {
      const r = spawnSync("bun", [SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, UPDATE } });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("cannot be trusted");
    }
    expect(readFileSync(join(dir, "tsc-app-baseline.tsv"), "utf8")).toBe(tsv);
  });

  test("script exits 1 when bunx is not on PATH", () => {
    cfg({ compilerOptions: { strict: true }, include: ["src"] });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("did not run");
  });
});
