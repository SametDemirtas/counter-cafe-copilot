// The agent proposes; the owner approves. When a new review arrives, autopilot
// may answer it with the owner's own template, through the same approve and
// execute path. Only an approved action executes.

import { timingSafeEqual } from "node:crypto";

import { type ActionSpec, type ExecutionResult, type ProposedAction, summarizeAction } from "./types.js";
import { type ActionRecord, type ActionStore } from "./store.js";
import { type AuditLog, type RecordedDecision } from "./audit.js";
import { type EffectSink, type HandlerRegistry } from "./handlers.js";
import { type ActionCatalog, ApprovalPolicy } from "./policy.js";
import { AGENT_ACTOR, AUTOPILOT_ACTOR, SYSTEM_ACTOR, humanApprover } from "./actors.js";
import { type AutopilotSettings, type AutopilotStatus } from "./autopilot.js";
import { type ArrivalOutcome, AutopilotController } from "./autopilot-controller.js";
import { type AutopilotDecision, GRANT_FAILED, POST_REFUSED, sendFailed } from "./autopilot-decision.js";
import { ActionConflictError, UnknownActionError } from "./errors.js";
import { type ReviewClassifier } from "./review-classifier.js";
import { type ArrivedReview, type ArrivingReview, ReviewInbox } from "./review-inbox.js";

// What onReviewArrived did: the review as stored, the decision, and the reply
// autopilot proposed when it decided to post.
export interface ReviewArrival extends ArrivalOutcome {
  readonly review: ArrivedReview;
}

// Never exported, so a literal or a cast can't make an ApprovedAction: the brand
// stops accidental misuse, such as passing a proposal to execute(). It is not
// the security check, since a spread of a real approved object copies the
// symbol. The grant token, compared against the store on every execute, is.
const APPROVED_BRAND: unique symbol = Symbol("counter.safety.approvedAction");

export interface ApprovedAction {
  readonly [APPROVED_BRAND]: true;
  readonly proposal: ProposedAction;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly grantToken: string;
}

function isApprovedAction(value: unknown): value is ApprovedAction {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[APPROVED_BRAND] === true
  );
}

