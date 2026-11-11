// Morning brief, computed deterministically so the headline is never a model's guess.

import { formatMinor } from "../domain/money.js";
import { percentOf } from "../domain/percent.js";
import { type InvoiceLineVariance, invoiceSummary } from "../tools/invoice.js";
import { daysInclusive, latestWeek } from "../tools/days.js";
import { MENU_CATEGORY_NAMES, type MenuClassification, classifyMenu } from "../tools/menu.js";
import { type SalesDay, salesByDay } from "../tools/sales.js";
import { worstStaffDay, worstTradingDay } from "../tools/staff.js";
import { type ActionSpec } from "../safety/index.js";
import { type AgentContext } from "./context.js";
import { subject } from "./text.js";

export interface MorningBrief {
  // The latest day with recorded sales against the same weekday a week earlier.
  readonly sales?: string;
  readonly headline: string;
  // Up to three further findings, in priority order, after the headline.
  readonly more: readonly string[];
  // Only when a finding the brief shows suggests a change.
  readonly suggestedAction?: ActionSpec;
}

interface Finding {
  readonly text: string;
  // Money at stake per week, in minor units; see morningBrief for how each
  // finding derives it.
  readonly weeklyMinor: number;
  readonly suggestedAction?: ActionSpec;
}

// A day's staff cost at or above this share of its sales is worth a line.
// Small cafés usually run at 25% to 33%, so 33% is the line where one shift is
// worth a second look.
const STAFF_RATIO_ALERT = 0.33;

// The rise suggested for the popular item furthest below its category's margin.
// Only a suggestion: proposing it still leaves the owner to approve it in the queue.
const SUGGESTED_PRICE_RISE = 0.1;

const MORE_LINES = 3;

// "Tomatoes (kg)" as "tomatoes".
const itemName = (item: string) => item.replace(/\s*\([^)]*\)\s*$/, "").toLowerCase();

// "31 October", from an ISO date.
const longDate = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countWord = (n: number) => COUNT_WORDS[n] ?? String(n);

// "17.8% above your agreed price, £3.20 over", without the item.
function overDetail(line: InvoiceLineVariance, over: string): string {
  return line.variancePct > 0
    ? `${percentOf(line.variancePct, 1)}% above your agreed price, ${over} over`
    : `being charged for the first time, ${over}`;
}

// Leads with what the whole invoice overbills, then names the biggest line.
// Ranked on money, not percent, so a newly charged item (agreed price 0) still counts.
function overchargeFinding(ctx: AgentContext): Finding | undefined {
  const { lines, totalOverchargeMinor: totalMinor } = invoiceSummary(ctx.invoice);
  const flagged = lines.filter((l) => l.flagged).sort((a, b) => b.overchargeMinor - a.overchargeMinor);
  const worst = flagged[0];
  if (!worst) return undefined;
  const gbp = (minor: number) => formatMinor(minor, ctx.currency);
  if (flagged.length === 1) {
    return {
      weeklyMinor: totalMinor,
      text: `${subject(worst.item)} ${overDetail(worst, gbp(worst.overchargeMinor))} on this invoice. Worth a word with the supplier.`,
    };
  }
  return {
    weeklyMinor: totalMinor,
    text: `Your latest invoice is ${gbp(totalMinor)} over the agreed prices across ${countWord(flagged.length)} lines. The biggest is ${itemName(worst.item)}: ${overDetail(worst, gbp(worst.overchargeMinor))}. Worth a word with the supplier.`,
  };
}

// Staff cost booked on a day the till recorded nothing. A data problem, not a
// loss: until the till is checked, no figure for that day can be trusted.
function outageIssue(ctx: AgentContext): string | undefined {
  const outage = worstStaffDay(latestWeek(ctx.shifts));
  if (!outage?.salesMissing) return undefined;
  return `Data issue: ${outage.dayOfWeek} booked ${formatMinor(outage.staffCostMinor, ctx.currency)} of staff cost with no recorded sales. Check the till and the rota.`;
}

// The trading day with the highest staff share in the latest week. The rota
// repeats weekly, so its cost above STAFF_RATIO_ALERT is the weekly figure.
function heavyDayFinding(ctx: AgentContext): Finding | undefined {
  const heavy = worstTradingDay(latestWeek(ctx.shifts));
  if (!heavy || heavy.ratioPct < STAFF_RATIO_ALERT) return undefined;
  return {
    weeklyMinor: Math.max(0, heavy.staffCostMinor - Math.round(heavy.salesMinor * STAFF_RATIO_ALERT)),
    text: `${heavy.dayOfWeek} staff cost is ${percentOf(heavy.ratioPct)}% of sales, the highest share of any trading day. A shift there is the clearest saving.`,
  };
}

