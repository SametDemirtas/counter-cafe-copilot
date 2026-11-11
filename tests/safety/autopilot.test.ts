import { describe, expect, it } from "vitest";

import {
  type ActionSpec,
  AUTOPILOT_RATINGS,
  HandlerRegistry,
  InMemoryActionStore,
  PolicyRejection,
  humanApprovedReplies,
  isValidApprover,
  priceChangeHandler,
} from "../../lib/safety/index.js";
import { TEMPLATES, approveRepliesByHand, arrive, autopilotOn, fixtureGate, reply, review, switchableReplyHandler } from "./catalog-fixture.js";

const ISO = "2026-11-10T08:00:00.000Z";
const priceRise: ActionSpec = {
  kind: "price_change",
  params: { sku: "avocado_toast", currentPriceMinor: 780, proposedPriceMinor: 850, currency: "GBP" },
};

function ruleOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof PolicyRejection ? error.rule : `not a policy rejection: ${String(error)}`;
  }
  return undefined;
}

describe("autopilot settings", () => {
  it("starts off and locked, with no replies approved and no templates", () => {
    const { gate } = fixtureGate();
    expect(gate.autopilotStatus()).toEqual({ enabled: false, ratings: [], templates: {}, approvedReplies: 0, required: 5, unlocked: false });
  });

  it("derives the eligible ratings from the lowest one allowed", () => {
    expect(AUTOPILOT_RATINGS).toEqual([3, 4, 5]);
  });

  it("refuses to switch on before 5 replies were posted by hand, and changes nothing", () => {
    const bundle = fixtureGate();
    approveRepliesByHand(bundle, 4);
    bundle.gate.setReplyTemplate(5, TEMPLATES[5]!, "owner");
    const auditBefore = bundle.audit.entries().length;
    expect(ruleOf(() => bundle.gate.setAutopilot({ enabled: true, ratings: [5] }, "owner"))).toBe("autopilot_locked");
    expect(bundle.gate.autopilotStatus()).toMatchObject({ enabled: false, approvedReplies: 4, unlocked: false });
    expect(bundle.audit.entries()).toHaveLength(auditBefore);
  });

  it("can switch on only the ratings the owner wrote a template for", () => {
    const bundle = fixtureGate();
    approveRepliesByHand(bundle, 5);
    bundle.gate.setReplyTemplate(5, TEMPLATES[5]!, "owner");
    expect(ruleOf(() => bundle.gate.setAutopilot({ enabled: true, ratings: [4, 5] }, "owner"))).toBe("autopilot_no_template");
    expect(() => bundle.gate.setAutopilot({ enabled: true, ratings: [4, 5] }, "owner")).toThrow(/write a reply template for 4 star reviews/);
    expect(bundle.gate.autopilotStatus().enabled).toBe(false);
    expect(bundle.gate.setAutopilot({ enabled: true, ratings: [5] }, "owner")).toMatchObject({ enabled: true, ratings: [5] });
  });

  it("counts one per review: approvals of replies to the same review cannot farm the unlock", () => {
    // Built straight in the store, as if the gate's one-reply rule were missing.
    const store = new InMemoryActionStore();
    for (let i = 0; i < 5; i++) {
      const id = `same-${i}`;
      store.save({ id, spec: reply("two-star", `x${i}`), summary: "s", proposedAt: ISO });
      store.markApproved(id, "owner", ISO, `tok-${i}`);
      store.markExecuted(id, { actionId: id, kind: "review_reply", outcome: "posted", executedAt: ISO });
    }
    expect(humanApprovedReplies(store)).toBe(1);
  });

  it("counts only replies a human approved and that were posted: not prices, rejections, failed sends or autopilot's own", () => {
    const replies = switchableReplyHandler();
    const bundle = fixtureGate({ handlers: new HandlerRegistry().register(priceChangeHandler).register(replies.handler) });
    const { gate } = bundle;
    approveRepliesByHand(bundle, 4);
    gate.reject(gate.propose(reply("three-star")).id, "owner");
    gate.execute(gate.approve(gate.propose(priceRise).id, "owner"));
    replies.setDown(true);
    const failing = gate.approve(gate.propose(reply("hand-5")).id, "owner");
    expect(() => gate.execute(failing)).toThrow(/reviews API down/);
    expect(gate.autopilotStatus().approvedReplies).toBe(4);

    replies.setDown(false);
    gate.execute(failing);
    expect(gate.autopilotStatus().approvedReplies).toBe(5);
    gate.setReplyTemplate(5, TEMPLATES[5]!, "owner");
    gate.setAutopilot({ enabled: true, ratings: [5] }, "owner");
    const auto = arrive(bundle, review(5));
    expect(bundle.store.get(auto.proposalId!)?.approvedBy).toBe("autopilot");
    expect(gate.autopilotStatus().approvedReplies).toBe(5);
  });

  it("never covers 1 or 2 star reviews, even when switching off", () => {
    const bundle = fixtureGate();
    approveRepliesByHand(bundle, 5);
    expect(ruleOf(() => bundle.gate.setAutopilot({ enabled: true, ratings: [1, 5] }, "owner"))).toBe("autopilot_rating");
    expect(ruleOf(() => bundle.gate.setAutopilot({ enabled: true, ratings: [2] }, "owner"))).toBe("autopilot_rating");
    expect(ruleOf(() => bundle.gate.setAutopilot({ enabled: false, ratings: [2] }, "owner"))).toBe("autopilot_rating");
    expect(ruleOf(() => bundle.gate.setAutopilot({ enabled: true, ratings: [6] }, "owner"))).toBe("autopilot_rating");
    expect(ruleOf(() => bundle.gate.setReplyTemplate(2, "Thank you.", "owner"))).toBe("autopilot_rating");
    expect(bundle.gate.autopilotStatus().enabled).toBe(false);
  });

  it("needs at least one rating to switch on", () => {
    const bundle = fixtureGate();
    approveRepliesByHand(bundle, 5);
    expect(ruleOf(() => bundle.gate.setAutopilot({ enabled: true, ratings: [] }, "owner"))).toBe("autopilot_no_ratings");
  });

  it("takes a human approver only, and records every change with the templates in the audit log", () => {
    const bundle = fixtureGate();
    approveRepliesByHand(bundle, 5);
    expect(isValidApprover("autopilot")).toBe(false);
    expect(() => bundle.gate.setAutopilot({ enabled: true, ratings: [5] }, "autopilot")).toThrow(/not a valid approver/);
    expect(() => bundle.gate.setReplyTemplate(5, "Thanks!", " Autopilot ")).toThrow(/not a valid approver/);
    bundle.gate.setReplyTemplate(4, TEMPLATES[4]!, "Sam");
    bundle.gate.setReplyTemplate(5, TEMPLATES[5]!, "Sam");
    expect(bundle.audit.entries().at(-1)).toEqual({
      type: "autopilot_changed",
      actionId: "settings",
      at: ISO,
      actor: "Sam",
      detail: "reply template for 5 star reviews saved",
      autopilot: { enabled: false, ratings: [], templates: { "4": TEMPLATES[4], "5": TEMPLATES[5] } },
    });
    const status = bundle.gate.setAutopilot({ enabled: true, ratings: [5, 4, 5] }, "Sam");
    expect(status).toMatchObject({ enabled: true, ratings: [4, 5], approvedReplies: 5, required: 5, unlocked: true });
    expect(bundle.audit.entries().at(-1)).toMatchObject({
      actor: "Sam",
      detail: "autopilot on for 4, 5 star reviews",
      autopilot: { enabled: true, ratings: [4, 5], templates: { "4": TEMPLATES[4], "5": TEMPLATES[5] } },
    });
    bundle.gate.setAutopilot({ enabled: false, ratings: [] }, "Sam");
    expect(bundle.audit.entries().at(-1)).toMatchObject({ detail: "autopilot off", autopilot: { enabled: false, ratings: [] } });
  });

  it("a human cannot approve as autopilot", () => {
    const { gate } = fixtureGate();
    const p = gate.propose(reply("five-star"));
    expect(() => gate.approve(p.id, "autopilot")).toThrow(/not a valid approver/);
  });
});

