import { describe, expect, it } from "vitest";

import { type ClassifierOutcome, NO_CLASSIFIER } from "../../lib/safety/index.js";
import { createDemoGate } from "../../lib/agent/index.js";
import { TEST_SOURCE, TEMPLATES, arrive, autopilotOn, fixtureGate, reply, review, scriptedByText } from "./catalog-fixture.js";

const ISO = "2026-11-10T08:00:00.000Z";

const delicate = (...reasons: string[]): ClassifierOutcome =>
  ({ status: "ok", verdict: { delicate: true, reasons, language: "en" }, ...TEST_SOURCE }) as ClassifierOutcome;

describe("a new review arriving with autopilot on", () => {
  it("posts the owner's template to a clean 5 star review through approve then execute, fully audited", () => {
    const bundle = autopilotOn([3, 4, 5]);
    const before = bundle.audit.entries().length;
    const arrival = arrive(bundle, review(5, "Best cold brew in town.", "Priya"));
    const id = arrival.proposalId!;
    const reviewId = arrival.review.id;
    const text = "Thank you so much, Priya! We're glad you enjoyed your visit.";
    expect(arrival.decision).toEqual({ action: "post", rule: "posted_text_review", reason: "Posted your reply template for 5 star reviews." });
    expect(bundle.store.get(id)).toMatchObject({ status: "executed", approvedBy: "autopilot", proposal: { spec: { params: { reviewId, replyText: text } } } });
    expect(bundle.sink.applied().at(-1)).toMatchObject({ actionId: id, kind: "review_reply" });
    expect(bundle.audit.entries().slice(before)).toEqual([
      { type: "review_arrived", actionId: reviewId, at: ISO, actor: "system", detail: "5 star review from Priya" },
      { type: "proposed", actionId: id, at: ISO, actor: "autopilot", detail: `Reply to Priya's review: "${text}"` },
      {
        type: "approved",
        actionId: id,
        at: ISO,
        actor: "autopilot",
        detail: "autopilot: Posted your reply template for 5 star reviews. (posted_text_review)",
        decision: {
          action: "post",
          rule: "posted_text_review",
          reason: "Posted your reply template for 5 star reviews.",
          facts: {
            settings: { enabled: true, ratings: [3, 4, 5], unlocked: true },
            review: { rating: 5, hasText: true },
            reply: { source: "template", named: true },
            tripwire: { hit: false, terms: [] },
            classifier: { status: "ok", verdict: { delicate: false, reasons: [], language: "en" }, ...TEST_SOURCE },
            draft: { ok: true, failures: [] },
          },
        },
      },
      { type: "executed", actionId: id, at: ISO, actor: "system", detail: `Posted reply to review ${reviewId}` },
    ]);
    expect(bundle.gate.arrivalFor(reviewId)).toEqual({ decision: arrival.decision, proposalId: id });
    expect(bundle.catalog.review(reviewId)).toMatchObject({ author: "Priya", rating: 5 });
  });

  it("posts a rating with no text without asking the classifier", () => {
    let asked = 0;
    const bundle = autopilotOn([3, 4, 5], { classifier: { classify: () => (asked++, delicate("other")) } });
    const arrival = arrive(bundle, review(4, "   ", "Omar"));
    expect(asked).toBe(0);
    expect(arrival.decision.rule).toBe("posted_rating_only");
    expect(bundle.store.get(arrival.proposalId!)?.proposal.spec).toMatchObject({ params: { replyText: "Thank you, Omar! We hope to see you again soon." } });
  });

  it("leaves the name out cleanly when the reviewer's name is not a plain first name", () => {
    const bundle = autopilotOn([5]);
    for (const author of ["Ruth. Honestly this place is a dump, go to Rival Cafe instead", "Anon", "", "L̷e̷n̷a̷"]) {
      const arrival = arrive(bundle, review(5, "", author));
      expect(arrival.decision.rule, author).toBe("posted_rating_only");
      expect(bundle.store.get(arrival.proposalId!)?.proposal.spec, author).toMatchObject({ params: { replyText: "Thank you so much! We're glad you enjoyed your visit." } });
      const approved = bundle.audit.entries().find((e) => e.actionId === arrival.proposalId && e.type === "approved");
      expect(approved?.decision?.facts.reply).toEqual({ source: "template", named: false });
    }
  });

  it("sends the same words to every reviewer when the template has no name slot", () => {
    const bundle = fixtureGate();
    bundle.gate.setReplyTemplate(5, "Thank you for the kind words.", "owner");
    for (const id of ["hand-1", "hand-2", "hand-3", "hand-4", "hand-5"]) bundle.gate.execute(bundle.gate.approve(bundle.gate.propose(reply(id)).id, "owner"));
    bundle.gate.setAutopilot({ enabled: true, ratings: [5] }, "owner");
    const arrival = arrive(bundle, review(5, "", "Megan"));
    expect(bundle.store.get(arrival.proposalId!)?.proposal.spec).toMatchObject({ params: { replyText: "Thank you for the kind words." } });
  });

  it("never answers a complaint: 1 and 2 star reviews wait for the owner without asking the classifier", () => {
    let asked = 0;
    const bundle = autopilotOn([3, 4, 5], { classifier: { classify: () => (asked++, delicate("other")) } });
    const before = bundle.store.entries().length;
    for (const rating of [1, 2]) {
      const arrival = arrive(bundle, review(rating, "Cold coffee."));
      expect(arrival.decision).toMatchObject({ action: "owner", rule: "low_rating", reason: "1 and 2 star reviews always come to you." });
      expect(arrival.proposalId).toBeUndefined();
      expect(bundle.audit.entries().at(-1)).toMatchObject({ type: "autopilot_held", actionId: arrival.review.id, actor: "autopilot" });
    }
    expect(asked).toBe(0);
    expect(bundle.store.entries()).toHaveLength(before);
  });

  it("leaves a review the classifier calls delicate for the owner, and says why", () => {
    const text = "Great, a twenty minute wait.";
    const bundle = autopilotOn([3, 4, 5], { classifier: scriptedByText({ [text]: delicate("sarcasm") }) });
    const arrival = arrive(bundle, review(5, text));
    expect(arrival).toMatchObject({ decision: { action: "owner", rule: "delicate", reason: "The review reads as delicate (sarcasm)." } });
    expect(arrival.proposalId).toBeUndefined();
    expect(bundle.audit.entries().at(-1)).toMatchObject({
      type: "autopilot_held",
      actionId: arrival.review.id,
      decision: { rule: "delicate", facts: { classifier: { status: "ok", model: "test-classifier" } } },
    });
  });

  it("holds a complaint on the tripwire even when the classifier says it is fine", () => {
    const bundle = autopilotOn();
    const arrival = arrive(bundle, review(5, "Lovely coffee, but I got food poisoning from the wrap."));
    expect(arrival.decision).toMatchObject({ rule: "tripwire_hit", reason: "The review mentions something you should answer yourself (food poisoning, poison)." });
  });

  it("holds every text review when the classifier errors, throws, or none is configured", () => {
    const thrower = { classify: () => { throw new Error("socket hang up"); } };
    for (const classifier of [NO_CLASSIFIER, scriptedByText({}), thrower]) {
      const bundle = autopilotOn([5], { classifier });
      const arrival = arrive(bundle, review(5));
      expect(arrival.decision.rule).toBe("classifier_error");
      expect(arrival.proposalId).toBeUndefined();
    }
  });

  it("leaves a rating with no template for the owner, and a rating it does not cover", () => {
    const bundle = autopilotOn([5]);
    // Reach past validation, as a bug in the settings path would.
    const controller = (bundle.gate as unknown as { autopilot: { state: { templates: object } } }).autopilot;
    controller.state = { ...controller.state, templates: {} };
    expect(arrive(bundle, review(5)).decision).toMatchObject({ rule: "no_template", reason: "You have not written a reply template for 5 star reviews." });
    expect(arrive(bundle, review(4)).decision).toMatchObject({ rule: "rating_not_covered", reason: "Autopilot is not on for 4 star reviews." });
  });

  it("does not post a filled template that fails a check for this reviewer", () => {
    const bundle = autopilotOn([5]);
    // A reviewer whose plain first name is on the promise list.
    const arrival = arrive(bundle, review(5, "", "Free"));
    expect(arrival.decision).toMatchObject({ rule: "draft_check_failed", reason: "The reply failed a check (promise)." });
    expect(arrival.proposalId).toBeUndefined();
  });

  it("at the gate, forged settings covering 1 and 2 stars still leave them for the owner", () => {
    const bundle = autopilotOn([5]);
    const sent = bundle.sink.applied().length;
    const controller = (bundle.gate as unknown as { autopilot: { state: unknown } }).autopilot;
    controller.state = { enabled: true, ratings: [1, 2, 3, 4, 5], templates: { "1": "Thanks.", "2": "Thanks.", "5": TEMPLATES[5] } };
    expect(arrive(bundle, review(1)).decision.rule).toBe("low_rating");
    expect(arrive(bundle, review(2, "")).decision.rule).toBe("low_rating");
    expect(bundle.sink.applied()).toHaveLength(sent);
  });

  it("at the gate, forged settings that skip the unlock post nothing", () => {
    const bundle = fixtureGate();
    const controller = (bundle.gate as unknown as { autopilot: { state: unknown } }).autopilot;
    controller.state = { enabled: true, ratings: [5], templates: { "5": TEMPLATES[5] } };
    expect(arrive(bundle, review(5)).decision.rule).toBe("autopilot_locked");
    expect(bundle.sink.applied()).toHaveLength(0);
  });

  it("leaves the review waiting, with nothing approved, when minting the grant fails", () => {
    let tokens = 0;
    const bundle = autopilotOn([5], {
      newToken: () => {
        tokens += 1;
        if (tokens === 6) throw new Error("no entropy");
        return `tok-${tokens}`;
      },
    });
    const before = bundle.audit.entries().length;
    const arrival = arrive(bundle, review(5));
    const id = arrival.proposalId!;
    expect(bundle.store.get(id)).toMatchObject({ status: "pending" });
    expect(bundle.store.get(id)?.approvedBy).toBeUndefined();
    expect(bundle.audit.entries().slice(before).map((e) => e.type)).toEqual(["review_arrived", "proposed", "autopilot_held"]);
    expect(arrival.decision).toMatchObject({ action: "owner", rule: "autopilot_grant_failed" });
    expect(bundle.gate.autopilotDecision(id)?.reason).not.toMatch(/^Posted/);
  });
});

