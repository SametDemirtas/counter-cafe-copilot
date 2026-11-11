import { type ExecutionResult, type ProposedAction, type ActionStatus } from "./types.js";

export interface ActionRecord {
  readonly proposal: ProposedAction;
  readonly status: ActionStatus;
  readonly grantToken?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly rejectedBy?: string;
  readonly rejectedAt?: string;
  readonly result?: ExecutionResult;
}

export interface ActionStore {
  save(proposal: ProposedAction): void;
  get(id: string): ActionRecord | undefined;
  // For the owner's approval queue and the eval rail; the agent only gets get().
  entries(): readonly ActionRecord[];
  // `from` is "approved" only when a human takes over a reply autopilot approved but could not send.
  markApproved(
    id: string,
    approver: string,
    approvedAt: string,
    grantToken: string,
    from?: "pending" | "approved",
  ): ActionRecord;
  markRejected(id: string, approver: string, rejectedAt: string, from?: "pending" | "approved"): ActionRecord;
  markExecuted(id: string, result: ExecutionResult): ActionRecord;
}

export class InMemoryActionStore implements ActionStore {
  private readonly records = new Map<string, ActionRecord>();

  save(proposal: ProposedAction): void {
    if (this.records.has(proposal.id)) {
      throw new Error(`An action with id ${proposal.id} already exists`);
    }
    this.records.set(proposal.id, Object.freeze({ proposal, status: "pending" as const }));
  }

  get(id: string): ActionRecord | undefined {
    return this.records.get(id);
  }

  entries(): readonly ActionRecord[] {
    return [...this.records.values()];
  }

  markApproved(
    id: string,
    approver: string,
    approvedAt: string,
    grantToken: string,
    from: "pending" | "approved" = "pending",
  ): ActionRecord {
    const current = this.requireStatus(id, from);
    const next: ActionRecord = Object.freeze({
      ...current,
      status: "approved",
      approvedBy: approver,
      approvedAt,
      grantToken,
    });
    this.records.set(id, next);
    return next;
  }

  markRejected(id: string, approver: string, rejectedAt: string, from: "pending" | "approved" = "pending"): ActionRecord {
    const current = this.requireStatus(id, from);
    const next: ActionRecord = Object.freeze({
      ...current,
      status: "rejected",
      rejectedBy: approver,
      rejectedAt,
    });
    this.records.set(id, next);
    return next;
  }

  markExecuted(id: string, result: ExecutionResult): ActionRecord {
    const current = this.requireStatus(id, "approved");
    const next: ActionRecord = Object.freeze({ ...current, status: "executed", result });
    this.records.set(id, next);
    return next;
  }

  // Second line of defence: the store is exported, so it guards transitions too.
  private requireStatus(id: string, expected: ActionStatus): ActionRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`No action with id ${id}`);
    if (record.status !== expected) {
      throw new Error(`Action ${id} is ${record.status}; expected ${expected} for this transition`);
    }
    return record;
  }
}