// Constant time so the token can't be guessed byte by byte from timing.
// A forged object may carry a non-string, hence the typeof checks.
function tokensMatch(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Cloned and frozen so the proposer can't change what the human approved.
function pinSpec(spec: ActionSpec): ActionSpec {
  const clone = structuredClone(spec);
  Object.freeze(clone.params);
  return Object.freeze(clone);
}

export interface ActionGateDeps {
  readonly catalog: ActionCatalog;
  readonly store: ActionStore;
  readonly audit: AuditLog;
  readonly handlers: HandlerRegistry;
  readonly sink: EffectSink;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly newToken: () => string;
  // Reads a text review and says whether it is delicate. Without one, autopilot
  // answers no review with text.
  readonly classifier: ReviewClassifier;
}

export class ActionGate {
  private readonly policy: ApprovalPolicy;
  private readonly autopilot: AutopilotController;
  private readonly inbox: ReviewInbox;

  constructor(private readonly deps: ActionGateDeps) {
    this.inbox = deps.catalog instanceof ReviewInbox ? deps.catalog : new ReviewInbox(deps.catalog);
    this.policy = new ApprovalPolicy(this.inbox, deps.store);
    this.autopilot = new AutopilotController({ ...deps, catalog: this.inbox });
  }

  // The catalog with every review that arrived since startup.
  get catalog(): ReviewInbox {
    return this.inbox;
  }

  // A proposal always waits for the owner, whoever made it: the agent's
  // drafts are never posted by autopilot.
  propose(spec: ActionSpec): ProposedAction {
    // Before anything is stored: a refused proposal leaves no record. Every
    // refusal is a PolicyRejection with a rule id.
    this.policy.check(spec);
    return this.saveProposal(spec, AGENT_ACTOR);
  }

  private saveProposal(spec: ActionSpec, actor: string): ProposedAction {
    const pinned = pinSpec(spec);
    const proposal: ProposedAction = Object.freeze({
      id: this.deps.newId(),
      spec: pinned,
      summary: summarizeAction(pinned, this.displayName(pinned)),
      proposedAt: this.deps.now().toISOString(),
    });
    this.deps.store.save(proposal);
    this.deps.audit.record({ type: "proposed", actionId: proposal.id, at: proposal.proposedAt, actor, detail: proposal.summary });
    return proposal;
  }

  // A new review from the review site. Autopilot decides from facts alone; on
  // "post" it proposes the owner's template for that rating and approves and
  // executes it like any other action, audited as autopilot with the facts.
  // Otherwise the review waits for the owner, who can ask the agent for a
  // draft. A malformed review is refused with a PolicyRejection and not stored.
  onReviewArrived(input: ArrivingReview): ReviewArrival {
    const at = this.deps.now().toISOString();
    const review = this.inbox.add(input, input.id ?? `rev-${this.deps.newId()}`, at);
    const detail = `${review.rating} star review from ${review.author.trim() || "a reviewer with no name"}`;
    this.deps.audit.record({ type: "review_arrived", actionId: review.id, at, actor: SYSTEM_ACTOR, detail });
    const { facts, decision, replyText } = this.autopilot.evaluate(review.id, review);
    let outcome: ArrivalOutcome = { decision };
    if (decision.action === "post" && replyText !== undefined) {
      outcome = this.postTemplate(review.id, replyText, { ...decision, facts });
    } else if (facts.settings?.enabled) {
      this.autopilot.held(review.id, decision, facts);
    }
    this.autopilot.rememberArrival(review.id, outcome);
    return Object.freeze({ review, ...outcome });
  }

  // Why autopilot answered this review or left it for the owner, as decided
  // when it arrived. Undefined for a review that did not arrive while running.
  arrivalFor(reviewId: string): ArrivalOutcome | undefined {
    return this.autopilot.arrival(reviewId);
  }

  private postTemplate(reviewId: string, replyText: string, decision: RecordedDecision): ArrivalOutcome {
    const spec: ActionSpec = { kind: "review_reply", params: { reviewId, replyText } };
    try {
      this.policy.check(spec);
    } catch {
      this.autopilot.held(reviewId, POST_REFUSED, decision.facts);
      return { decision: POST_REFUSED };
    }
    const proposal = this.saveProposal(spec, AUTOPILOT_ACTOR);
    const final = this.autoApprove(proposal.id, decision);
    this.autopilot.remember(proposal.id, final);
    return { decision: final, proposalId: proposal.id };
  }

  // The menu item's name for a price change, the reviewer's for a reply.
  displayName(spec: ActionSpec): string | undefined {
    return spec.kind === "price_change"
      ? this.deps.catalog.menuItem(spec.params.sku)?.name
      : this.deps.catalog.review(spec.params.reviewId)?.author;
  }

  // Approves a pending action, or takes over a reply autopilot approved but
  // could not send. Either way the human is recorded as the approver.
  approve(id: string, rawApprover: string): ApprovedAction {
    const approver = humanApprover(rawApprover);
    if (this.autopilot.isUnsent(id)) return this.takeOver(id, approver);
    return this.grant(id, approver);
  }

  // The owner's side only: the agent's propose-only port never reaches this.
  setAutopilot(settings: AutopilotSettings, rawApprover: string): AutopilotStatus {
    return this.autopilot.set(settings, humanApprover(rawApprover));
  }

  // Saves the owner's reply template for one star rating, after the same
  // checks autopilot runs before posting; empty text removes it. Refused with
  // a PolicyRejection that says why.
  setReplyTemplate(rating: number, text: string, rawApprover: string): AutopilotStatus {
    return this.autopilot.setTemplate(rating, text, humanApprover(rawApprover));
  }

  autopilotStatus(): AutopilotStatus {
    return this.autopilot.status();
  }

  // Why autopilot's reply went out, or why it did not after all. Undefined
  // for anything autopilot did not propose.
  autopilotDecision(id: string): AutopilotDecision | undefined {
    return this.autopilot.decisionFor(id);
  }

  // A reply autopilot approved but could not post: the owner retries or rejects it.
  awaitingRetry(id: string): boolean {
    return this.autopilot.isUnsent(id);
  }

  // The decision as it stands after trying: a failed grant leaves the reply
  // pending for the owner, a failed send leaves it approved for a retry.
  private autoApprove(id: string, decision: RecordedDecision): AutopilotDecision {
    let approved: ApprovedAction;
    try {
      approved = this.grant(id, AUTOPILOT_ACTOR, decision);
    } catch {
      // grant() writes nothing when it fails, so the proposal is still pending
      // and the card and the audit log say so rather than "Posted".
      this.autopilot.held(id, GRANT_FAILED, decision.facts);
      return GRANT_FAILED;
    }
    try {
      this.execute(approved);
    } catch {
      this.autopilot.markUnsent(id);
      return sendFailed(decision);
    }
    return { action: decision.action, rule: decision.rule, reason: decision.reason };
  }

  // Autopilot may have been switched off since it approved this, so the
  // owner's retry is their own approval, with a fresh grant.
  private takeOver(id: string, approver: string): ApprovedAction {
    const record = this.requireRecord(id);
    const still = this.autopilot.covers(record.proposal.spec);
    const detail = still !== undefined
      ? `retry of a reply autopilot could not send; autopilot still covers ${still} star reviews`
      : "approved by hand: autopilot no longer covers this reply";
    const approvedAt = this.deps.now().toISOString();
    const grantToken = this.deps.newToken();
    this.deps.audit.record({ type: "approved", actionId: id, at: approvedAt, actor: approver, detail });
    this.deps.store.markApproved(id, approver, approvedAt, grantToken, "approved");
    this.autopilot.clearUnsent(id);
    return { [APPROVED_BRAND]: true, proposal: record.proposal, approvedBy: approver, approvedAt, grantToken };
  }

  private requireRecord(id: string): ActionRecord {
    const record = this.deps.store.get(id);
    if (!record) throw new UnknownActionError(id);
    return record;
  }

  private grant(id: string, approver: string, auto?: RecordedDecision): ApprovedAction {
    const record = this.requireRecord(id);
    if (record.status !== "pending") {
      throw new ActionConflictError(id, record.status, `Action ${id} is ${record.status}; only a pending action can be approved`);
    }
    // The audit entry goes first: if the log cannot take it, the store is
    // untouched and the action is still pending. The store write after it
    // cannot fail, since the status was checked above.
    const approvedAt = this.deps.now().toISOString();
    const grantToken = this.deps.newToken();
    const why = auto ? { detail: `autopilot: ${auto.reason} (${auto.rule})`, decision: auto } : {};
    this.deps.audit.record({ type: "approved", actionId: id, at: approvedAt, actor: approver, ...why });
    this.deps.store.markApproved(id, approver, approvedAt, grantToken);
    return {
      [APPROVED_BRAND]: true,
      proposal: record.proposal,
      approvedBy: approver,
      approvedAt,
      grantToken,
    };
  }

  // Rejects a pending action, or withdraws an approved one that never ran, such
  // as a send that keeps failing. Once executed, nothing can be taken back.
  reject(id: string, rawApprover: string): void {
    const approver = humanApprover(rawApprover);
    const record = this.requireRecord(id);
    const { status } = record;
    if (status !== "pending" && status !== "approved") {
      throw new ActionConflictError(id, status, `Action ${id} is ${status}; only a pending or unsent approved action can be rejected`);
    }
    const unsent = this.autopilot.isUnsent(id);
    const rejectedAt = this.deps.now().toISOString();
    this.deps.store.markRejected(id, approver, rejectedAt, status);
    this.autopilot.clearUnsent(id);
    const detail = unsent
      ? "withdrew a reply autopilot could not send"
      : status === "approved"
        ? `withdrew an approval by ${record.approvedBy ?? "unknown"}; the action never ran`
        : undefined;
    this.deps.audit.record({ type: "rejected", actionId: id, at: rejectedAt, actor: approver, ...(detail ? { detail } : {}) });
  }

  execute(action: ApprovedAction): ExecutionResult {
    if (!isApprovedAction(action)) {
      throw new Error("execute() requires an approved action produced by approve()");
    }
    const id = action.proposal.id;
    const record = this.requireRecord(id);
    if (record.status !== "approved" && record.status !== "executed") {
      throw new ActionConflictError(id, record.status, `Action ${id} is ${record.status}; only an approved action can be executed`);
    }
    // Check the token before the idempotent return, so a wrong token never sees a result.
    if (!record.grantToken || !tokensMatch(record.grantToken, action.grantToken)) {
      throw new Error(`Grant token mismatch for action ${id}`);
    }
    if (record.status === "executed") {
      if (!record.result) throw new Error(`Action ${id} is executed but has no stored result`);
      return record.result;
    }

    // From the store, not the passed action, which a caller could have mutated.
    const spec = record.proposal.spec;
    const handler = this.deps.handlers.get(spec.kind);
    let outcome: string;
    try {
      outcome = handler.execute(id, spec, this.deps.sink);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.audit.record({ type: "execution_failed", actionId: id, at: this.deps.now().toISOString(), actor: SYSTEM_ACTOR, detail });
      throw error;
    }
    const result: ExecutionResult = {
      actionId: id,
      kind: spec.kind,
      outcome,
      executedAt: this.deps.now().toISOString(),
    };
    this.deps.store.markExecuted(id, result);
    this.deps.audit.record({ type: "executed", actionId: id, at: result.executedAt, actor: SYSTEM_ACTOR, detail: outcome });
    return result;
  }
}
