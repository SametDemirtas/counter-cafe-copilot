import { describe, expect, it } from "vitest";

import {
  ActionConflictError,
  type ActionCatalog,
  type ActionSpec,
  type ApprovedAction,
  PolicyRejection,
  UnknownActionError,
  createActionGate,
  summarizeAction,
} from "../../lib/safety/index.js";

const ISO = "2026-11-10T08:00:00.000Z";

const priceChange: ActionSpec = {
  kind: "price_change",
  params: { sku: "avocado_toast", currentPriceMinor: 780, proposedPriceMinor: 850, currency: "GBP" },
};

// A second target, for tests that need two open proposals at once.
const otherPriceChange: ActionSpec = {
  kind: "price_change",
  params: { sku: "latte", currentPriceMinor: 340, proposedPriceMinor: 380, currency: "GBP" },
};

const ITEMS: Record<string, { name: string; priceMinor: number; foodCostMinor: number }> = {
  avocado_toast: { name: "Avocado Toast", priceMinor: 780, foodCostMinor: 340 },
  latte: { name: "Latte", priceMinor: 340, foodCostMinor: 70 },
};
const RATINGS: Record<string, number> = { "r-1": 2, "rev-1": 2 };

const catalog: ActionCatalog = {
  currency: "GBP",
  menuItem: (sku) => ITEMS[sku],
  review: (id) => (RATINGS[id] === undefined ? undefined : { author: "Sam", rating: RATINGS[id], text: "Nice coffee." }),
};

function harness() {
  let idN = 0;
  let tokenN = 0;
  return createActionGate({
    catalog,
    now: () => new Date(ISO),
    newId: () => `act-${++idN}`,
    newToken: () => `tok-${++tokenN}`,
  });
}

describe("propose", () => {
  it("records a pending action with a human-readable summary and nothing is executed", () => {
    const { gate, store, sink, audit } = harness();
    const proposal = gate.propose(priceChange);

    expect(proposal.id).toBe("act-1");
    expect(proposal.summary).toBe("Change Avocado Toast price from £7.80 to £8.50");
    expect(store.get("act-1")?.status).toBe("pending");
    expect(sink.applied()).toHaveLength(0);
    expect(audit.entries().map((e) => e.type)).toEqual(["proposed"]);
  });

  it("names a reply by the reviewer, read from the catalog, not by the review id", () => {
    const { gate } = harness();
    const proposal = gate.propose({ kind: "review_reply", params: { reviewId: "r-1", replyText: "Thank you!" } });
    expect(proposal.summary).toBe(`Reply to Sam's review: "Thank you!"`);
  });

  it("stores a frozen clone of the spec, decoupled from the caller", () => {
    const { gate, store } = harness();
    const spec = {
      kind: "price_change" as const,
      params: { sku: "latte", currentPriceMinor: 340, proposedPriceMinor: 360, currency: "GBP" as const },
    };
    const proposal = gate.propose(spec);
    expect(Object.isFrozen(proposal.spec)).toBe(true);
    // mutating the original caller object must not reach the stored record
    spec.params.proposedPriceMinor = 1;
    expect(store.get(proposal.id)?.proposal.spec).toMatchObject({ params: { proposedPriceMinor: 360 } });
    // Nor can the proposer change the params it was handed back.
    const params = proposal.spec.params as { proposedPriceMinor: number };
    expect(() => {
      params.proposedPriceMinor = 1;
    }).toThrow(TypeError);
    expect(store.get(proposal.id)?.proposal.spec).toMatchObject({ params: { proposedPriceMinor: 360 } });
  });
});