describe("saving a reply template", () => {
  it("refuses a template that fails a check, says why, and keeps the old one", () => {
    const bundle = fixtureGate();
    bundle.gate.setReplyTemplate(5, TEMPLATES[5]!, "owner");
    const before = bundle.audit.entries().length;
    const tries: Array<[string, RegExp]> = [
      ["Thanks {name}! Enjoy 10% off next time.", /no digits/],
      ["Thanks, {name}! Your next coffee is free.", /no offers or promises/],
      ["Thanks! See www.rival.example", /no links/],
      ["Thanks! Mail us at hi@cafe.example", /no email addresses/],
      ["Thanks, {name}! Follow @counter", /no @handles/],
      ["Thanks, {name}! Priya says hi.", /no names of staff or other customers/],
      ["{name}, thank you!", /use \{name\} at most once, after a word/],
      ["Thanks, {name} and {name}!", /use \{name\} at most once/],
      ["Thanks, {first}!", /no other braces/],
      ["Thanks, {name}s!", /after a word/],
    ];
    for (const [text, why] of tries) {
      let error: unknown;
      try {
        bundle.gate.setReplyTemplate(5, text, "owner");
      } catch (e) {
        error = e;
      }
      expect(error, text).toBeInstanceOf(PolicyRejection);
      expect((error as PolicyRejection).rule).toBe("autopilot_template");
      expect((error as PolicyRejection).message, text).toMatch(why);
    }
    expect(ruleOf(() => bundle.gate.setReplyTemplate(5, `Thank you, {name}! ${"x".repeat(260)}`, "owner"))).toBe("autopilot_template");
    expect(bundle.gate.autopilotStatus().templates).toEqual({ "5": TEMPLATES[5] });
    expect(bundle.audit.entries()).toHaveLength(before);
  });

  it("stores the template trimmed, and empty text removes it unless autopilot is on for that rating", () => {
    const bundle = autopilotOn([5]);
    bundle.gate.setReplyTemplate(4, "  Thank you, {name}!  ", "owner");
    expect(bundle.gate.autopilotStatus().templates["4"]).toBe("Thank you, {name}!");
    bundle.gate.setReplyTemplate(4, "", "owner");
    expect(bundle.gate.autopilotStatus().templates).not.toHaveProperty("4");
    expect(ruleOf(() => bundle.gate.setReplyTemplate(5, "", "owner"))).toBe("autopilot_template_in_use");
    bundle.gate.setAutopilot({ enabled: false, ratings: [] }, "owner");
    bundle.gate.setReplyTemplate(5, "", "owner");
    expect(bundle.gate.autopilotStatus().templates).toEqual({});
  });

  it("can be written while autopilot is still locked", () => {
    const bundle = fixtureGate();
    expect(bundle.gate.setReplyTemplate(3, TEMPLATES[3]!, "owner")).toMatchObject({ unlocked: false, templates: { "3": TEMPLATES[3] } });
  });
});

