import { type Currency, formatMoney, money } from "../domain/money.js";

export type ActionKind = "price_change" | "review_reply";

export interface PriceChangeParams {
  readonly sku: string;
  readonly currentPriceMinor: number;
  readonly proposedPriceMinor: number;
  readonly currency: Currency;
}

export interface ReviewReplyParams {
  readonly reviewId: string;
  readonly replyText: string;
}

export type ActionSpec =
  | { readonly kind: "price_change"; readonly params: PriceChangeParams }
  | { readonly kind: "review_reply"; readonly params: ReviewReplyParams };

export type ActionStatus = "pending" | "approved" | "rejected" | "executed";

export interface ProposedAction {
  readonly id: string;
  readonly spec: ActionSpec;
  readonly summary: string;
  readonly proposedAt: string; // ISO-8601
}

export interface ExecutionResult {
  readonly actionId: string;
  readonly kind: ActionKind;
  readonly outcome: string;
  readonly executedAt: string; // ISO-8601
}

// What the owner reads as a reply's title: the reviewer's name when the caller
// knows it, the review id otherwise.
export function replyTitle(params: ReviewReplyParams, reviewer?: string): string {
  return reviewer ? `Reply to ${reviewer}'s review` : `Reply to review ${params.reviewId}`;
}

// `displayName` is the menu's name for a price change ("Avocado Toast") or the
// reviewer's name for a reply ("Megan"), shown to the owner instead of the sku
// or review id when the caller knows it.
export function summarizeAction(spec: ActionSpec, displayName?: string): string {
  switch (spec.kind) {
    case "price_change": {
      const from = formatMoney(money(spec.params.currentPriceMinor, spec.params.currency));
      const to = formatMoney(money(spec.params.proposedPriceMinor, spec.params.currency));
      return `Change ${displayName ?? spec.params.sku} price from ${from} to ${to}`;
    }
    case "review_reply":
      return `${replyTitle(spec.params, displayName)}: "${preview(spec.params.replyText)}"`;
  }
}

// At most 60 characters, cut at a space when one falls late enough, and on
// code points so a surrogate pair is never split.
function preview(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= 60) return text;
  const cut = chars.slice(0, 57).join("");
  const space = cut.lastIndexOf(" ");
  const kept = space >= 30 ? cut.slice(0, space).replace(/[\s,;:]+$/u, "") : cut;
  return `${kept}...`;
}
