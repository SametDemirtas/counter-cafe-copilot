import { describe, expect, it } from "vitest";

import {
  AUTOPILOT_RULES,
  type AutopilotDecision,
  type AutopilotFacts,
  type AutopilotRuleId,
  decideAutopilot,
} from "../../lib/safety/index.js";

const ON = { enabled: true, ratings: [3, 4, 5], unlocked: true };
const OK_VERDICT = { status: "ok", verdict: { delicate: false, reasons: [], language: "en" }, model: "m", promptHash: "h" };
const CLEAN = { hit: false, terms: [] };
const PASSED = { ok: true, failures: [] };

const text: AutopilotFacts = {
  settings: ON,
  review: { rating: 5, hasText: true },
  reply: { source: "template", named: true },
  tripwire: CLEAN,
  classifier: OK_VERDICT,
  draft: PASSED,
};
const blank: AutopilotFacts = {
  settings: ON,
  review: { rating: 5, hasText: false },
  reply: { source: "template", named: true },
  draft: PASSED,
};

const cases: ReadonlyArray<readonly [string, AutopilotFacts | undefined, AutopilotRuleId]> = [
  ["a clean text review", text, "posted_text_review"],
  ["a rating-only review with a banked reply", blank, "posted_rating_only"],

  ["no facts at all", undefined, "no_settings"],
  ["facts that are not an object", "post" as never, "no_settings"],
  ["no settings", { ...text, settings: undefined }, "no_settings"],
  ["settings with a string for enabled", { ...text, settings: { ...ON, enabled: "yes" as never } }, "no_settings"],
  ["settings without unlocked", { ...text, settings: { enabled: true, ratings: [5] } as never }, "no_settings"],
  ["autopilot off", { ...text, settings: { ...ON, enabled: false } }, "autopilot_off"],
  ["autopilot not unlocked", { ...text, settings: { ...ON, unlocked: false } }, "autopilot_locked"],

  ["no review", { ...text, review: undefined }, "no_review"],
  ["a rating of 0", { ...text, review: { rating: 0, hasText: true } }, "no_review"],
  ["a rating of 6", { ...text, review: { rating: 6, hasText: true } }, "no_review"],
  ["a fractional rating", { ...text, review: { rating: 4.5, hasText: true } }, "no_review"],
  ["hasText missing", { ...text, review: { rating: 5 } as never }, "no_review"],
  ["a 1 star review, even in the settings", { ...text, settings: { ...ON, ratings: [1, 2, 3, 4, 5] }, review: { rating: 1, hasText: true } }, "low_rating"],
  ["a 2 star rating-only review", { ...blank, settings: { ...ON, ratings: [2, 5] }, review: { rating: 2, hasText: false } }, "low_rating"],
  ["a rating the owner did not pick", { ...text, settings: { ...ON, ratings: [4] } }, "rating_not_covered"],
  ["no reply source", { ...text, reply: undefined }, "no_reply_source"],
  ["an unknown reply source", { ...text, reply: { source: "model" as never } }, "no_reply_source"],

  ["rating-only with no template for the rating", { ...blank, reply: { source: "no_template" }, draft: undefined }, "no_template"],
  ["rating-only with a template that left the name out", { ...blank, reply: { source: "template", named: false } }, "posted_rating_only"],
  ["rating-only without a draft check", { ...blank, draft: undefined }, "no_draft_check"],
  ["rating-only whose filled template failed a check", { ...blank, draft: { ok: false, failures: ["digit"] } }, "draft_check_failed"],

  ["a clean text review with no template for the rating", { ...text, reply: { source: "no_template" }, draft: undefined }, "no_template"],
  ["a clean text review whose reviewer name was left out", { ...text, reply: { source: "template", named: false } }, "posted_text_review"],
  ["a reply from the old bank of reused replies", { ...text, reply: { source: "bank" as never } }, "no_reply_source"],
  ["the agent's own draft as the reply", { ...text, reply: { source: "draft" as never } }, "no_reply_source"],
  ["no tripwire result", { ...text, tripwire: undefined }, "no_tripwire"],
  ["a malformed tripwire result", { ...text, tripwire: { hit: "no" } }, "no_tripwire"],
  ["a tripwire hit", { ...text, tripwire: { hit: true, terms: ["sick"] } }, "tripwire_hit"],
  ["no classifier outcome", { ...text, classifier: undefined }, "no_classifier"],
  ["a classifier error", { ...text, classifier: { status: "error", error: "timed out" } }, "classifier_error"],
  ["a classifier status nobody knows", { ...text, classifier: { ...OK_VERDICT, status: "maybe" } }, "classifier_unreadable"],
  ["a verdict with an unknown reason", { ...text, classifier: { ...OK_VERDICT, verdict: { delicate: false, reasons: ["happy"], language: "en" } } }, "classifier_unreadable"],
  ["a verdict with an extra field", { ...text, classifier: { ...OK_VERDICT, verdict: { delicate: false, reasons: [], language: "en", safe: true } } }, "classifier_unreadable"],
  ["a verdict with delicate as a string", { ...text, classifier: { ...OK_VERDICT, verdict: { delicate: "false", reasons: [], language: "en" } } }, "classifier_unreadable"],
  ["a verdict with no model", { ...text, classifier: { ...OK_VERDICT, model: "" } }, "classifier_unreadable"],
  ["a verdict with no prompt hash", { ...text, classifier: { status: "ok", verdict: OK_VERDICT.verdict, model: "m" } }, "classifier_unreadable"],
  ["a delicate verdict", { ...text, classifier: { ...OK_VERDICT, verdict: { delicate: true, reasons: ["hygiene"], language: "en" } } }, "delicate"],
  ["not delicate but with a reason", { ...text, classifier: { ...OK_VERDICT, verdict: { delicate: false, reasons: ["sarcasm"], language: "en" } } }, "delicate"],
  ["no draft check", { ...text, draft: undefined }, "no_draft_check"],
  ["a draft check that contradicts itself", { ...text, draft: { ok: true, failures: ["digit"] } }, "no_draft_check"],
  ["a passed draft check that still lists a non-text failure", { ...text, draft: { ok: true, failures: [42] } }, "no_draft_check"],
  ["a draft check with odd failures", { ...text, draft: { ok: false, failures: [3] } }, "no_draft_check"],
  ["a failed draft check", { ...text, draft: { ok: false, failures: ["promise"] } }, "draft_check_failed"],
];

