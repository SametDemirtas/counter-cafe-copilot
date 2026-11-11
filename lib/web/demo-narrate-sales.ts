// Turns a sales_by_day result into the offline demo's answer. Every figure
// comes from the tool result.

import { percentOf } from "../domain/percent.js";
import { type SalesChange, type SalesReport } from "../tools/sales.js";
import { gbp, list, longDate } from "./demo-text.js";

function change({ changeMinor, changePct }: SalesChange, against: string): string {
  const rounded = percentOf(Math.abs(changePct));
  if (rounded === 0) return `level with ${against}`;
  return `${changePct > 0 ? "up" : "down"} ${rounded}% (${gbp(Math.abs(changeMinor))}) on ${against}`;
}

// The latest week against the one before, like for like when a day is missing
// or the week is not over.
export function narrateLastWeek(content: string): string {
  const report = JSON.parse(content) as SalesReport;
  const week = report.weeks.at(-1);
  if (!week) return "There are no recorded sales in your data yet.";
  const days = `${week.tradingDays} trading ${week.tradingDays === 1 ? "day" : "days"}`;
  const text = `The week of Monday ${longDate(week.weekStart)} took ${gbp(week.salesMinor)} over ${days}.`;
  if (week.vsPreviousWeek) return `${text} That is ${change(week.vsPreviousWeek, "the week before")}.`;
  if (!week.likeForLike) return text;
  const { weekdays, salesMinor } = week.likeForLike;
  const why = week.daysMissingSales > 0 ? "A day's sales were not recorded, so" : "It is not a full week, so";
  // The like-for-like days are often the whole week; then its total is already stated.
  const total = salesMinor === week.salesMinor ? "" : `${gbp(salesMinor)}, `;
  return `${text} ${why} comparing like for like on ${list(weekdays)}: ${total}${change(week.likeForLike, "the same days the week before")}.`;
}

// The best day in the latest week.
export function narrateBestDay(content: string): string {
  const report = JSON.parse(content) as SalesReport;
  const from = report.weeks.at(-1)?.weekStart ?? report.from;
  const days = report.days.filter((d) => d.date >= from && d.salesMinor);
  const best = days.reduce<(typeof days)[number] | undefined>((top, d) => (!top || d.salesMinor! > top.salesMinor! ? d : top), undefined);
  if (!best) return "There are no recorded sales in that period.";
  return `Your best day between ${longDate(from)} and ${longDate(report.to)} was ${best.dayOfWeek} ${longDate(best.date)}, at ${gbp(best.salesMinor!)}.`;
}