describe("drafts the agent proposes", () => {
  it("always wait for the owner, even for a rating autopilot covers", () => {
    const bundle = autopilotOn([3, 4, 5]);
    const p = bundle.gate.propose(reply("five-star", "Thanks, Sam!"));
    expect(bundle.store.get(p.id)).toMatchObject({ status: "pending", proposal: { spec: { params: { replyText: "Thanks, Sam!" } } } });
    expect(bundle.gate.autopilotDecision(p.id)).toBeUndefined();
    expect(bundle.audit.entries().at(-1)).toMatchObject({ type: "proposed", actor: "agent" });
    const price = bundle.gate.propose(priceRise);
    expect(bundle.store.get(price.id)?.status).toBe("pending");
  });

  it("are refused for a review autopilot already answered", () => {
    const bundle = autopilotOn([5]);
    const arrival = arrive(bundle, review(5));
    expect(ruleOf(() => bundle.gate.propose(reply(arrival.review.id, "And again!")))).toBe("already_replied");
    expect(bundle.sink.applied().filter((c) => c.description === `Posted reply to review ${arrival.review.id}`)).toHaveLength(1);
  });

  it("refuse a second reply to a review a human already answered, but allow one after a rejection", () => {
    const { gate } = fixtureGate();
    gate.execute(gate.approve(gate.propose(reply("three-star")).id, "owner"));
    expect(ruleOf(() => gate.propose(reply("three-star")))).toBe("already_replied");
    gate.reject(gate.propose(reply("four-star")).id, "owner");
    expect(() => gate.propose(reply("four-star"))).not.toThrow();
  });
});

