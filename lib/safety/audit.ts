import { type AutopilotDecision, type AutopilotFacts } from "./autopilot-decision.js";
import { type AutopilotState } from "./autopilot.js";

export type AuditEventType =
  | "proposed"
  | "approved"
  | "rejected"
  | "executed"
  | "execution_failed"
  // The owner's switch or a reply template changed.
  | "autopilot_changed"
  // A new review came in from the review site.
  | "review_arrived"
  // Autopilot was on but decideAutopilot left the review for the owner.
  | "autopilot_held";

// The decision and every fact it was made from, so a reader (or the eval rail)
// can check the facts and recompute the decision without asking the gate.
export interface RecordedDecision extends AutopilotDecision {
  readonly facts: AutopilotFacts;
}

export interface AuditEvent {
  readonly type: AuditEventType;
  // For autopilot_changed, which touches no action, this is "settings"; for
  // review_arrived, and autopilot_held on a review, the review's id.
  readonly actionId: string;
  readonly at: string; // ISO-8601
  // "agent", "system", "autopilot", or the human's name.
  readonly actor: string;
  readonly detail?: string;
  // On an approval made by autopilot, and on autopilot_held.
  readonly decision?: RecordedDecision;
  // On autopilot_changed: the switch and the templates from this point on.
  readonly autopilot?: AutopilotState;
}

export interface AuditLog {
  record(event: AuditEvent): void;
  entries(): readonly AuditEvent[];
}

export class InMemoryAuditLog implements AuditLog {
  private readonly events: AuditEvent[] = [];

  record(event: AuditEvent): void {
    this.events.push(event);
  }

  entries(): readonly AuditEvent[] {
    return [...this.events];
  }
}
