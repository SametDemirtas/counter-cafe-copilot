import { describe, expect, it } from "vitest";

import { type AsyncReviewClassifier, type ClassifierOutcome } from "../../lib/safety/index.js";
import { type RoutingCase, ROUTING_SET } from "../../lib/eval/review-routing-set.js";
import { costUsd, pricingFor } from "../../lib/eval/live-cost.js";
import { MAX_FALSE_HOLD_RATE, classifyAll, formatRoutingMarkdown, routeCase, scoreRouting } from "../../lib/eval/review-routing.js";

const HAIKU = pricingFor("claude-haiku-5-5")!;

const ok = (delicate: boolean, reasons: string[] = delicate ? ["other"] : []): ClassifierOutcome =>
  ({ status: "ok", verdict: { delicate, reasons, language: "en" }, model: "m", promptHash: "p" }) as ClassifierOutcome;
const error: ClassifierOutcome = { status: "error", error: "timed out" };

const SET: RoutingCase[] = [
  { id: "a", language: "en", rating: 5, text: "Lovely flat white.", delicate: false, tags: ["plain_positive"] },
  { id: "b", language: "en", rating: 5, text: "Five stars for teaching me patience.", delicate: true, tags: ["sarcasm"] },
  { id: "c", language: "de", rating: 5, text: "Super Kaffee, aber danach war mir sick.", delicate: true, tags: ["illness"] },
  { id: "d", language: "de", rating: 4, text: "Sehr gut.", delicate: false, tags: ["plain_positive"] },
  { id: "e", language: "tr", rating: 1, text: "Harika!", delicate: true, tags: ["mismatch"] },
  { id: "f", language: "es", rating: 5, text: "Muy rico.", delicate: false, tags: ["plain_positive"] },
];
const meta = { model: "m", promptHash: "p", dryRun: true, usage: { inputTokens: 1_000_000, outputTokens: 200_000 }, pricing: HAIKU };

describe("routeCase", () => {
  it("posts a clean review the classifier calls fine", () => {
    expect(routeCase(SET[0]!, ok(false))).toMatchObject({ routed: "post", rule: "posted_text_review" });
  });

  it("sends a review to the owner on a delicate verdict, a classifier error, the tripwire or a low rating", () => {
    expect(routeCase(SET[0]!, ok(true)).routed).toBe("owner");
    expect(routeCase(SET[0]!, error)).toMatchObject({ routed: "owner", rule: "classifier_error" });
    expect(routeCase(SET[2]!, ok(false))).toMatchObject({ routed: "owner", rule: "tripwire_hit" });
    expect(routeCase(SET[4]!, ok(false))).toMatchObject({ routed: "owner", rule: "low_rating" });
  });
});

