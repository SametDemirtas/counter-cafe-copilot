// Templates that turn a tool result into the offline demo's answer. Every
// figure it states comes from the tool result. Keyed by tool, so the answer
// never depends on how a question was worded.

import { percentOf } from "../domain/percent.js";
import { type LlmBlock } from "../agent/llm.js";
import { MENU_CATEGORY_NAMES, type MenuEngineering, type MenuLabel } from "../tools/menu.js";
import { type ReviewSummary } from "../tools/reviews.js";
import { narrateLastWeek } from "./demo-narrate-sales.js";
import { gbp, list, plural, subject } from "./demo-text.js";

export type ToolResultBlock = Extract<LlmBlock, { type: "tool_result" }>;
export type Narrator = (content: string) => string;

const NARRATORS: Readonly<Record<string, Narrator>> = {
  invoice_variance: narrateInvoice,
  classify_menu: narrateMenu,
  staff_cost: narrateStaff,
  sales_by_day: narrateLastWeek,
  list_reviews: narrateReviews,
};

const PROPOSAL_TOOLS: ReadonlySet<string> = new Set(["propose_price_change", "propose_review_reply"]);

// `narrator` is the scripted prompt's own view of the result, when it has one.
export function narrate(result: ToolResultBlock, toolName: string, narrator?: Narrator): string {
  const proposal = PROPOSAL_TOOLS.has(toolName);
  if (result.isError) {
    return proposal
      ? `I couldn't prepare that: ${reason(result)}. Nothing has been changed.`
      : `I couldn't complete that: ${reason(result)}. Nothing has been changed.`;
  }
  const chosen = narrator ?? (proposal ? narrateProposal : Object.hasOwn(NARRATORS, toolName) ? NARRATORS[toolName] : undefined);
  try {
    if (chosen) return chosen(result.content);
  } catch {
    // An unexpected shape falls through to the generic line.
  }
  return proposal ? "I've prepared a proposal for your approval. Nothing changes until you approve it." : "Here is what I found in your data.";
}

// Without its closing full stop, since the answer carries on after it.
function reason(result: ToolResultBlock): string {
  return result.content.replace(/^Error:\s*/, "").replace(/[.\s]+$/, "");
}

interface InvoiceResult {
  readonly lines: readonly {
    readonly item: string;
    readonly variancePct: number;
    readonly overchargeMinor: number;
    readonly flagged: boolean;
  }[];
  readonly totalOverchargeMinor: number;
}

function narrateInvoice(content: string): string {
  const { lines, totalOverchargeMinor } = JSON.parse(content) as InvoiceResult;
  const flagged = lines.filter((l) => l.flagged && l.overchargeMinor > 0).sort((a, b) => b.overchargeMinor - a.overchargeMinor);
  if (flagged.length === 0) return "Your latest invoice matches the prices you agreed. Nothing to query.";
  const worst = flagged[0]!;
  const pct = percentOf(worst.variancePct, 1);
  const over = gbp(worst.overchargeMinor);
  const extra = flagged.length > 1 ? ` ${flagged.length} lines are over in all, ${gbp(totalOverchargeMinor)} overpaid in total.` : "";
  return `${subject(worst.item)} ${pct}% above your agreed price, ${over} over on this invoice.${extra} Worth a word with the supplier.`;
}

