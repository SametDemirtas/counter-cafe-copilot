// Typed so a caller such as the web server can answer 404 or 409 from what the
// gate decided, without checking the action's state itself first.

import { type ActionStatus } from "./types.js";

export class UnknownActionError extends Error {
  constructor(readonly actionId: string) {
    super(`No action with id ${actionId}`);
    this.name = "UnknownActionError";
  }
}

// The action exists but its state does not allow this step, e.g. approving one
// that was already executed.
export class ActionConflictError extends Error {
  constructor(
    readonly actionId: string,
    readonly status: ActionStatus,
    message: string,
  ) {
    super(message);
    this.name = "ActionConflictError";
  }
}
