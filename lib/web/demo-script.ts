// The offline demo's whole repertoire: a fixed list of prompts, each tied to
// one tool call. The page shows them as buttons and the demo answers only
// these, matched exactly. Reading free-form questions is the real model's job;
// the demo does not try, so it never answers the wrong question.

import { greetingName } from "../safety/index.js";
import { type Review } from "../tools/reviews.js";
import { narrateBestDay, narrateLastWeek } from "./demo-narrate-sales.js";
import { type MenuEngineering } from "../tools/menu.js";
import { type Narrator, narrateReply } from "./demo-narrate.js";
import { gbp, list, plural } from "./demo-text.js";

export interface DemoPrompt {
  readonly question: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  // How to word the tool's result for this prompt, when not the tool's default.
  readonly narrator?: Narrator;
}

export const OFFLINE_ONLY =
  "This offline demo answers only the suggested questions under the box. Set ANTHROPIC_API_KEY and restart the server to ask anything about the café.";

// The four questions the page always suggests, in live mode too.
export const STARTERS: readonly DemoPrompt[] = Object.freeze([
  { question: "How did last week compare with the week before?", tool: "sales_by_day", input: {}, narrator: narrateLastWeek },
  { question: "Is my tomato supplier overcharging me?", tool: "invoice_variance", input: {} },
  { question: "Which items on the menu have a thin margin?", tool: "classify_menu", input: {}, narrator: narrateThinMargins },
  { question: "What are customers saying?", tool: "list_reviews", input: {} },
]);

const MORE: readonly DemoPrompt[] = [
  { question: "What was our best day last week?", tool: "sales_by_day", input: {}, narrator: narrateBestDay },
  { question: "Which day costs me most in staff?", tool: "staff_cost", input: {} },
];

// A reply draft that names the reviewer once, by a plain first name. It never
// repeats the review's words, so nothing a customer wrote reaches the reply.
export function draftReply(review: Review): string {
  const name = greetingName(review.author);
  const to = name ? `, ${name}` : "";
  if (review.rating >= 4) return `Thank you for the lovely review${to}. We're so glad you enjoyed your visit. See you again soon.`;
  return `Thank you for telling us${to}, and we're sorry your visit fell short. If you'd like to tell us more, please ask for the manager next time you're in.`;
}

// Only the items that earn below their category's average, which is what a
// thin margin means here, with the average they fall short of.
export function narrateThinMargins(content: string): string {
  const { items, categories } = JSON.parse(content) as MenuEngineering;
  const thin = items.filter((i) => i.label === "price_up" || i.label === "retire");
  if (thin.length === 0) return "No item earns below its category's average after food cost.";
  const average = new Map(categories.map((c) => [c.category, c.averageContributionMarginMinor]));
  const lines = thin.map((i) => {
    const avg = average.get(i.category);
    const vs = avg === null || avg === undefined ? "" : ` (category average ${gbp(avg)})`;
    const next = i.label === "price_up" ? "it sells well, so it is a candidate for a price rise" : "it also sells little, so it is a candidate to retire";
    return `- ${i.name} earns ${gbp(i.contributionMarginMinor)} per sale after food cost${vs}: ${next}.`;
  });
  const names = thin.map((i) => i.name);
  return [`${list(names)} ${plural(names, "has", "have")} a thin margin, earning below ${plural(names, "its", "their")} category's average.`, "", ...lines].join("\n");
}

export const replyPrompt = (review: Review): string => `Draft a reply to ${review.author}'s review`;

export function demoScript(reviews: readonly Review[]): readonly DemoPrompt[] {
  const replies = reviews.map((r) => ({
    question: replyPrompt(r),
    tool: "propose_review_reply",
    input: { reviewId: r.id, replyText: draftReply(r) },
    narrator: narrateReply(r.author),
  }));
  return Object.freeze([...STARTERS, ...MORE, ...replies]);
}

// Case, spacing, a closing question mark or full stop, and a typographic
// apostrophe (the default on phones) do not matter.
export const promptKey = (text: string): string =>
  text.trim().replace(/[’‘]/g, "'").replace(/\s+/g, " ").replace(/[?.!]+$/, "").toLowerCase();
