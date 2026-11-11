import { describe, expect, it } from "vitest";

import { InMemoryActionStore, type ProposedAction } from "../../lib/safety/index.js";

const proposal: ProposedAction = {
  id: "act-1",
  spec: { kind: "review_reply", params: { reviewId: "r-1", replyText: "Thanks!" } },
  summary: "Reply to review r-1",
  proposedAt: "2026-11-10T08:00:00.000Z",
};

describe("InMemoryActionStore", () => {
  it("saves a new proposal as pending", () => {
    const store = new InMemoryActionStore();
    store.save(proposal);
    expect(store.get("act-1")?.status).toBe("pending");
  });

  it("refuses to save the same id twice", () => {
    const store = new InMemoryActionStore();
    store.save(proposal);
    expect(() => store.save(proposal)).toThrow(/An action with id act-1 already exists/);
  });

  it("returns undefined for an unknown id", () => {
    expect(new InMemoryActionStore().get("missing")).toBeUndefined();
  });

  it("lists every record in insertion order, reflecting status changes", () => {
    const store = new InMemoryActionStore();
    expect(store.entries()).toHaveLength(0);
    store.save(proposal);
    const second: ProposedAction = { ...proposal, id: "act-2" };
    store.save(second);
    store.markApproved("act-2", "owner", "t", "tok");
    const ids = store.entries().map((r) => r.proposal.id);
    expect(ids).toEqual(["act-1", "act-2"]);
    expect(store.entries().map((r) => r.status)).toEqual(["pending", "approved"]);
  });

  it("records approval fields and keeps the proposal", () => {
    const store = new InMemoryActionStore();
    store.save(proposal);
    const record = store.markApproved("act-1", "owner", "2026-11-10T08:01:00.000Z", "tok-1");
    expect(record).toMatchObject({
      status: "approved",
      approvedBy: "owner",
      grantToken: "tok-1",
    });
    expect(record.proposal).toBe(proposal);
  });

  it("records rejection fields", () => {
    const store = new InMemoryActionStore();
    store.save(proposal);
    const record = store.markRejected("act-1", "owner", "2026-11-10T08:02:00.000Z");
    expect(record).toMatchObject({
      status: "rejected",
      rejectedBy: "owner",
      rejectedAt: "2026-11-10T08:02:00.000Z",
    });
  });

  it("records the execution result after approval", () => {
    const store = new InMemoryActionStore();
    store.save(proposal);
    store.markApproved("act-1", "owner", "t", "tok-1");
    const result = { actionId: "act-1", kind: "review_reply" as const, outcome: "done", executedAt: "t2" };
    expect(store.markExecuted("act-1", result)).toMatchObject({ status: "executed", result });
  });

  it("throws when transitioning an id it never saw", () => {
    const store = new InMemoryActionStore();
    expect(() => store.markApproved("ghost", "owner", "t", "tok")).toThrow(/No action with id ghost/);
    expect(() => store.markRejected("ghost", "owner", "t")).toThrow(/No action with id ghost/);
    expect(() =>
      store.markExecuted("ghost", { actionId: "ghost", kind: "review_reply", outcome: "x", executedAt: "t" }),
    ).toThrow(/No action with id ghost/);
  });

  it("stores frozen records, so a caller holding one cannot rewrite its status", () => {
    const store = new InMemoryActionStore();
    store.save(proposal);
    const approved = store.markApproved("act-1", "owner", "t", "tok");
    expect(Object.isFrozen(store.get("act-1"))).toBe(true);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(() => {
      (approved as { status: string }).status = "executed";
    }).toThrow(TypeError);
  });

  it("refuses illegal transitions as a second line of defence", () => {
    const store = new InMemoryActionStore();
    store.save(proposal);
    // pending cannot jump straight to executed
    expect(() =>
      store.markExecuted("act-1", { actionId: "act-1", kind: "review_reply", outcome: "x", executedAt: "t" }),
    ).toThrow(/is pending; expected approved/);
    store.markApproved("act-1", "owner", "t", "tok");
    // by default an approved action cannot be approved again or rejected
    expect(() => store.markApproved("act-1", "owner", "t", "tok")).toThrow(/is approved; expected pending/);
    expect(() => store.markRejected("act-1", "owner", "t")).toThrow(/is approved; expected pending/);
  });
});