function narrateMenu(content: string): string {
  const { items, categories } = JSON.parse(content) as MenuEngineering;
  const sold = categories.filter((c) => c.averageContributionMarginMinor !== null);
  if (sold.length === 0) return "Nothing has sold yet, so I can't rank the menu.";
  const averages = sold.map((c) => `${MENU_CATEGORY_NAMES[c.category]} ${gbp(c.averageContributionMarginMinor!)}`);
  const names = (label: MenuLabel) => items.filter((i) => i.label === label).map((i) => i.name);
  const parts: string[] = [];
  const stars = names("star");
  const priceUp = names("price_up");
  const promote = names("promote");
  const keep = names("keep");
  const retire = items.filter((i) => i.label === "retire");
  if (stars.length) parts.push(`${list(stars)} ${plural(stars, "sells", "sell")} well and ${plural(stars, "earns", "earn")} at or near ${plural(stars, "its", "their")} category's average: ${plural(stars, "a star", "your stars")}`);
  if (priceUp.length) parts.push(`${list(priceUp)} ${plural(priceUp, "sells", "sell")} well but ${plural(priceUp, "earns", "earn")} below average, so ${plural(priceUp, "it is a candidate", "they are candidates")} for a price rise`);
  if (promote.length) parts.push(`${list(promote)} ${plural(promote, "earns", "earn")} well but ${plural(promote, "sells", "sell")} little: worth promoting`);
  if (keep.length) parts.push(`${list(keep)} ${plural(keep, "sells", "sell")} little, but every ingredient is shared with other items, so offering ${plural(keep, "it", "them")} costs nothing extra: keep ${plural(keep, "it", "them")}`);
  if (retire.length) {
    const saves = retire.map((i) => `${list(i.dedicatedIngredients.map((ing) => ing.replace(/_/g, " ")))} only for the ${i.name}`);
    parts.push(`${list(retire.map((i) => i.name))} ${plural(retire, "sells", "sell")} little, ${plural(retire, "earns", "earn")} below average and ${plural(retire, "needs its", "need their")} own stock (${saves.join("; ")}): ${plural(retire, "a candidate", "candidates")} to retire`);
  }
  // One bullet per verdict, so the answer reads as a list in the page.
  const intro = `Each item is ranked within its category. Average earned per item after food cost: ${list(averages)}.`;
  return [intro, "", ...parts.map((p) => `- ${p}.`)].join("\n");
}

interface StaffResult {
  readonly worst: null | { dayOfWeek: string; ratioPct: number; salesMissing: boolean; staffCostMinor: number };
  readonly worstTradingDay: null | { dayOfWeek: string; ratioPct: number };
}

function narrateStaff(content: string): string {
  const { worst, worstTradingDay } = JSON.parse(content) as StaffResult;
  if (!worst) return "There are no staffing days to compare yet.";
  const heaviest = worstTradingDay
    ? `${worstTradingDay.dayOfWeek} is your heaviest trading day for labour at ${percentOf(worstTradingDay.ratioPct)}% of sales. A shift there is the clearest saving.`
    : "";
  if (worst.salesMissing) {
    const outage = `${worst.dayOfWeek} booked ${gbp(worst.staffCostMinor)} of staff cost with no recorded sales. Check the till and the rota.`;
    return heaviest ? `${outage} ${heaviest}` : outage;
  }
  return heaviest || "No day stands out for staff cost.";
}

function narrateReviews(content: string): string {
  const { reviews, count, averageRating } = JSON.parse(content) as ReviewSummary;
  if (count === 0 || averageRating === null) return "You have no customer reviews yet.";
  // Quoted, so a figure inside a review reads as the customer's, not a fact.
  const lines = reviews.map((r) => `· ${r.author} (${r.rating}★): "${r.text}"`);
  return `You have ${count} reviews, averaging ${averageRating.toFixed(1)}★.\n${lines.join("\n")}`;
}

interface ProposalResult {
  readonly summary: string;
  readonly status?: string;
}

// The tool reports what the gate did: a reply under the owner's autopilot rule
// may already be sent, so "waits for you" is said only when it does.
function narrateProposal(content: string): string {
  const { summary, status } = JSON.parse(content) as ProposalResult;
  if (status === "sent_by_autopilot") return `Autopilot sent this under the rule you switched on: ${summary}.`;
  if (status === "approved_by_autopilot_not_yet_sent") {
    return `Autopilot approved this but it could not be sent: ${summary}. It is in your queue to send yourself or withdraw.`;
  }
  return `I've prepared this for your approval: ${summary}. Nothing changes until you approve it.`;
}

// A reply to `author`'s review, named from the prompt that asked for it rather
// than read back out of the summary, which is cut short.
export function narrateReply(author: string): Narrator {
  return (content) => {
    const { status } = JSON.parse(content) as ProposalResult;
    const review = `${author}'s review`;
    if (status === "sent_by_autopilot") return `Autopilot sent your approved reply to ${review}.`;
    if (status === "approved_by_autopilot_not_yet_sent") {
      return `Autopilot approved your reply to ${review} but could not send it. It is in your approvals to send yourself or withdraw.`;
    }
    return `I've drafted a reply to ${review}. It's in your approvals; nothing is posted until you approve it.`;
  };
}