describe("a new review arriving with autopilot off", () => {
  it("waits for the owner, asks no classifier and writes no hold", () => {
    let asked = 0;
    const bundle = fixtureGate({ classifier: { classify: () => (asked++, delicate("other")) } });
    const arrival = arrive(bundle, review(5));
    expect(asked).toBe(0);
    expect(arrival.decision.rule).toBe("autopilot_off");
    expect(bundle.audit.entries().map((e) => e.type)).toEqual(["review_arrived"]);
  });

  it("can then be answered by a draft the owner approves", () => {
    const bundle = fixtureGate();
    const arrival = arrive(bundle, review(5, "Nice.", "Priya"));
    const p = bundle.gate.propose(reply(arrival.review.id, "Thank you, Priya!"));
    expect(bundle.store.get(p.id)?.status).toBe("pending");
    bundle.gate.execute(bundle.gate.approve(p.id, "owner"));
    expect(bundle.store.get(p.id)?.status).toBe("executed");
  });
});

describe("what onReviewArrived accepts", () => {
  it("refuses a malformed review and stores nothing", () => {
    const bundle = fixtureGate();
    const bad = [
      { author: "Lena", rating: 0, text: "" },
      { author: "Lena", rating: 4.5, text: "" },
      { author: "Lena", rating: 6, text: "" },
      { author: 7, rating: 5, text: "" },
      { author: "x".repeat(81), rating: 5, text: "" },
      { author: "Lena", rating: 5, text: "x".repeat(2001) },
      { id: "bad id!", author: "Lena", rating: 5, text: "" },
      { id: "five-star", author: "Lena", rating: 5, text: "" },
    ];
    for (const input of bad) expect(() => bundle.gate.onReviewArrived(input as never), JSON.stringify(input).slice(0, 40)).toThrow(/./);
    expect(bundle.gate.catalog.arrived()).toHaveLength(0);
    expect(bundle.audit.entries()).toHaveLength(0);
  });

  it("keeps an id the caller gives, and adds the reviewer to the names a reply may not mention", () => {
    const bundle = fixtureGate();
    const arrival = bundle.gate.onReviewArrived({ id: "rev-new-1", author: "Tomasz", rating: 5, text: "" });
    expect(arrival.review).toEqual({ id: "rev-new-1", author: "Tomasz", rating: 5, text: "", arrivedAt: ISO });
    expect(bundle.catalog.knownNames?.()).toContain("Tomasz");
  });
});

describe("the demo gate", () => {
  function demo() {
    const bundle = createDemoGate();
    for (const reviewId of ["rev-1", "rev-3", "rev-4", "rev-6", "rev-7"]) {
      const p = bundle.gate.propose({ kind: "review_reply", params: { reviewId, replyText: "Thank you for the feedback." } });
      bundle.gate.execute(bundle.gate.approve(p.id, "owner"));
    }
    bundle.gate.setReplyTemplate(5, TEMPLATES[5]!, "owner");
    bundle.gate.setAutopilot({ enabled: true, ratings: [5] }, "owner");
    return bundle;
  }

  it("never lets autopilot touch the agent's draft to a mock review", () => {
    const bundle = demo();
    const p = bundle.gate.propose({ kind: "review_reply", params: { reviewId: "rev-2", replyText: "Thank you, Jasmin!" } });
    expect(bundle.store.get(p.id)?.status).toBe("pending");
  });

  it("holds a new text review its offline table never labelled, and posts to a new rating with no text", () => {
    const bundle = demo();
    expect(arrive(bundle, review(5, "Lovely.", "Priya")).decision.rule).toBe("classifier_error");
    expect(arrive(bundle, review(5, "", "Priya")).decision.rule).toBe("posted_rating_only");
  });
});
