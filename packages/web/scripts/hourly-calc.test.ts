/* Hourly pay and vehicle allowance maths (lib/hourly-calc.ts). The brief's examples, to the cent. */
import { describe, expect, test } from "bun:test";
import { compare, inNight, payLines, rateFor, suggestSplit, vehicleShares, workIntervals } from "../src/api/lib/hourly-calc";

const pedro = { baseRate: 47, weekendMultiplier: 1.5, nightMultiplier: 2 };
const TZ = "Australia/Brisbane";
const bne = (s: string) => Date.parse(`${s}+10:00`);
const H = 60;

describe("rates", () => {
  test("47 / 70.50 / 94, night never stacks on weekend", () => {
    expect(rateFor("standard", pedro)).toBe(47);
    expect(rateFor("weekend", pedro)).toBe(70.5);
    expect(rateFor("night", pedro)).toBe(94);
  });
});

describe("brief examples", () => {
  test("8 weekday hours: 376 + 50 = 426", () => {
    const p = payLines([{ band: "standard", minutes: 8 * H }], pedro);
    expect(p.total).toBe(376);
    expect(compare({ benchmark: null, labour: p.total, vehicle: 50, benchmarkVehicle: "unknown" }).combined).toBe(426);
  });
  test("8 weekend daytime hours: 564 + 50 = 614", () => {
    const p = payLines([{ band: "weekend", minutes: 8 * H }], pedro);
    expect(p.total).toBe(564);
    expect(compare({ benchmark: null, labour: p.total, vehicle: 50, benchmarkVehicle: "unknown" }).combined).toBe(614);
  });
  test("8 night hours incl Saturday night: 752 + 50 = 802", () => {
    const p = payLines([{ band: "night", minutes: 8 * H }], pedro);
    expect(p.total).toBe(752);
    expect(compare({ benchmark: null, labour: p.total, vehicle: 50, benchmarkVehicle: "unknown" }).combined).toBe(802);
  });
  test("completed job 25.5 h over 3 days vs 2,500", () => {
    const days = [8.5, 8.5, 8.5].map((h) => payLines([{ band: "standard", minutes: h * H }], pedro).total);
    const labour = Math.round(days.reduce((s, x) => s + x, 0) * 100) / 100;
    expect(labour).toBe(1198.5);
    const vehicle = 3 * 50;
    const c = compare({ benchmark: 2500, labour, vehicle, benchmarkVehicle: "unknown" });
    expect(c.combined).toBe(1348.5);
    expect(c.savingBeforeVehicle).toBe(1301.5);
    expect(c.savingAfterVehicle).toBe(1151.5);
    expect(c.provisional).toBe(true);
    expect(compare({ benchmark: 2500, labour, vehicle, benchmarkVehicle: "included" }).likeForLike).toBe("after");
  });
});

describe("band split in Brisbane time", () => {
  test("no night window set: nothing is classed night automatically", () => {
    const s = suggestSplit([[bne("2026-10-31T19:00:00"), bne("2026-11-01T01:00:00")]], TZ, null);
    expect(s.split).toEqual([{ band: "weekend", minutes: 6 * H }]);
  });
  test("Friday into Saturday with a window: weekday, then night, night replaces weekend", () => {
    const w = { start: "18:00", end: "06:00" };
    const s = suggestSplit([[bne("2026-10-30T16:00:00"), bne("2026-10-31T08:00:00")]], TZ, w);
    expect(s.split).toEqual([
      { band: "standard", minutes: 2 * H },
      { band: "weekend", minutes: 2 * H },
      { band: "night", minutes: 12 * H },
    ]);
  });
  test("Saturday day into Saturday night: weekend then night", () => {
    const s = suggestSplit([[bne("2026-10-31T14:00:00"), bne("2026-10-31T22:00:00")]], TZ, { start: "18:00", end: "06:00" });
    expect(s.split).toEqual([
      { band: "weekend", minutes: 4 * H },
      { band: "night", minutes: 4 * H },
    ]);
    expect(payLines(s.split, pedro).total).toBe(4 * 70.5 + 4 * 94);
  });
  test("UTC midnight is not the boundary: Monday 09:00 Brisbane is Sunday 23:00 UTC", () => {
    const s = suggestSplit([[bne("2026-11-02T09:00:00"), bne("2026-11-02T10:00:00")]], TZ, null);
    expect(s.split).toEqual([{ band: "standard", minutes: 60 }]);
  });
  test("inNight crossing midnight", () => {
    const w = { start: "18:00", end: "06:00" };
    expect(inNight("17:59", w)).toBe(false);
    expect(inNight("18:00", w)).toBe(true);
    expect(inNight("05:59", w)).toBe(true);
    expect(inNight("06:00", w)).toBe(false);
    expect(inNight("23:00", null)).toBe(false);
  });
});

describe("breaks", () => {
  const a = bne("2026-11-02T07:00:00");
  const b = bne("2026-11-02T15:30:00");
  const br = { start: bne("2026-11-02T12:00:00"), end: bne("2026-11-02T12:30:00") };
  test("unpaid break comes out, paid break stays in, undecided reported", () => {
    expect(workIntervals(a, b, [{ ...br, paid: false }]).unpaidBreak).toBe(30);
    const unpaid = workIntervals(a, b, [{ ...br, paid: false }]);
    expect(suggestSplit(unpaid.intervals, TZ, null).minutes).toBe(8 * H);
    const paid = workIntervals(a, b, [{ ...br, paid: true }]);
    expect(paid.paidBreak).toBe(30);
    expect(suggestSplit(paid.intervals, TZ, null).minutes).toBe(8.5 * H);
    expect(workIntervals(a, b, [{ ...br, paid: null }]).undecided).toBe(30);
  });
});

describe("vehicle allowance", () => {
  test("one vehicle, two jobs: one $50 split by time, cents add back", () => {
    const v = vehicleShares(50, [
      { taskId: 1, minutes: 5 * H },
      { taskId: 2, minutes: 3 * H },
    ]);
    expect(v.shares.map((s) => s.share)).toEqual([31.25, 18.75]);
    const third = vehicleShares(50, [
      { taskId: 1, minutes: 1 },
      { taskId: 2, minutes: 1 },
      { taskId: 3, minutes: 1 },
    ]);
    expect(Math.round(third.shares.reduce((s, x) => s + x.share, 0) * 100)).toBe(5000);
  });
  test("two workers in one vehicle on one job: still one $50", () => {
    const v = vehicleShares(50, [
      { taskId: 7, minutes: 8 * H },
      { taskId: 7, minutes: 8 * H },
    ]);
    expect(v.shares).toEqual([{ taskId: 7, minutes: 16 * H, share: 50, override: false }]);
  });
  test("office correction wins only when it adds up to the allowance", () => {
    const parts = [
      { taskId: 1, minutes: 5 * H },
      { taskId: 2, minutes: 3 * H },
    ];
    const good = vehicleShares(50, parts, [
      { taskId: 1, share: 25 },
      { taskId: 2, share: 25 },
    ]);
    expect(good.shares.map((s) => [s.share, s.override])).toEqual([
      [25, true],
      [25, true],
    ]);
    const bad = vehicleShares(50, parts, [{ taskId: 1, share: 40 }]);
    expect(bad.overrideIgnored).toBe(true);
    expect(bad.shares.map((s) => s.share)).toEqual([31.25, 18.75]);
  });
});