describe("a reply autopilot approved but could not send", () => {
  function failedSend() {
    const replies = switchableReplyHandler();
    const env = autopilotOn([5], { handlers: new HandlerRegistry().register(priceChangeHandler).register(replies.handler) });
    replies.setDown(true);
    const arrival = arrive(env, review(5));
    replies.setDown(false);
    return { ...env, id: arrival.proposalId!, arrival, setDown: replies.setDown };
  }

  it("stays approved, audits the failure and waits for the owner", () => {
    const { store, audit, gate, id, arrival } = failedSend();
    expect(store.get(id)).toMatchObject({ status: "approved", approvedBy: "autopilot" });
    expect(gate.awaitingRetry(id)).toBe(true);
    expect(audit.entries().filter((e) => e.actionId === id).map((e) => [e.type, e.actor, e.detail])).toEqual([
      ["proposed", "autopilot", `Reply to Lena's review: "Thank you so much, Lena! We're glad you enjoyed your visit."`],
      ["approved", "autopilot", "autopilot: Posted your reply template for 5 star reviews. (posted_text_review)"],
      ["execution_failed", "system", "reviews API down"],
    ]);
    const failed = { action: "post", rule: "posted_text_review", reason: "Autopilot approved this reply, but sending it failed. Send it yourself or withdraw it." };
    expect(gate.autopilotDecision(id)).toEqual(failed);
    expect(arrival.decision).toEqual(failed);
  });

  it("a retry while autopilot still covers it records the human as the approver", () => {
    const { store, audit, gate, sink, id } = failedSend();
    const grant = gate.approve(id, "Sam");
    expect(grant.approvedBy).toBe("Sam");
    gate.execute(grant);
    expect(store.get(id)).toMatchObject({ status: "executed", approvedBy: "Sam" });
    expect(audit.entries().filter((e) => e.actionId === id && e.type === "approved").at(-1)).toMatchObject({
      actor: "Sam",
      detail: "retry of a reply autopilot could not send; autopilot still covers 5 star reviews",
    });
    expect(sink.applied().filter((c) => c.actionId === id)).toHaveLength(1);
    expect(gate.awaitingRetry(id)).toBe(false);
    expect(() => gate.approve(id, "Sam")).toThrow(/is executed; only a pending action can be approved/);
  });

  it("a retry after autopilot was switched off is an explicit human approval", () => {
    const { audit, gate, id } = failedSend();
    gate.setAutopilot({ enabled: false, ratings: [] }, "owner");
    gate.execute(gate.approve(id, "owner"));
    expect(audit.entries().filter((e) => e.actionId === id && e.type === "approved").at(-1)).toMatchObject({
      actor: "owner",
      detail: "approved by hand: autopilot no longer covers this reply",
    });
  });

  it("can be rejected by the owner, and then sends nothing", () => {
    const { store, audit, gate, sink, id } = failedSend();
    gate.reject(id, "owner");
    expect(store.get(id)).toMatchObject({ status: "rejected", rejectedBy: "owner" });
    expect(audit.entries().at(-1)).toMatchObject({ type: "rejected", actor: "owner", detail: "withdrew a reply autopilot could not send" });
    expect(gate.awaitingRetry(id)).toBe(false);
    expect(sink.applied().some((c) => c.actionId === id)).toBe(false);
  });

  it("lets the owner withdraw a reply after sending it themselves failed too", () => {
    const { store, audit, gate, sink, id, setDown } = failedSend();
    setDown(true);
    expect(() => gate.execute(gate.approve(id, "owner"))).toThrow(/reviews API down/);
    gate.reject(id, "owner");
    expect(store.get(id)?.status).toBe("rejected");
    expect(audit.entries().at(-1)).toMatchObject({ type: "rejected", actor: "owner", detail: "withdrew an approval by owner; the action never ran" });
    expect(sink.applied().some((c) => c.actionId === id)).toBe(false);
  });
});
