// The safety rail's check on one reply autopilot posted. The gate records the
// facts it decided from; this checks those facts against what the rail can see
// for itself and recomputes the decision from them.
//
// What the rail re-derives on its own: the star rating and whether the review
// has text (from the catalog), the settings, the templates and the unlock
// (replayed from the audit log in safety-rail.ts), the review tripwire (from
// the catalog text), the draft checks (from the reply actually stored), and that
// the posted reply is the owner's template for that star rating with at most
// the reviewer's first name filled in, which is the only text autopilot may
// post. The classifier's verdict is the one fact the rail cannot recompute
// without a model, so it must be recorded, traced to a model and prompt, and
// not delicate. Then decideAutopilot runs again on the recorded facts.
// Anything that disagrees is a breach.
//
// The rail shares the draft checks, the tripwire and the template rendering
// with the gate. The core rules it states again in its own words, so a gate
// whose rules drift is still caught: autopilot must be on and unlocked, the
// review must have at least 3 stars and a rating the owner ticked, and a review
// with text needs a classifier verdict that is ok, traced and not delicate.

import {
  type AutopilotState,
  type CatalogReview,
  type RecordedDecision,
  checkDraft,
  decideAutopilot,
  hasText,
  renderTemplate,
  reviewTripwire,
} from "../safety/index.js";

export interface RailReplyCheck {
  readonly recorded: RecordedDecision | undefined;
  // From the catalog, never from the audit entry.
  readonly review: CatalogReview | undefined;
  // The reply as stored and posted.
  readonly replyText: string;
  // Replayed from the audit log up to this approval: the switch and the
  // owner's templates.
  readonly settings: AutopilotState;
  readonly unlocked: boolean;
  readonly knownNames: readonly string[];
}

// Restated rather than imported from lib/safety: 1 and 2 star reviews are
// complaints, which the owner always answers.
const RAIL_MIN_RATING = 3;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const sortedUnique = (a: readonly number[]): string => JSON.stringify([...new Set(a)].sort((x, y) => x - y));
const sameSet = (a: readonly number[], b: readonly number[]): boolean => sortedUnique(a) === sortedUnique(b);

// The rail's own reading of a recorded classifier result.
function classifierCleared(outcome: unknown): boolean {
  if (!isRecord(outcome) || outcome.status !== "ok") return false;
  const traced = typeof outcome.model === "string" && outcome.model !== "" && typeof outcome.promptHash === "string" && outcome.promptHash !== "";
  const verdict = outcome.verdict;
  return traced && isRecord(verdict) && verdict.delicate === false && Array.isArray(verdict.reasons) && verdict.reasons.length === 0;
}

// Undefined when autopilot may have posted this reply; otherwise why not.
export function railReplyBreach(check: RailReplyCheck): string | undefined {
  const { recorded, review, settings } = check;
  if (!recorded) return "posted without a recorded decision";
  if (recorded.action !== "post") return "posted although the recorded decision was to wait for the owner";
  if (!review) return "the review is not in the catalog";
  const facts = recorded.facts;
  if (facts?.review?.rating !== review.rating) return "the recorded star rating differs from the catalog";
  const withText = hasText(review.text);
  if (facts.review.hasText !== withText) return "the recorded has-text fact differs from the catalog";
  const s = facts.settings;
  if (!s || s.enabled !== settings.enabled || !sameSet(s.ratings, settings.ratings)) return "the recorded settings differ from the owner's";
  if (s.unlocked !== check.unlocked) return "the recorded unlock differs from the replies approved by hand";
  if (!settings.enabled) return "autopilot is off in the owner's settings";
  if (!check.unlocked) return "autopilot posted before enough replies were approved by hand";
  if (review.rating < RAIL_MIN_RATING) return "autopilot answered a 1 or 2 star review";
  if (!settings.ratings.includes(review.rating)) return "the owner's settings do not cover this star rating";
  if (withText && reviewTripwire(review.text).hit) return "the review trips the tripwire";
  if (withText && !classifierCleared(facts.classifier)) return "a review with text was posted without an ok, traced, not-delicate classifier verdict";
  const draft = checkDraft(check.replyText, { reviewer: review.author, knownNames: check.knownNames });
  if (!draft.ok) return `the posted reply fails the draft checks (${draft.failures.join(", ")})`;
  // Autopilot posts only the owner's template for this star rating.
  if (facts.reply?.source !== "template") return "posted something other than the owner's reply template";
  const template = settings.templates?.[String(review.rating)];
  if (template === undefined) return "the owner has no reply template for this star rating";
  if (check.replyText !== renderTemplate(template, review.author).text) {
    return "the posted text is not the owner's template for this star rating with the reviewer's name filled in";
  }
  const again = decideAutopilot(facts);
  if (again.action !== "post") return `recomputing the decision from the recorded facts says owner (${again.rule})`;
  return undefined;
}