describe("approve / reject", () => {
  it("approves a pending action and marks the store approved", () => {
    const { gate, store } = harness();
    const proposal = gate.propose(priceChange);
    const approved = gate.approve(proposal.id, "owner");

    expect(approved.approvedBy).toBe("owner");
    expect(store.get(proposal.id)?.status).toBe("approved");
  });

  it("refuses to approve an action twice", () => {
    const { gate } = harness();
    const proposal = gate.propose(priceChange);
    gate.approve(proposal.id, "owner");
    expect(() => gate.approve(proposal.id, "owner")).toThrow(/is approved; only a pending action can be approved/);
  });

  it("makes rejection terminal", () => {
    const { gate, store } = harness();
    const rejected = gate.propose(priceChange);
    gate.reject(rejected.id, "owner");
    expect(store.get(rejected.id)?.status).toBe("rejected");
    expect(() => gate.approve(rejected.id, "owner")).toThrow(ActionConflictError);
    expect(() => gate.approve(rejected.id, "owner")).toThrow(/is rejected; only a pending action can be approved/);
    expect(() => gate.reject(rejected.id, "owner")).toThrow(/is rejected; only a pending or unsent approved action can be rejected/);
  });

  it("lets the owner withdraw an approval that never ran, and the held grant then executes nothing", () => {
    const { gate, store, audit, sink } = harness();
    const p = gate.propose(priceChange);
    const approved = gate.approve(p.id, "owner");
    gate.reject(p.id, "Sam");
    expect(store.get(p.id)).toMatchObject({ status: "rejected", rejectedBy: "Sam" });
    expect(audit.entries().at(-1)).toMatchObject({ type: "rejected", actor: "Sam", detail: "withdrew an approval by owner; the action never ran" });
    expect(() => gate.execute(approved)).toThrow(/is rejected; only an approved action can be executed/);
    expect(sink.applied()).toHaveLength(0);
  });

  it("refuses to reject an executed action", () => {
    const { gate } = harness();
    const p = gate.propose(priceChange);
    gate.execute(gate.approve(p.id, "owner"));
    expect(() => gate.reject(p.id, "owner")).toThrow(ActionConflictError);
  });

  it("throws when approving or rejecting an unknown id", () => {
    const { gate } = harness();
    expect(() => gate.approve("nope", "owner")).toThrow(/No action with id nope/);
    expect(() => gate.reject("nope", "owner")).toThrow(UnknownActionError);
  });

  it("stores the approver trimmed, on the record and in the audit trail", () => {
    const { gate, store, audit } = harness();
    const proposal = gate.propose(priceChange);
    const approved = gate.approve(proposal.id, "  owner  ");

    expect(approved.approvedBy).toBe("owner");
    expect(store.get(proposal.id)?.approvedBy).toBe("owner");
    expect(audit.entries().find((e) => e.type === "approved")?.actor).toBe("owner");
  });
});

describe("execute - happy path and idempotency", () => {
  it("runs the side effect exactly once for an approved action", () => {
    const { gate, store, sink, audit } = harness();
    const proposal = gate.propose(priceChange);
    const approved = gate.approve(proposal.id, "owner");
    const result = gate.execute(approved);

    expect(result.outcome).toBe("Set avocado_toast price to £8.50");
    expect(sink.applied()).toHaveLength(1);
    expect(store.get(proposal.id)?.status).toBe("executed");
    expect(audit.entries().map((e) => e.type)).toEqual(["proposed", "approved", "executed"]);
  });

  it("is idempotent: a repeat applies the effect once and logs one execution", () => {
    const { gate, sink, audit } = harness();
    const approved = gate.approve(gate.propose(priceChange).id, "owner");

    const first = gate.execute(approved);
    const second = gate.execute(approved);

    expect(sink.applied()).toHaveLength(1);
    expect(second).toEqual(first);
    expect(audit.entries().filter((e) => e.type === "executed")).toHaveLength(1);
  });

  it("runs a review_reply end to end", () => {
    const { gate, sink } = harness();
    const proposal = gate.propose({ kind: "review_reply", params: { reviewId: "r-1", replyText: "Thank you!" } });
    const result = gate.execute(gate.approve(proposal.id, "owner"));
    expect(result.outcome).toBe("Posted reply to review r-1");
    expect(sink.applied()).toHaveLength(1);
  });
});

