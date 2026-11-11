// What a proposal may ask for at all, checked by the gate for every caller.
// The agent's tools are one caller; a script holding the gate is another.

import { type Currency, formatMoney, money } from "../domain/money.js";
import { type AutopilotRule } from "./autopilot.js";
import { type ActionRecord } from "./store.js";
import { type ActionSpec, type ActionStatus, type PriceChangeParams, type ReviewReplyParams } from "./types.js";

export interface CatalogItem {
  readonly name: string;
  readonly priceMinor: number;
  readonly foodCostMinor: number;
}

export interface CatalogReview {
  // The reviewer's name, shown to the owner instead of the review id.
  readonly author: string;
  readonly rating: number;
  // Empty for a rating with no text. Read by autopilot's classifier and tripwire.
  readonly text: string;
}

// The live menu and reviews, injected so lib/safety never imports data.
export interface ActionCatalog {
  readonly currency: Currency;
  menuItem(sku: string): CatalogItem | undefined;
  review(id: string): CatalogReview | undefined;
  // Every person the café knows by name (reviewers, staff). An autopilot reply
  // may name the reviewer and nobody else on this list.
  knownNames?(): readonly string[];
}

// What the policy may read of past proposals; the store satisfies it, and the
// policy never writes.
export interface ProposalHistory {
  entries(): readonly ActionRecord[];
}

export const MAX_PRICE_CHANGE = 0.5;
export const MAX_REPLY_LENGTH = 2000;

// The rules this file checks; autopilot.ts declares the ones it raises.
export type ProposalRule =
  | "unknown_sku"
  | "wrong_currency"
  | "stale_price"
  | "invalid_price"
  | "no_change"
  | "below_food_cost"
  | "max_change"
  | "unknown_review"
  | "already_replied"
  | "already_open"
  | "empty_reply"
  | "reply_too_long"
  | "invalid_review";

export type PolicyRule = ProposalRule | AutopilotRule;

export class PolicyRejection extends Error {
  constructor(
    readonly rule: PolicyRule,
    message: string,
    // Typed figures behind the message (`*Minor` money, `*Pct` fractions), for a
    // caller that must tell a real figure from text.
    readonly figures: Readonly<Record<string, number>> = {},
  ) {
    super(message);
    this.name = "PolicyRejection";
  }
}

export function targetOf(spec: ActionSpec): string {
  return spec.kind === "price_change" ? `price:${spec.params.sku}` : `reply:${spec.params.reviewId}`;
}

// Approved but not yet executed still counts as open: it may be retried.
const isOpen = (status: ActionStatus) => status === "pending" || status === "approved";

// The proposal still open for this target ("price:latte", "reply:rev-2"), if any.
export function openProposalFor(history: ProposalHistory, target: string): ActionRecord | undefined {
  return history.entries().find((r) => isOpen(r.status) && targetOf(r.proposal.spec) === target);
}

export class ApprovalPolicy {
  constructor(
    private readonly catalog: ActionCatalog,
    private readonly history: ProposalHistory,
  ) {}

  // Throws a PolicyRejection; the messages are written to be shown to the model.
  check(spec: ActionSpec): void {
    switch (spec.kind) {
      case "price_change":
        this.checkPrice(spec.params);
        break;
      case "review_reply":
        this.checkReply(spec.params);
        this.checkNotReplied(spec);
        break;
      default: {
        // A new action kind must get its own rules before it can be proposed.
        const unknown: never = spec;
        throw new Error(`no approval policy for ${String((unknown as { kind: unknown }).kind)}`);
      }
    }
    this.checkNoneOpen(spec);
  }

  // One reply per review, ever: otherwise autopilot could post to the same
  // review again and again.
  private checkNotReplied(spec: Extract<ActionSpec, { kind: "review_reply" }>): void {
    const target = targetOf(spec);
    const replied = this.history
      .entries()
      .some((r) => (r.status === "approved" || r.status === "executed") && targetOf(r.proposal.spec) === target);
    if (replied) {
      throw new PolicyRejection("already_replied", "this review already has a reply; it gets only one");
    }
  }

  // One open proposal per target, so the owner never faces two competing
  // prices for the same item or two replies to the same review.
  private checkNoneOpen(spec: ActionSpec): void {
    const open = openProposalFor(this.history, targetOf(spec));
    if (!open) return;
    const openSpec = open.proposal.spec;
    const figures =
      openSpec.kind === "price_change"
        ? { openCurrentPriceMinor: openSpec.params.currentPriceMinor, openProposedPriceMinor: openSpec.params.proposedPriceMinor }
        : {};
    if (open.status !== "pending") {
      throw new PolicyRejection("already_open", `A proposal for this is already approved and not yet sent: ${open.proposal.summary}`, figures);
    }
    const different = openSpec.kind === "price_change" ? "a different price" : "a different reply";
    throw new PolicyRejection(
      "already_open",
      `A proposal for this is already waiting for approval: ${open.proposal.summary}. Reject it first if you want ${different}.`,
      figures,
    );
  }

  private checkPrice(p: PriceChangeParams): void {
    const item = this.catalog.menuItem(p.sku);
    if (!item) throw new PolicyRejection("unknown_sku", `No menu item with sku "${p.sku}"`);
    const { currency } = this.catalog;
    if (p.currency !== currency) {
      throw new PolicyRejection("wrong_currency", `${item.name} is priced in ${currency}, not ${String(p.currency)}`);
    }
    if (!Number.isSafeInteger(p.proposedPriceMinor) || p.proposedPriceMinor <= 0) {
      throw new PolicyRejection("invalid_price", `${String(p.proposedPriceMinor)} is not a valid price in minor units`);
    }
    const fmt = (minor: number) => formatMoney(money(minor, currency));
    // The owner approves "from X to Y", so X must be what the till charges now.
    if (p.currentPriceMinor !== item.priceMinor) {
      throw new PolicyRejection(
        "stale_price",
        `${item.name} is ${fmt(item.priceMinor)} now, which is not the current price in the proposal`,
      );
    }
    if (p.proposedPriceMinor === item.priceMinor) {
      throw new PolicyRejection("no_change", `${item.name} is already at that price`);
    }
    // Stops a misled model from putting a dangerous card in front of a tired owner.
    if (p.proposedPriceMinor <= item.foodCostMinor) {
      throw new PolicyRejection(
        "below_food_cost",
        `${item.name} would sell at or below its food cost of ${fmt(item.foodCostMinor)}`,
      );
    }
    if (Math.abs(p.proposedPriceMinor - item.priceMinor) > item.priceMinor * MAX_PRICE_CHANGE) {
      throw new PolicyRejection(
        "max_change",
        `a change of more than ${MAX_PRICE_CHANGE * 100}% to ${item.name} is outside what one proposal may do`,
      );
    }
  }

  private checkReply(p: ReviewReplyParams): void {
    if (!this.catalog.review(p.reviewId)) throw new PolicyRejection("unknown_review", `No review with id "${p.reviewId}"`);
    if (typeof p.replyText !== "string" || p.replyText.trim().length === 0) {
      throw new PolicyRejection("empty_reply", "a reply needs some text");
    }
    if (p.replyText.length > MAX_REPLY_LENGTH) {
      throw new PolicyRejection("reply_too_long", `a reply may be at most ${MAX_REPLY_LENGTH} characters`);
    }
  }
}
