// What a proposal card says at each step, kept apart from the DOM so it can be
// tested. `unsent` means the action is approved but its send failed.

export function decisionLabels(p, unsent) {
  return {
    approve: unsent ? (p.autopilot ? "Send it myself" : "Try again") : "Approve",
    reject: unsent ? "Withdraw" : "Reject",
  };
}

// A 502 is a failed send: the action stays approved, to retry or withdraw.
export function unsentAfterError(status, unsent) {
  return unsent || status === 502;
}

export function outcomeText(p, result, unsent) {
  if (result.status === "executed") return p.kind === "review_reply" ? "Approved and posted." : "Approved and applied.";
  return unsent ? "Withdrawn. Nothing was sent." : "Rejected. Nothing changed.";
}
