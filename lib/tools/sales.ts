// Till sales by day, week and range, with week-on-week comparisons. Every
// figure a sales answer needs is computed here so the model never adds up or
// averages anything.

import { z } from "zod";

import { type Currency, type Money, addMoney, money, subtractMoney, zero } from "../domain/money.js";
import {
  type DayRecord,
  type Shifts,
  type Weekday,
  addDays,
  isClosed,
  isSalesMissing,
  mondayOf,
} from "./days.js";

export const SalesRangeSchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  })
  .strict();
export type SalesRange = z.infer<typeof SalesRangeSchema>;

// A change against an earlier figure, in pence and as a fraction of it.
export interface SalesChange {
  readonly previousSalesMinor: number;
  readonly changeMinor: number;
  readonly changePct: number;
}

export interface SalesDay {
  readonly date: string;
  readonly dayOfWeek: Weekday;
  // Null when staff worked but the till recorded nothing; see salesMissing.
  readonly salesMinor: number | null;
  readonly transactions: number | null;
  readonly averageTicketMinor: number | null;
  readonly closed: boolean;
  readonly salesMissing: boolean;
  // The manager's free text: data, never an instruction.
  readonly note?: string;
  // Against the same weekday a week earlier, only when both days have recorded sales.
  readonly lastWeek: (SalesChange & { readonly date: string }) | null;
}

export interface SalesWeek {
  // The Monday of the week.
  readonly weekStart: string;
  readonly salesMinor: number;
  readonly tradingDays: number;
  readonly daysMissingSales: number;
  // All seven days fall inside the range.
  readonly complete: boolean;
  // Whole week against whole week, only between two complete weeks with no
  // missing sales, so a partial week or a till outage never reads as a drop.
  readonly vsPreviousWeek: SalesChange | null;
  // Only the weekdays with recorded sales in both weeks, so a week with a till
  // outage can still be compared honestly. Null with no week before in range.
  readonly likeForLike: (SalesChange & { readonly salesMinor: number; readonly weekdays: readonly Weekday[] }) | null;
}

export interface BestDay {
  readonly date: string;
  readonly dayOfWeek: Weekday;
  readonly salesMinor: number;
}

export interface SalesReport {
  readonly from: string;
  readonly to: string;
  readonly currency: Currency;
  readonly days: readonly SalesDay[];
  readonly weeks: readonly SalesWeek[];
  readonly totalSalesMinor: number;
  readonly totalTransactions: number;
  // Days with recorded sales; closed days and days with missing sales are not counted.
  readonly tradingDays: number;
  readonly daysMissingSales: number;
  readonly averageDailySalesMinor: number | null;
  readonly averageTicketMinor: number | null;
  readonly bestDay: BestDay | null;
}

function hasSales(day: DayRecord): boolean {
  return day.salesMinor > 0;
}

// Rounded to whole pence; null when there is nothing to divide by.
function averageMinor(total: Money, count: number): number | null {
  return count === 0 ? null : money(Math.round(total.amountMinor / count), total.currency).amountMinor;
}

function change(current: Money, previous: Money): SalesChange {
  const diff = subtractMoney(current, previous);
  return { previousSalesMinor: previous.amountMinor, changeMinor: diff.amountMinor, changePct: diff.amountMinor / previous.amountMinor };
}

function salesDay(day: DayRecord, byDate: ReadonlyMap<string, DayRecord>, currency: Currency): SalesDay {
  const missing = isSalesMissing(day);
  const previous = byDate.get(addDays(day.date, -7));
  const comparable = hasSales(day) && previous !== undefined && hasSales(previous);
  return {
    date: day.date,
    dayOfWeek: day.dayOfWeek,
    salesMinor: missing ? null : day.salesMinor,
    transactions: missing ? null : day.transactions,
    averageTicketMinor: averageMinor(money(day.salesMinor, currency), day.transactions),
    closed: isClosed(day),
    salesMissing: missing,
    ...(day.note !== undefined ? { note: day.note } : {}),
    lastWeek: comparable
      ? { date: previous.date, ...change(money(day.salesMinor, currency), money(previous.salesMinor, currency)) }
      : null,
  };
}