// The weeks the data covers: the daily record, closed days and outages
// included, widened to any order dated outside it. Orders alone would miss a
// closed first or last day and overstate a weekly figure.
function weeksCovered(ctx: AgentContext): number {
  const dates = [ctx.shifts.days[0].date, ctx.shifts.days.at(-1)!.date, ...ctx.orders.map((o) => o.placedAt.slice(0, 10))].sort();
  return daysInclusive(dates[0]!, dates.at(-1)!) / 7;
}

// The popular item furthest below its category's average margin, in pence; on a
// tie, the one that sells more. Its weekly figure is that shortfall on each
// unit sold, spread over the weeks the data covers.
function menuFinding(ctx: AgentContext): Finding | undefined {
  const menu = classifyMenu(ctx.menu, ctx.orders);
  const averages = new Map(menu.categories.map((c) => [c.category, c.averageContributionMarginMinor ?? 0]));
  const shortfall = (item: MenuClassification) => averages.get(item.category)! - item.contributionMarginMinor;
  const item = menu.items
    .filter((c) => c.label === "price_up")
    .sort((a, b) => shortfall(b) - shortfall(a) || b.unitsSold - a.unitsSold)[0];
  if (!item) return undefined;
  const gbp = (minor: number) => formatMinor(minor, ctx.currency);
  return {
    weeklyMinor: Math.round((shortfall(item) * item.unitsSold) / weeksCovered(ctx)),
    text: `${item.name} sells well but earns ${gbp(item.contributionMarginMinor)} an item after food cost, below the ${gbp(averages.get(item.category)!)} average for ${MENU_CATEGORY_NAMES[item.category]}. Raising the price would help.`,
    suggestedAction: {
      kind: "price_change",
      params: {
        sku: item.sku,
        currentPriceMinor: item.priceMinor,
        proposedPriceMinor: Math.round(item.priceMinor * (1 + SUGGESTED_PRICE_RISE)),
        currency: ctx.currency,
      },
    },
  };
}

function comparison(day: SalesDay, ctx: AgentContext): string {
  if (!day.lastWeek) return "";
  const { changePct, previousSalesMinor } = day.lastWeek;
  const before = `the ${day.dayOfWeek} before (${formatMinor(previousSalesMinor, ctx.currency)})`;
  const rounded = percentOf(Math.abs(changePct));
  if (rounded === 0) return `, about level with ${before}`;
  return `, ${changePct > 0 ? "up" : "down"} ${rounded}% on ${before}`;
}

function salesLine(ctx: AgentContext): string | undefined {
  const report = salesByDay(ctx.shifts);
  const latest = [...report.days].reverse().find((d) => d.salesMinor);
  if (!latest?.salesMinor) return undefined;
  let line = `${latest.dayOfWeek}'s sales were ${formatMinor(latest.salesMinor, ctx.currency)}${comparison(latest, ctx)}.`;
  // The manager's own note on the day compared against often says why, such as
  // a holiday. Quoted as written, in quotation marks, so it reads as the
  // manager's words and not as a figure the brief worked out.
  const before = latest.lastWeek && report.days.find((d) => d.date === latest.lastWeek!.date);
  if (before?.note) line += ` The manager's note for ${before.dayOfWeek} ${longDate(before.date)}: "${before.note}"`;
  // Say why the brief skipped a later day, rather than leave it unexplained.
  const missing = report.days.filter((d) => d.salesMissing && d.date > latest.date);
  for (const day of missing) line += ` ${day.dayOfWeek}'s sales were not recorded.`;
  return line;
}

// Opens with sales, then data problems (a till outage), which come first
// because they make other numbers doubtful. Then the money findings, ranked by
// money at stake per week:
// - an overcharge: what the whole invoice overbills. The invoice carries no
//   period, so it is taken as one week's delivery, the usual cycle for a small
//   café's produce order;
// - the heaviest trading day: its staff cost above STAFF_RATIO_ALERT, which
//   recurs once a week with the rota;
// - the menu item: its shortfall on its category's average margin, times the
//   units sold, divided by the weeks the data covers.
// On a tie the order stays overcharge, heavy day, menu.
export function morningBrief(ctx: AgentContext): MorningBrief {
  const sales = salesLine(ctx);
  const issues = [outageIssue(ctx)].filter((t): t is string => t !== undefined);
  const findings = [overchargeFinding(ctx), heavyDayFinding(ctx), menuFinding(ctx)]
    .filter((f): f is Finding => f !== undefined)
    .sort((a, b) => b.weeklyMinor - a.weeklyMinor);
  const shown = findings.slice(0, Math.max(0, 1 + MORE_LINES - issues.length));
  const [first, ...rest] = [...issues, ...shown.map((f) => f.text)];
  const suggestedAction = shown.find((f) => f.suggestedAction)?.suggestedAction;
  return {
    ...(sales ? { sales } : {}),
    headline: first ?? "Nothing urgent this morning. The numbers look steady.",
    more: rest,
    ...(suggestedAction ? { suggestedAction } : {}),
  };
}