describe("execute - the gate cannot be bypassed", () => {
  it("will not type-check a proposed action, and refuses it at runtime", () => {
    const { gate } = harness();
    const proposal = gate.propose(priceChange);
    expect(() =>
      // @ts-expect-error execute() accepts only an ApprovedAction, never a ProposedAction
      gate.execute(proposal),
    ).toThrow(/requires an approved action produced by approve/);
  });

  it("rejects a forged object that lacks the private brand", () => {
    const { gate } = harness();
    const proposal = gate.propose(priceChange);
    const forged = { proposal, approvedBy: "x", approvedAt: ISO, grantToken: "tok-1" } as unknown as ApprovedAction;
    expect(() => gate.execute(forged)).toThrow(/requires an approved action produced by approve/);
  });

  it("applies the spec from the store, not a swapped spec on the passed action", () => {
    const { gate, sink } = harness();
    const approved = gate.approve(gate.propose(priceChange).id, "owner");
    const swapped = {
      ...approved,
      proposal: {
        ...approved.proposal,
        spec: { kind: "price_change", params: { sku: "avocado_toast", currentPriceMinor: 780, proposedPriceMinor: 1, currency: "GBP" } },
      },
    } as ApprovedAction;
    const result = gate.execute(swapped);
    expect(result.outcome).toBe("Set avocado_toast price to £8.50");
    expect(sink.applied()[0]?.description).toBe("Set avocado_toast price to £8.50");
  });

  it("rejects a branded action carrying the wrong grant token", () => {
    const { gate } = harness();
    const approved = gate.approve(gate.propose(priceChange).id, "owner");
    const wrongToken = { ...approved, grantToken: "tok-wrong" } as ApprovedAction;
    expect(() => gate.execute(wrongToken)).toThrow(/Grant token mismatch/);
  });

  it("rejects a wrong token of the same length as the real one", () => {
    const { gate, sink } = harness();
    const approved = gate.approve(gate.propose(priceChange).id, "owner");
    expect(approved.grantToken).toBe("tok-1");
    const sameLength = { ...approved, grantToken: "tok-2" } as ApprovedAction;
    expect(() => gate.execute(sameLength)).toThrow(/Grant token mismatch/);
    expect(sink.applied()).toHaveLength(0);
  });

  it("rejects a non-string grant token on an otherwise genuine approved action", () => {
    const { gate, sink } = harness();
    const approved = gate.approve(gate.propose(priceChange).id, "owner");
    const numeric = { ...approved, grantToken: 123 } as unknown as ApprovedAction;
    expect(() => gate.execute(numeric)).toThrow(/Grant token mismatch/);
    expect(sink.applied()).toHaveLength(0);
  });

  it("checks the token before the idempotency return, even after execution", () => {
    const { gate } = harness();
    const approved = gate.approve(gate.propose(priceChange).id, "owner");
    gate.execute(approved); // record is now executed
    const wrongToken = { ...approved, grantToken: "tok-wrong" } as ApprovedAction;
    // a wrong-token caller must not be handed back the stored result
    expect(() => gate.execute(wrongToken)).toThrow(/Grant token mismatch/);
  });

  it("refuses a branded action whose id is still pending", () => {
    const { gate } = harness();
    const pending = gate.propose(priceChange);
    const genuine = gate.approve(gate.propose(otherPriceChange).id, "owner");
    const forged = { ...genuine, proposal: pending } as ApprovedAction;
    expect(() => gate.execute(forged)).toThrow(/only an approved action/i);
  });

  it("refuses a branded action for a rejected id", () => {
    const { gate } = harness();
    const rejected = gate.propose(priceChange);
    const genuine = gate.approve(gate.propose(otherPriceChange).id, "owner");
    gate.reject(rejected.id, "owner");
    const forged = { ...genuine, proposal: rejected } as ApprovedAction;
    expect(() => gate.execute(forged)).toThrow(/only an approved action/i);
  });

  it("refuses a branded action for an id the store never saw", () => {
    const { gate } = harness();
    const genuine = gate.approve(gate.propose(priceChange).id, "owner");
    const ghost = { ...genuine, proposal: { ...genuine.proposal, id: "ghost" } } as ApprovedAction;
    expect(() => gate.execute(ghost)).toThrow(/No action with id/i);
  });
});

describe("audit trail", () => {
  it("records actor and detail for the full lifecycle", () => {
    const { gate, audit } = harness();
    const proposal = gate.propose(priceChange);
    gate.execute(gate.approve(proposal.id, "owner"));
    expect(audit.entries()).toEqual([
      { type: "proposed", actionId: proposal.id, at: ISO, actor: "agent", detail: "Change Avocado Toast price from £7.80 to £8.50" },
      { type: "approved", actionId: proposal.id, at: ISO, actor: "owner" },
      { type: "executed", actionId: proposal.id, at: ISO, actor: "system", detail: "Set avocado_toast price to £8.50" },
    ]);
  });

  it("records a rejected event with the approver as actor", () => {
    const { gate, audit } = harness();
    const proposal = gate.propose(priceChange);
    gate.reject(proposal.id, "manager");
    expect(audit.entries().map((e) => ({ type: e.type, actor: e.actor }))).toEqual([
      { type: "proposed", actor: "agent" },
      { type: "rejected", actor: "manager" },
    ]);
  });
});