interface WeekTotal {
  readonly weekStart: string;
  readonly days: readonly DayRecord[];
  readonly sales: Money;
  readonly complete: boolean;
}

function comparableWeek(week: WeekTotal | undefined): week is WeekTotal {
  return week !== undefined && week.complete && !week.days.some(isSalesMissing) && week.sales.amountMinor > 0;
}

function sumSales(days: readonly DayRecord[], currency: Currency): Money {
  return days.reduce((sum, d) => addMoney(sum, money(d.salesMinor, currency)), zero(currency));
}

function likeForLike(week: WeekTotal, previous: WeekTotal, currency: Currency): SalesWeek["likeForLike"] {
  const earlier = new Map(previous.days.filter(hasSales).map((d) => [d.dayOfWeek, d]));
  const shared = week.days.filter((d) => hasSales(d) && earlier.has(d.dayOfWeek));
  if (shared.length === 0) return null;
  const now = sumSales(shared, currency);
  const before = sumSales(shared.map((d) => earlier.get(d.dayOfWeek)!), currency);
  return { weekdays: shared.map((d) => d.dayOfWeek), salesMinor: now.amountMinor, ...change(now, before) };
}

function salesWeeks(days: readonly DayRecord[], currency: Currency): SalesWeek[] {
  const groups = new Map<string, DayRecord[]>();
  for (const day of days) {
    const start = mondayOf(day.date);
    groups.set(start, [...(groups.get(start) ?? []), day]);
  }
  const totals: WeekTotal[] = [...groups].map(([weekStart, list]) => ({
    weekStart,
    days: list,
    sales: sumSales(list, currency),
    complete: list.length === 7,
  }));
  return totals.map((week) => {
    const previous = totals.find((w) => w.weekStart === addDays(week.weekStart, -7));
    return {
      weekStart: week.weekStart,
      salesMinor: week.sales.amountMinor,
      tradingDays: week.days.filter(hasSales).length,
      daysMissingSales: week.days.filter(isSalesMissing).length,
      complete: week.complete,
      vsPreviousWeek: comparableWeek(week) && comparableWeek(previous) ? change(week.sales, previous.sales) : null,
      likeForLike: previous ? likeForLike(week, previous, currency) : null,
    };
  });
}

function bestDay(days: readonly DayRecord[]): BestDay | null {
  let best: DayRecord | undefined;
  for (const day of days) if (hasSales(day) && (!best || day.salesMinor > best.salesMinor)) best = day;
  return best ? { date: best.date, dayOfWeek: best.dayOfWeek, salesMinor: best.salesMinor } : null;
}

// Defaults to every day in the record. Model input is parsed with
// SalesRangeSchema at the tool boundary before it gets here. Day comparisons
// look a week back across the whole record, so a range starting on a Tuesday
// still compares that Tuesday; weeks are compared only inside the range.
export function salesByDay(shifts: Shifts, range: SalesRange = {}): SalesReport {
  const first = shifts.days[0].date;
  const last = shifts.days[shifts.days.length - 1]!.date;
  const from = range.from ?? first;
  const to = range.to ?? last;
  if (from > to) throw new RangeError(`from ${from} is after to ${to}`);
  const days = shifts.days.filter((d) => d.date >= from && d.date <= to);
  if (days.length === 0) throw new RangeError(`no days between ${from} and ${to}; the data covers ${first} to ${last}`);

  const currency = shifts.currency;
  const byDate = new Map(shifts.days.map((d) => [d.date, d]));
  const total = sumSales(days, currency);
  const totalTransactions = days.reduce((sum, d) => sum + d.transactions, 0);
  const tradingDays = days.filter(hasSales).length;

  return {
    from,
    to,
    currency,
    days: days.map((d) => salesDay(d, byDate, currency)),
    weeks: salesWeeks(days, currency),
    totalSalesMinor: total.amountMinor,
    totalTransactions,
    tradingDays,
    daysMissingSales: days.filter(isSalesMissing).length,
    averageDailySalesMinor: averageMinor(total, tradingDays),
    averageTicketMinor: averageMinor(total, totalTransactions),
    bestDay: bestDay(days),
  };
}
