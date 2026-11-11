// The one place that decides whether autopilot answers a new review or leaves
// it for the owner. It reads facts only, gathered by the gate when the review
// arrives: the owner's settings, the review's star rating and whether it has
// text, the classifier's outcome, the review tripwire, whether the owner wrote
// a reply template for that rating, and the draft checks on the filled-in
// template. It never reads the review or the reply itself, holds no word list
// and calls no model, so the eval rail can recompute it from an audit entry
// alone. Anything missing, malformed or unexpected leaves the review for the
// owner.
//
// Autopilot only ever posts the owner's own template for the review's star
// rating, with at most the reviewer's first name filled in. The classifier
// decides whether a review is safe to answer with it. A reply the agent drafts
// always goes to the owner.

import { DELICATE_REASONS, parseVerdict } from "./review-classifier.js";

export const AUTOPILOT_UNLOCK_APPROVALS = 5;
// A 1 or 2 star review is a complaint; the owner answers those personally.
export const MIN_AUTOPILOT_RATING = 3;
export const MAX_RATING = 5;

export interface SettingsFacts {
  readonly enabled: boolean;
  readonly ratings: readonly number[];
  readonly unlocked: boolean;
}

export interface ReviewFacts {
  readonly rating: number;
  readonly hasText: boolean;
}

// "template": the owner's reply template for this star rating, filled in.
// "no_template": the owner has not written one for this rating.
export const REPLY_SOURCES = ["template", "no_template"] as const;

export interface ReplyFacts {
  readonly source: (typeof REPLY_SOURCES)[number];
  // For a template: whether the reviewer's first name went into the slot. False
  // when the template has no slot or the name did not pass greetingName.
  readonly named?: boolean;
}

// Every field may be missing or wrong: these are read back from an audit log
// as well as built by the gate.
export interface AutopilotFacts {
  readonly settings?: SettingsFacts | undefined;
  readonly review?: ReviewFacts | undefined;
  readonly reply?: ReplyFacts | undefined;
  // Absent for a rating-only review, which is never sent to a classifier.
  readonly classifier?: unknown;
  readonly tripwire?: unknown;
  readonly draft?: unknown;
}

export const AUTOPILOT_RULES = [
  "posted_rating_only",
  "posted_text_review",
  "no_settings",
  "autopilot_off",
  "autopilot_locked",
  "no_review",
  "low_rating",
  "rating_not_covered",
  "no_template",
  "no_reply_source",
  "no_tripwire",
  "tripwire_hit",
  "no_classifier",
  "classifier_error",
  "classifier_unreadable",
  "delicate",
  "no_draft_check",
  "draft_check_failed",
  "autopilot_grant_failed",
  "autopilot_post_refused",
] as const;

export type AutopilotRuleId = (typeof AUTOPILOT_RULES)[number];

export interface AutopilotDecision {
  readonly action: "post" | "owner";
  readonly rule: AutopilotRuleId;
  // One sentence for the owner's approvals card.
  readonly reason: string;
}

const owner = (rule: AutopilotRuleId, reason: string): AutopilotDecision => Object.freeze({ action: "owner", rule, reason });

// The gate decided to post but could not record the approval.
export const GRANT_FAILED: AutopilotDecision = owner(
  "autopilot_grant_failed",
  "Autopilot meant to post this but could not record the approval, so it waits for you.",
);

// The gate meant to post but the policy refused the reply.
export const POST_REFUSED: AutopilotDecision = owner(
  "autopilot_post_refused",
  "Autopilot meant to post your template but the reply was refused, so this waits for you.",
);

// The gate approved a post but the send failed: the rule stands, the wording
// says what actually happened.
export const sendFailed = (decision: AutopilotDecision): AutopilotDecision =>
  Object.freeze({ action: decision.action, rule: decision.rule, reason: "Autopilot approved this reply, but sending it failed. Send it yourself or withdraw it." });
const post = (rule: AutopilotRuleId, reason: string): AutopilotDecision => Object.freeze({ action: "post", rule, reason });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRating = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_RATING;