describe("summarizeAction", () => {
  it("names a price change by the menu's display name when given one, else by sku", () => {
    expect(summarizeAction(priceChange, "Avocado Toast")).toBe("Change Avocado Toast price from £7.80 to £8.50");
    expect(summarizeAction(priceChange)).toBe("Change avocado_toast price from £7.80 to £8.50");
  });

  it("names a review reply by the reviewer when given one, else by review id", () => {
    const spec: ActionSpec = { kind: "review_reply", params: { reviewId: "rev-5", replyText: "Thanks!" } };
    expect(summarizeAction(spec, "Megan")).toBe(`Reply to Megan's review: "Thanks!"`);
    expect(summarizeAction(spec)).toBe(`Reply to review rev-5: "Thanks!"`);
  });

  it("truncates a long review reply at 57 characters plus an ellipsis", () => {
    const summary = summarizeAction({ kind: "review_reply", params: { reviewId: "r-1", replyText: "x".repeat(100) } });
    expect(summary).toBe(`Reply to review r-1: "${"x".repeat(57)}..."`);
  });

  it("cuts a long reply at a word boundary rather than mid-word", () => {
    const replyText = "Thank you for the lovely review, Jasmin. We're so glad you enjoyed your visit.";
    expect(summarizeAction({ kind: "review_reply", params: { reviewId: "rev-2", replyText } }, "Jasmin")).toBe(
      `Reply to Jasmin's review: "Thank you for the lovely review, Jasmin. We're so glad..."`,
    );
  });

  it("does not truncate a reply of exactly 60 characters", () => {
    const text = "y".repeat(60);
    expect(summarizeAction({ kind: "review_reply", params: { reviewId: "r", replyText: text } })).toBe(
      `Reply to review r: "${text}"`,
    );
  });
});

describe("one open proposal per target", () => {
  it("refuses a second pending proposal for the same item or review", () => {
    const { gate } = harness();
    gate.propose(priceChange);
    const cheaper: ActionSpec = { ...priceChange, params: { ...priceChange.params, proposedPriceMinor: 820 } };
    expect(() => gate.propose(cheaper)).toThrow(/A proposal for this is already waiting for approval: Change Avocado Toast/);
    const reply: ActionSpec = { kind: "review_reply", params: { reviewId: "rev-1", replyText: "Thanks!" } };
    gate.propose(reply);
    expect(() => gate.propose(reply)).toThrow(/already waiting for approval/);
  });

  it("refuses with a PolicyRejection carrying the already_open rule", () => {
    const { gate } = harness();
    gate.propose(priceChange);
    let caught: unknown;
    try {
      gate.propose(priceChange);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyRejection);
    expect((caught as PolicyRejection).rule).toBe("already_open");
  });

  it("treats an approved action whose execution may be retried as still open", () => {
    const { gate } = harness();
    gate.approve(gate.propose(priceChange).id, "owner");
    expect(() => gate.propose(priceChange)).toThrow(/A proposal for this is already approved and not yet sent/);
  });

  it("allows a new proposal once the earlier one is resolved", () => {
    const { gate } = harness();
    gate.reject(gate.propose(priceChange).id, "owner");
    expect(() => gate.propose(priceChange)).not.toThrow();
  });
});

describe("invariants and defaults", () => {
  it("refuses an empty approver or one borrowing a system actor name", () => {
    const { gate } = createActionGate({ catalog });
    const p = gate.propose(priceChange);
    expect(() => gate.approve(p.id, "")).toThrow(/not a valid approver/);
    expect(() => gate.approve(p.id, "  ")).toThrow(/not a valid approver/);
    expect(() => gate.approve(p.id, "agent")).toThrow(/not a valid approver/);
    expect(() => gate.reject(p.id, "System")).toThrow(/not a valid approver/);
    expect(() => gate.approve(p.id, "owner")).not.toThrow();
  });

  it("the un-overridden factory produces distinct random ids and tokens", () => {
    const { gate } = createActionGate({ catalog });
    const a = gate.propose(priceChange);
    const b = gate.propose(otherPriceChange);
    expect(a.id).not.toBe(b.id);
    const t1 = gate.approve(a.id, "owner").grantToken;
    const t2 = gate.approve(b.id, "owner").grantToken;
    expect(t1).not.toBe(t2);
    expect(t1).toMatch(/[0-9a-f-]{36}/);
  });
});
