// The gate's autopilot state: the owner's settings and templates, the facts and
// decision for each review that arrived, and the replies autopilot approved
// but could not post.

import { type AuditLog } from "./audit.js";
import { AUTOPILOT_ACTOR } from "./actors.js";
import { checkDraft, reviewTripwire } from "./autopilot-checks.js";
import { type AutopilotDecision, type AutopilotFacts, MIN_AUTOPILOT_RATING, type ReplyFacts, decideAutopilot } from "./autopilot-decision.js";
import {
  AUTOPILOT_OFF,
  AUTOPILOT_UNLOCK_APPROVALS,
  type AutopilotSettings,
  type AutopilotState,
  type AutopilotStatus,
  hasText,
  humanApprovedReplies,
  updateTemplates,
  validateAutopilotSettings,
} from "./autopilot.js";
import { type ActionCatalog, type CatalogReview } from "./policy.js";
import { renderTemplate } from "./reply-template.js";
import { type ReviewClassifier, classifySafely } from "./review-classifier.js";
import { type ActionStore } from "./store.js";
import { type ActionSpec } from "./types.js";

export interface AutopilotControllerDeps {
  readonly catalog: ActionCatalog;
  readonly store: ActionStore;
  readonly audit: AuditLog;
  readonly now: () => Date;
  readonly classifier: ReviewClassifier;
}

// What autopilot found for one review: the facts it gathered, what
// decideAutopilot made of them, and the text it would post, if any.
export interface AutopilotEvaluation {
  readonly facts: AutopilotFacts;
  readonly decision: AutopilotDecision;
  readonly replyText?: string;
}

// What happened when a review arrived: the decision, and the reply autopilot
// proposed when it decided to post.
export interface ArrivalOutcome {
  readonly decision: AutopilotDecision;
  readonly proposalId?: string;
}

export class AutopilotController {
  private state: AutopilotState = AUTOPILOT_OFF;
  private readonly unsent = new Set<string>();
  private readonly decisions = new Map<string, AutopilotDecision>();
  private readonly arrivals = new Map<string, ArrivalOutcome>();

  constructor(private readonly deps: AutopilotControllerDeps) {}

  status(): AutopilotStatus {
    const approvedReplies = humanApprovedReplies(this.deps.store);
    return {
      ...this.state,
      approvedReplies,
      required: AUTOPILOT_UNLOCK_APPROVALS,
      unlocked: approvedReplies >= AUTOPILOT_UNLOCK_APPROVALS,
    };
  }

  // The caller has already checked that `approver` is a human name.
  set(settings: AutopilotSettings, approver: string): AutopilotStatus {
    const next = validateAutopilotSettings(settings, humanApprovedReplies(this.deps.store), this.state.templates);
    const detail = next.enabled ? `autopilot on for ${next.ratings.join(", ")} star reviews` : "autopilot off";
    return this.commit({ ...next, templates: this.state.templates }, approver, detail);
  }

  setTemplate(rating: number, text: string, approver: string): AutopilotStatus {
    const templates = updateTemplates(this.state, rating, text, this.deps.catalog.knownNames?.() ?? []);
    const saved = templates[String(rating)] !== undefined;
    return this.commit({ ...this.state, templates }, approver, `reply template for ${rating} star reviews ${saved ? "saved" : "removed"}`);
  }

  private commit(next: AutopilotState, approver: string, detail: string): AutopilotStatus {
    const state: AutopilotState = Object.freeze({ enabled: next.enabled, ratings: next.ratings, templates: next.templates });
    // The audit entry first: if the log cannot take it, nothing changes.
    this.deps.audit.record({ type: "autopilot_changed", actionId: "settings", at: this.deps.now().toISOString(), actor: approver, detail, autopilot: state });
    this.state = state;
    return this.status();
  }

  // The star rating autopilot covers for this reply right now, if any. Used
  // only to word the audit entry when the owner retries a failed send.
  covers(spec: ActionSpec): number | undefined {
    if (!this.state.enabled || spec.kind !== "review_reply") return undefined;
    const rating = this.deps.catalog.review(spec.params.reviewId)?.rating;
    return rating !== undefined && this.state.ratings.includes(rating) ? rating : undefined;
  }

  // Gathers the facts for a review that just arrived and decides. The
  // classifier is asked only when autopilot is on and covers the rating.
  evaluate(reviewId: string, review: CatalogReview): AutopilotEvaluation {
    const status = this.status();
    const settings = { enabled: status.enabled, ratings: [...status.ratings], unlocked: status.unlocked };
    const withText = hasText(review.text);
    const reviewFacts = { rating: review.rating, hasText: withText };
    const covered = settings.enabled && review.rating >= MIN_AUTOPILOT_RATING && settings.ratings.includes(review.rating);
    if (!covered) {
      const facts: AutopilotFacts = { settings, review: reviewFacts };
      return { facts, decision: decideAutopilot(facts) };
    }
    const template = status.templates[String(review.rating)];
    const rendered = template === undefined ? undefined : renderTemplate(template, review.author);
    const reply: ReplyFacts = rendered ? { source: "template", named: rendered.named } : { source: "no_template" };
    const names = this.deps.catalog.knownNames?.() ?? [];
    const facts: AutopilotFacts = {
      settings,
      review: reviewFacts,
      reply,
      ...(withText
        ? {
            tripwire: reviewTripwire(review.text),
            classifier: classifySafely(this.deps.classifier, { reviewId, rating: review.rating, text: review.text }),
          }
        : {}),
      ...(rendered ? { draft: checkDraft(rendered.text, { reviewer: review.author, knownNames: names }) } : {}),
    };
    return { facts, decision: decideAutopilot(facts), ...(rendered ? { replyText: rendered.text } : {}) };
  }

  remember(id: string, decision: AutopilotDecision): void {
    this.decisions.set(id, decision);
  }

  // Why autopilot's reply went out or did not, for a reply autopilot proposed.
  decisionFor(id: string): AutopilotDecision | undefined {
    return this.decisions.get(id);
  }

  rememberArrival(reviewId: string, outcome: ArrivalOutcome): void {
    this.arrivals.set(reviewId, Object.freeze({ ...outcome }));
  }

  arrival(reviewId: string): ArrivalOutcome | undefined {
    return this.arrivals.get(reviewId);
  }

  // Recorded when autopilot is on but leaves a review for the owner. `id` is
  // the review's id, or the reply's when autopilot could not record its approval.
  held(id: string, decision: AutopilotDecision, facts: AutopilotFacts): void {
    this.deps.audit.record({
      type: "autopilot_held",
      actionId: id,
      at: this.deps.now().toISOString(),
      actor: AUTOPILOT_ACTOR,
      detail: `left for the owner: ${decision.reason} (${decision.rule})`,
      decision: { ...decision, facts },
    });
  }

  markUnsent(id: string): void {
    this.unsent.add(id);
  }

  isUnsent(id: string): boolean {
    return this.unsent.has(id);
  }

  clearUnsent(id: string): void {
    this.unsent.delete(id);
  }
}