export function decideAutopilot(facts: AutopilotFacts | undefined): AutopilotDecision {
  if (!isRecord(facts)) return owner("no_settings", "Autopilot could not read its settings, so this waits for you.");
  const { settings, review, reply } = facts;
  if (!isRecord(settings) || typeof settings.enabled !== "boolean" || !Array.isArray(settings.ratings) || typeof settings.unlocked !== "boolean") {
    return owner("no_settings", "Autopilot could not read its settings, so this waits for you.");
  }
  if (!settings.enabled) return owner("autopilot_off", "Autopilot is off.");
  if (!settings.unlocked) {
    return owner("autopilot_locked", `Autopilot unlocks after ${AUTOPILOT_UNLOCK_APPROVALS} replies you approve by hand.`);
  }
  if (!isRecord(review) || !isRating(review.rating) || typeof review.hasText !== "boolean") {
    return owner("no_review", "Autopilot could not read the review, so this waits for you.");
  }
  if (review.rating < MIN_AUTOPILOT_RATING) return owner("low_rating", "1 and 2 star reviews always come to you.");
  if (!settings.ratings.includes(review.rating)) {
    return owner("rating_not_covered", `Autopilot is not on for ${review.rating} star reviews.`);
  }
  if (!isRecord(reply) || !(REPLY_SOURCES as readonly unknown[]).includes(reply.source)) {
    return owner("no_reply_source", "Autopilot could not tell where the reply came from.");
  }

  if (review.hasText) {
    const unsafe = textReviewHold(facts);
    if (unsafe) return unsafe;
  }
  // The review is safe to answer; now, is there a template to answer it with?
  if (reply.source === "no_template") {
    return owner("no_template", `You have not written a reply template for ${review.rating} star reviews.`);
  }
  const draft = draftFailures(facts.draft);
  if (draft === undefined) return owner("no_draft_check", "The reply was not checked, so this waits for you.");
  if (draft.length > 0) return owner("draft_check_failed", `The reply failed a check (${draft.join(", ")}).`);
  return review.hasText
    ? post("posted_text_review", `Posted your reply template for ${review.rating} star reviews.`)
    : post("posted_rating_only", `Posted your reply template to a ${review.rating} star rating with no text.`);
}

// Why a review with text must go to the owner, or undefined when the tripwire
// is clear and the classifier calls it not delicate.
function textReviewHold(facts: AutopilotFacts): AutopilotDecision | undefined {
  const tripwire = facts.tripwire;
  if (!isRecord(tripwire) || typeof tripwire.hit !== "boolean") {
    return owner("no_tripwire", "The review was not checked for serious issues, so this waits for you.");
  }
  if (tripwire.hit) {
    const terms = Array.isArray(tripwire.terms) ? tripwire.terms.filter((t) => typeof t === "string").join(", ") : "";
    return owner("tripwire_hit", `The review mentions something you should answer yourself${terms ? ` (${terms})` : ""}.`);
  }
  const classifier = facts.classifier;
  if (!isRecord(classifier)) return owner("no_classifier", "The review was not classified, so this waits for you.");
  if (classifier.status === "error") {
    const why = typeof classifier.error === "string" ? classifier.error : "unknown error";
    return owner("classifier_error", `The review could not be classified (${why}).`);
  }
  const verdict = classifier.status === "ok" ? parseVerdict(classifier.verdict) : undefined;
  const traced = typeof classifier.model === "string" && classifier.model !== "" && typeof classifier.promptHash === "string" && classifier.promptHash !== "";
  if (!verdict || !traced) return owner("classifier_unreadable", "The classifier's answer could not be read, so this waits for you.");
  if (verdict.delicate || verdict.reasons.length > 0) {
    const reasons = verdict.reasons.map((r) => REASON_WORDS[r]).join(", ");
    return owner("delicate", `The review reads as delicate${reasons ? ` (${reasons})` : ""}.`);
  }
  return undefined;
}

// The failed rules, [] when the draft passed, or undefined when the result is
// missing or contradicts itself.
function draftFailures(draft: unknown): readonly string[] | undefined {
  if (!isRecord(draft) || typeof draft.ok !== "boolean" || !Array.isArray(draft.failures)) return undefined;
  const failures = draft.failures.filter((f): f is string => typeof f === "string");
  if (failures.length !== draft.failures.length) return undefined;
  if (draft.ok !== (failures.length === 0)) return undefined;
  return failures;
}

const REASON_WORDS: Record<(typeof DELICATE_REASONS)[number], string> = {
  illness_or_allergy: "illness or allergy",
  hygiene: "hygiene",
  staff_conduct: "staff conduct",
  refund_or_money: "refund or money",
  legal_or_safety: "legal or safety",
  stars_text_mismatch: "stars and text disagree",
  sarcasm: "sarcasm",
  other: "other",
};
