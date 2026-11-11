import { describe, expect, it } from "vitest";

import { ShiftsSchema, daysInclusive, latestWeek } from "../lib/tools/days.js";
import { SalesRangeSchema, salesByDay } from "../lib/tools/sales.js";
import shiftsJson from "../lib/data/mock/shifts.json";

const shifts = ShiftsSchema.parse(shiftsJson);
const report = salesByDay(shifts);
const dayOn = (date: string) => report.days.find((d) => d.date === date)!;

const shift = { staff: "A", slot: "morning", costMinor: 10000 };
const day = (date: string, dayOfWeek: string, salesMinor: number, staffed = true) => ({
  date,
  dayOfWeek,
  salesMinor,
  transactions: salesMinor === 0 ? 0 : 100,
  shifts: staffed ? [shift] : [],
});

describe("salesByDay over the mock café's four weeks", () => {
  it("covers every day by default and totals only recorded sales", () => {
    expect([report.from, report.to, report.days.length]).toEqual(["2026-10-12", "2026-11-08", 28]);
    expect(report.totalSalesMinor).toBe(3_030_600);
    // Four closed Mondays and the Sunday till outage are not trading days.
    expect(report.tradingDays).toBe(23);
    expect(report.daysMissingSales).toBe(1);
    // £30,306 over 23 days is £1,317.652..., rounded to whole pence.
    expect(report.averageDailySalesMinor).toBe(131_765);
    expect(report.averageTicketMinor).toBe(Math.round(3_030_600 / report.totalTransactions));
    expect(report.bestDay).toEqual({ date: "2026-10-31", dayOfWeek: "Saturday", salesMinor: 196_000 });
  });

  it("compares a day with the same weekday a week earlier, in pence and as a fraction", () => {
    const saturday = dayOn("2026-11-07");
    expect(saturday.salesMinor).toBe(187_300);
    expect(saturday.transactions).toBe(212);
    // 187,300p over 212 orders is 883.49p.
    expect(saturday.averageTicketMinor).toBe(883);
    expect(saturday.lastWeek).toEqual({
      date: "2026-10-31",
      previousSalesMinor: 196_000,
      changeMinor: -8_700,
      changePct: -8_700 / 196_000,
    });
  });

  it("gives the first week no comparison, since nothing comes before it", () => {
    const tuesday = dayOn("2026-10-13");
    expect(tuesday.salesMinor).toBe(91_200);
    expect(tuesday.lastWeek).toBeNull();
    expect(report.weeks[0]).toMatchObject({ vsPreviousWeek: null, likeForLike: null });
  });

  it("marks a closed Monday as closed, with no average ticket and no comparison", () => {
    const monday = dayOn("2026-10-19");
    expect(monday).toMatchObject({ closed: true, salesMissing: false, salesMinor: 0, transactions: 0, averageTicketMinor: null, lastWeek: null });
  });

  it("reports the outage Sunday as missing, not as a zero, and compares nothing against it", () => {
    const sunday = dayOn("2026-11-08");
    expect(sunday).toMatchObject({ closed: false, salesMissing: true, salesMinor: null, transactions: null, averageTicketMinor: null, lastWeek: null });
    expect(sunday.note).toMatch(/till/i);
  });

  it("totals each week and compares whole weeks only when both are complete with no missing sales", () => {
    expect(report.weeks.map((w) => w.salesMinor)).toEqual([738_900, 740_200, 913_600, 637_900]);
    expect(report.weeks.map((w) => w.vsPreviousWeek?.changeMinor ?? null)).toEqual([null, 1_300, 173_400, null]);
    expect(report.weeks[2]!.vsPreviousWeek!.changePct).toBeCloseTo(173_400 / 740_200, 10);
    expect(report.weeks[3]).toMatchObject({ weekStart: "2026-11-02", tradingDays: 5, daysMissingSales: 1, complete: true });
  });

  it("compares a week with an outage like for like, over the weekdays both weeks recorded", () => {
    // Tuesday to Saturday: £6,379 against £7,471 in half-term.
    expect(report.weeks[3]!.likeForLike).toEqual({
      weekdays: ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      salesMinor: 637_900,
      previousSalesMinor: 747_100,
      changeMinor: -109_200,
      changePct: -109_200 / 747_100,
    });
    // With every day recorded in both weeks, like for like is the whole week.
    expect(report.weeks[1]!.likeForLike).toMatchObject({ changeMinor: 1_300, previousSalesMinor: 738_900 });
  });
});

