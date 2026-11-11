import { describe, expect, it } from "vitest";

import { ShiftsSchema } from "../../lib/tools/days.js";
import { salesByDay } from "../../lib/tools/sales.js";
import { narrateBestDay, narrateLastWeek } from "../../lib/web/demo-narrate-sales.js";

const shift = { staff: "A", slot: "morning", costMinor: 10000 };
const day = (date: string, dayOfWeek: string, salesMinor: number, staffed = true) => ({
  date,
  dayOfWeek,
  salesMinor,
  transactions: salesMinor === 0 ? 0 : 100,
  shifts: staffed ? [shift] : [],
});
const week = (monday: number, salesMinor: number) =>
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((name, i) =>
    day(`2026-11-${String(monday + i).padStart(2, "0")}`, name, salesMinor),
  );
const report = (days: unknown[]) => JSON.stringify(salesByDay(ShiftsSchema.parse({ currency: "GBP", days })));

describe("narrateLastWeek", () => {
  it("compares two complete weeks with no missing sales", () => {
    expect(narrateLastWeek(report([...week(2, 100000), ...week(9, 110000)]))).toBe(
      "The week of Monday 9 November took £7,700.00 over 7 trading days. That is up 10% (£700.00) on the week before.",
    );
  });

  it("names no week before the first", () => {
    expect(narrateLastWeek(report(week(2, 100000)))).toBe("The week of Monday 2 November took £7,000.00 over 7 trading days.");
  });

  it("says level when a change rounds to nothing", () => {
    expect(narrateLastWeek(report([...week(2, 100000), ...week(9, 100010)]))).toMatch(/That is level with the week before\.$/);
  });

  it("compares a partial week like for like rather than as a whole week", () => {
    const days = [...week(2, 100000), day("2026-11-09", "Monday", 100000)];
    expect(narrateLastWeek(report(days))).toBe(
      "The week of Monday 9 November took £1,000.00 over 1 trading day. It is not a full week, so comparing like for like on Monday: level with the same days the week before.",
    );
  });
});

describe("narrateBestDay", () => {
  it("names the best day of the latest week", () => {
    const days = [...week(2, 100000), day("2026-11-09", "Monday", 90000), day("2026-11-10", "Tuesday", 120000)];
    expect(narrateBestDay(report(days))).toBe("Your best day between 9 November and 10 November was Tuesday 10 November, at £1,200.00.");
  });

  it("says so when nothing was recorded", () => {
    expect(narrateBestDay(report([day("2026-11-02", "Monday", 0, false)]))).toBe("There are no recorded sales in that period.");
  });
});
