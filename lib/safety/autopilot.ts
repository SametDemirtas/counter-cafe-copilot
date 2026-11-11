// Review-reply autopilot: once the owner has approved enough replies by hand,
// they may let reviews at the star ratings they pick be answered without a
// click, with a reply template they wrote for that rating. Whether a given
// review is answered is decided in autopilot-decision.ts; this file holds the
// settings, the templates and the unlock count.

import { isValidApprover } from "./actors.js";
import { AUTOPILOT_UNLOCK_APPROVALS, MAX_RATING, MIN_AUTOPILOT_RATING } from "./autopilot-decision.js";
import { PolicyRejection } from "./policy.js";
import { checkTemplate, templateFailureText } from "./reply-template.js";
import { type ActionRecord, type ActionStore } from "./store.js";

export { AUTOPILOT_ACTOR } from "./actors.js";
export { AUTOPILOT_UNLOCK_APPROVALS, MIN_AUTOPILOT_RATING } from "./autopilot-decision.js";
export const AUTOPILOT_RATINGS: readonly number[] = Object.freeze(
  Array.from({ length: MAX_RATING - MIN_AUTOPILOT_RATING + 1 }, (_, i) => MIN_AUTOPILOT_RATING + i),
);

// The rejections this file raises; PolicyRule includes them.
export type AutopilotRule =
  | "autopilot_locked"
  | "autopilot_rating"
  | "autopilot_no_ratings"
  | "autopilot_no_template"
  | "autopilot_template"
  | "autopilot_template_in_use";

// What the owner's switch sets.
export interface AutopilotSettings {
  readonly enabled: boolean;
  readonly ratings: readonly number[];
}

// The owner's reply template per star rating, keyed "3", "4", "5". A rating
// with no template has no key.
export type ReplyTemplates = Readonly<Record<string, string>>;

// The switch and the templates together: what autopilot runs on, and what the
// audit log records on every change.
export interface AutopilotState extends AutopilotSettings {
  readonly templates: ReplyTemplates;
}

export const AUTOPILOT_OFF: AutopilotState = Object.freeze({ enabled: false, ratings: Object.freeze([]), templates: Object.freeze({}) });

export interface AutopilotStatus extends AutopilotState {
  readonly approvedReplies: number;
  readonly required: number;
  readonly unlocked: boolean;
}

// A reply a human approved and that was actually posted.
export const postedByHand = (r: ActionRecord) =>
  r.proposal.spec.kind === "review_reply" && r.status === "executed" && isValidApprover(r.approvedBy);

// Read from the store every time rather than kept as a counter that could drift.
// One per review, so approving the same reply five times cannot unlock it.
export function humanApprovedReplies(store: ActionStore): number {
  const reviews = new Set<string>();
  for (const r of store.entries()) {
    if (postedByHand(r) && r.proposal.spec.kind === "review_reply") reviews.add(r.proposal.spec.params.reviewId);
  }
  return reviews.size;
}

function checkRating(rating: number): void {
  if (!AUTOPILOT_RATINGS.includes(rating)) {
    throw new PolicyRejection("autopilot_rating", `autopilot may cover only ${AUTOPILOT_RATINGS.join(", ")} star reviews, not ${rating}`);
  }
}

export function validateAutopilotSettings(settings: AutopilotSettings, approvedReplies: number, templates: ReplyTemplates): AutopilotSettings {
  const ratings = [...new Set(settings.ratings)].sort((a, b) => a - b);
  ratings.forEach(checkRating);
  if (!settings.enabled) return Object.freeze({ enabled: false, ratings: Object.freeze(ratings) });
  if (ratings.length === 0) throw new PolicyRejection("autopilot_no_ratings", "pick at least one star rating for autopilot");
  if (approvedReplies < AUTOPILOT_UNLOCK_APPROVALS) {
    throw new PolicyRejection(
      "autopilot_locked",
      `autopilot unlocks after ${AUTOPILOT_UNLOCK_APPROVALS} replies approved by hand; ${approvedReplies} so far`,
    );
  }
  const missing = ratings.filter((r) => templates[String(r)] === undefined);
  if (missing.length > 0) {
    throw new PolicyRejection("autopilot_no_template", `write a reply template for ${missing.join(", ")} star reviews before switching autopilot on for them`);
  }
  return Object.freeze({ enabled: true, ratings: Object.freeze(ratings) });
}

// The templates after the owner saves `text` for `rating`; empty text removes
// the template, which is refused while autopilot is on for that rating.
export function updateTemplates(state: AutopilotState, rating: number, text: string, knownNames: readonly string[]): ReplyTemplates {
  checkRating(rating);
  const key = String(rating);
  const trimmed = text.trim();
  if (trimmed === "") {
    if (state.enabled && state.ratings.includes(rating)) {
      throw new PolicyRejection("autopilot_template_in_use", `switch autopilot off for ${rating} star reviews before removing their template`);
    }
    const rest = Object.fromEntries(Object.entries(state.templates).filter(([k]) => k !== key));
    return Object.freeze(rest);
  }
  const check = checkTemplate(trimmed, knownNames);
  if (!check.ok) throw new PolicyRejection("autopilot_template", `the template was not saved: ${templateFailureText(check.failures)}`);
  return Object.freeze({ ...state.templates, [key]: trimmed });
}

export const hasText = (text: string): boolean => text.trim().length > 0;