describe("salesByDay ranges", () => {
  it("filters to the range but still compares a day with the week before it", () => {
    const week = salesByDay(shifts, { from: "2026-11-03", to: "2026-11-07" });
    expect(week.days.map((d) => d.date)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]);
    expect(week.totalSalesMinor).toBe(637_900);
    expect(week.days[0]!.lastWeek?.previousSalesMinor).toBe(126_400);
    // A partial week is never compared as a week, and the week before is out of range.
    expect(week.weeks).toEqual([expect.objectContaining({ complete: false, vsPreviousWeek: null, likeForLike: null })]);
  });

  it("accepts an open-ended range on either side", () => {
    expect(salesByDay(shifts, { from: "2026-11-02" }).days).toHaveLength(7);
    expect(salesByDay(shifts, { to: "2026-10-18" }).days).toHaveLength(7);
  });

  it("refuses a reversed range and one that misses the data, naming what the data covers", () => {
    expect(() => salesByDay(shifts, { from: "2026-11-08", to: "2026-11-01" })).toThrow(/after/);
    expect(() => salesByDay(shifts, { from: "2026-12-01", to: "2026-12-07" })).toThrow(/data covers 2026-10-12 to 2026-11-08/);
  });

  it("validates model input strictly", () => {
    expect(() => SalesRangeSchema.parse({ from: "yesterday" })).toThrow(/Invalid date/);
    expect(() => SalesRangeSchema.parse({ from: "2026-11-31" })).toThrow(/Invalid date/);
    expect(() => SalesRangeSchema.parse({ to: "2026-11-08", week: 3 })).toThrow(/Unrecognized key/);
  });

  it("has no averages or best day for a range with no recorded sales", () => {
    const closed = ShiftsSchema.parse({ currency: "GBP", days: [day("2026-11-02", "Monday", 0, false)] });
    const empty = salesByDay(closed);
    expect(empty).toMatchObject({ tradingDays: 0, averageDailySalesMinor: null, averageTicketMinor: null, bestDay: null });
  });

  it("has no like-for-like week when no weekday has sales in both weeks", () => {
    const record = ShiftsSchema.parse({
      currency: "GBP",
      days: [day("2026-11-03", "Tuesday", 1000), day("2026-11-11", "Wednesday", 1000)],
    });
    expect(salesByDay(record).weeks[1]!.likeForLike).toBeNull();
  });

  it("does not compare a day against a missing-sales day a week earlier", () => {
    const record = ShiftsSchema.parse({
      currency: "GBP",
      days: [day("2026-11-01", "Sunday", 0), day("2026-11-08", "Sunday", 150000)],
    });
    expect(salesByDay(record).days[1]!.lastWeek).toBeNull();
  });
});

describe("the daily record schema", () => {
  it("refuses a note with digits, so a note can never vouch for a figure", () => {
    const withNote = (note: string) =>
      ShiftsSchema.safeParse({ currency: "GBP", days: [{ ...day("2026-11-03", "Tuesday", 1000), note }] }).success;
    expect(withNote("Heavy rain all day.")).toBe(true);
    expect(withNote("Took £5 less than usual.")).toBe(false);
    // Grounding reads digits in every script, so the note check does too.
    expect(withNote("Took ١٢٠٠ on the card reader.")).toBe(false);
    expect(withNote("Took £１,２００ on the card reader.")).toBe(false);
  });

  it("refuses sales without transactions, and days out of date order", () => {
    const tuesday = { ...day("2026-11-03", "Tuesday", 1000), transactions: 0 };
    expect(() => ShiftsSchema.parse({ currency: "GBP", days: [tuesday] })).toThrow(/both be recorded/);
    const out = [day("2026-11-04", "Wednesday", 1000), day("2026-11-03", "Tuesday", 1000)];
    expect(() => ShiftsSchema.parse({ currency: "GBP", days: out })).toThrow(/date order/);
  });

  it("takes the latest week from Monday to the last recorded day", () => {
    const week = latestWeek(shifts);
    expect([week.from, week.to, week.days.length]).toEqual(["2026-11-02", "2026-11-08", 7]);
    const midweek = ShiftsSchema.parse({ currency: "GBP", days: [day("2026-11-03", "Tuesday", 1000), day("2026-11-11", "Wednesday", 1000)] });
    expect(latestWeek(midweek)).toMatchObject({ from: "2026-11-09", to: "2026-11-11" });
  });
});

describe("daysInclusive", () => {
  it("counts both ends, across a month end and the October clock change", () => {
    expect(daysInclusive("2026-11-08", "2026-11-08")).toBe(1);
    expect(daysInclusive("2026-10-12", "2026-11-08")).toBe(28);
  });
});