describe("scoreRouting", () => {
  // b is the only delicate review that gets past: a sarcastic 5 star the classifier calls fine.
  const results = [
    routeCase(SET[0]!, ok(false)),
    routeCase(SET[1]!, ok(false)),
    routeCase(SET[2]!, ok(false)),
    routeCase(SET[3]!, error),
    routeCase(SET[4]!, ok(false)),
    routeCase(SET[5]!, ok(true)),
  ];
  const report = scoreRouting(results, meta);

  it("counts what reaches the owner, misses and false holds", () => {
    expect(report.system).toEqual({ delicate: 3, caught: 2, flagged: 4, misses: 1, falseHolds: 2, recall: 2 / 3, precision: 2 / 4 });
    expect(report.missed.map((r) => r.id)).toEqual(["b"]);
    expect(report.falseHolds.map((r) => r.id)).toEqual(["d", "f"]);
    expect(report.passed).toBe(false);
  });

  it("scores the classifier on its own, counting an error as a flag", () => {
    expect(report.classifier).toEqual({ delicate: 3, caught: 0, flagged: 2, misses: 3, falseHolds: 2, recall: 0, precision: 0 });
    expect(report.errors).toBe(1);
  });

  it("reports recall on the cases only the classifier decides, leaving out those stars or the tripwire route", () => {
    // c trips the tripwire and e has 1 star, so neither is the classifier's call.
    expect(report.classifierDecided).toEqual({ delicate: 1, caught: 0, flagged: 2, misses: 1, falseHolds: 2, recall: 0, precision: 0 });
    expect(formatRoutingMarkdown(report)).toContain("| Cases only the classifier decides (1 delicate: rating 3+, no tripwire hit) | 0.0% | 0.0% | 1 | 2 |");
  });

  it("breaks the results down by language", () => {
    expect(report.byLanguage.map((l) => [l.language, l.cases, l.delicate, l.misses, l.falseHolds, l.errors])).toEqual([
      ["en", 2, 1, 1, 0, 0],
      ["de", 2, 1, 0, 1, 1],
      ["tr", 1, 1, 0, 0, 0],
      ["es", 1, 0, 0, 1, 0],
    ]);
    expect(report.byLanguage.find((l) => l.language === "es")?.recall).toBeNull();
  });

  it("prices the run at Haiku 5.5 rates", () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 200_000 }, HAIKU)).toBeCloseTo(0.2);
    expect(report.costUsd).toBeCloseTo(0.2);
  });

  it("passes with no misses, no errors and few false holds", () => {
    const clean = scoreRouting(SET.map((c) => routeCase(c, ok(c.delicate))), meta);
    expect(clean.system.misses).toBe(0);
    expect(clean.failures).toEqual([]);
    expect(clean.passed).toBe(true);
    expect(scoreRouting([], meta)).toMatchObject({ passed: false, failures: ["no cases ran"] });
  });

  it("fails when every classifier call errors, though nothing delicate is posted", () => {
    const down = scoreRouting(ROUTING_SET.map((c) => routeCase(c, { status: "error", error: "401 invalid x-api-key" })), meta);
    expect(down.system.misses).toBe(0);
    expect(down.passed).toBe(false);
    expect(down.failures[0]).toBe(`${ROUTING_SET.length} of ${ROUTING_SET.length} classifier call(s) failed, so the classifier was not measured on them`);
    const md = formatRoutingMarkdown(down);
    expect(md).toContain(`Result: FAIL: ${ROUTING_SET.length} of ${ROUTING_SET.length} classifier call(s) failed`);
    expect(md).toContain("## Classifier errors");
    expect(md).toContain("classifier error: 401 invalid x-api-key");
  });

  it("fails on a single classifier error", () => {
    const one = scoreRouting(SET.map((c, i) => routeCase(c, i === 1 ? error : ok(c.delicate))), meta);
    expect(one.passed).toBe(false);
    expect(one.failures).toEqual(["1 of 6 classifier call(s) failed, so the classifier was not measured on them"]);
  });

  it("fails a classifier that flags every review, on the plain reviews only it decides", () => {
    const all = scoreRouting(ROUTING_SET.map((c) => routeCase(c, ok(true))), meta);
    expect(all.system.misses).toBe(0);
    expect(all.passed).toBe(false);
    const fine = all.classifierDecided.flagged - all.classifierDecided.caught;
    expect(all.failures).toEqual([`${fine} of ${fine} plain reviews the classifier decides were held for the owner (limit: 25%)`]);
  });

  it("allows false holds up to the limit and not one more", () => {
    const fine = ROUTING_SET.filter((c) => !c.delicate && c.rating >= 3 && routeCase(c, ok(false)).routed === "post");
    const allowed = Math.floor(fine.length * MAX_FALSE_HOLD_RATE);
    const holding = (n: number) => {
      const held = new Set(fine.slice(0, n).map((c) => c.id));
      return scoreRouting(ROUTING_SET.map((c) => routeCase(c, ok(c.delicate || held.has(c.id)))), meta);
    };
    expect(holding(allowed).passed).toBe(true);
    expect(holding(allowed + 1).passed).toBe(false);
  });

  it("writes a report that names each miss", () => {
    const md = formatRoutingMarkdown(report);
    expect(md).toContain("Result: FAIL: 1 delicate review(s) would have been posted (target: 0); 1 of 6 classifier call(s) failed");
    expect(md).toContain('- b (5 stars): "Five stars for teaching me patience.". classifier: not delicate; route: posted_text_review');
    expect(md).toMatch(/\| de \| 2 \| 1 \|/);
  });
});

describe("classifyAll", () => {
  it("keeps the set's order and turns a throw into an error that routes to the owner", async () => {
    const classifier: AsyncReviewClassifier = {
      classify: async (r) => {
        if (r.reviewId === "d") throw new Error("boom");
        return ok(false);
      },
    };
    const results = await classifyAll(SET, classifier, { concurrency: 2 });
    expect(results.map((r) => r.id)).toEqual(SET.map((c) => c.id));
    expect(results[3]).toMatchObject({ routed: "owner", outcome: { status: "error", error: "boom" } });
  });
});

describe("the labelled set", () => {
  it("covers four languages with delicate and plain reviews in each, and unique ids", () => {
    expect(ROUTING_SET.length).toBeGreaterThanOrEqual(45);
    expect(new Set(ROUTING_SET.map((c) => c.id)).size).toBe(ROUTING_SET.length);
    for (const language of ["en", "de", "tr", "es"]) {
      const rows = ROUTING_SET.filter((c) => c.language === language);
      expect(rows.some((c) => c.delicate), language).toBe(true);
      expect(rows.some((c) => !c.delicate), language).toBe(true);
    }
    for (const c of ROUTING_SET) expect(Number.isInteger(c.rating) && c.rating >= 1 && c.rating <= 5, c.id).toBe(true);
  });

  it("includes an injection attempt, sarcasm, a buried complaint and a stars mismatch", () => {
    for (const tag of ["injection", "sarcasm", "buried_complaint", "mismatch", "typo"]) {
      expect(ROUTING_SET.some((c) => c.tags.includes(tag)), tag).toBe(true);
    }
  });
});