describe("decideAutopilot", () => {
  it.each(cases)("%s", (_name, facts, rule) => {
    const decision = decideAutopilot(facts);
    expect(decision.rule).toBe(rule);
    expect(decision.action).toBe(rule.startsWith("posted_") ? "post" : "owner");
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("covers every rule it can return", () => {
    // Set by the gate after deciding, never by decideAutopilot itself.
    const gateOnly: readonly AutopilotRuleId[] = ["autopilot_grant_failed", "autopilot_post_refused"];
    const seen = new Set(cases.map(([, , rule]) => rule));
    expect([...seen].sort()).toEqual(AUTOPILOT_RULES.filter((r) => !gateOnly.includes(r)).sort());
  });

  it("names the review's problem first when a delicate review also has no template", () => {
    const facts = { ...text, reply: { source: "no_template" as const }, classifier: { ...OK_VERDICT, verdict: { delicate: true, reasons: ["hygiene"], language: "en" } } };
    expect(decideAutopilot(facts).rule).toBe("delicate");
  });

  it("explains a delicate verdict in plain words", () => {
    const facts = { ...text, classifier: { ...OK_VERDICT, verdict: { delicate: true, reasons: ["illness_or_allergy", "stars_text_mismatch"], language: "de" } } };
    expect(decideAutopilot(facts).reason).toBe("The review reads as delicate (illness or allergy, stars and text disagree).");
  });

  it("does not change the facts it reads, and returns a frozen decision", () => {
    const facts = structuredClone(text);
    const decision: AutopilotDecision = decideAutopilot(facts);
    expect(facts).toEqual(text);
    expect(Object.isFrozen(decision)).toBe(true);
  });
});
