import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { type LlmClient, type LlmResponse } from "../../lib/agent/index.js";
import { Budget, FatalApiError, InfraApiError, PRICING, badRequestReason, costUsd, fatalReason, infraReason, pricingFor } from "../../lib/eval/live-cost.js";
import {
  DRY_RUN_EFFORT,
  DryRunLlm,
  type ReportSink,
  fileSink,
  parseMaxUsd,
  perRunFromReport,
  runLiveEval,
  selectOnly,
  writeAtomic,
} from "../../lib/eval/live-run.js";
import { crit } from "../../lib/eval/live-criteria.js";
import { FakeJudge, type Judge, type JudgeInput, type JudgeResult } from "../../lib/eval/live-judge.js";
import { ALL_LIVE_SCENARIOS, LIVE_SCENARIOS, type LiveScenario } from "../../lib/eval/live-scenarios.js";

const pricing = PRICING["claude-sonnet-5-5"]!;
const headers = new Headers();
const body = (type: string, message: string) => ({ type: "error", error: { type, message } });

const scenario = (id: string): LiveScenario => ({ id, category: "analysis", question: `q ${id}`, why: "fixture", expect: { class: "answer" } });
const scenarios = ["a", "b", "c", "d", "e"].map(scenario);

// Answers every question with plain text and a fixed, known cost.
class FixedLlm implements LlmClient {
  calls = 0;
  constructor(
    private readonly usage = { inputTokens: 10_000, outputTokens: 1_000 },
    private readonly failOnCall?: { call: number; error: unknown },
  ) {}
  async respond(): Promise<LlmResponse> {
    this.calls += 1;
    if (this.failOnCall && this.calls === this.failOnCall.call) throw this.failOnCall.error;
    return { stop: "end", blocks: [{ type: "text", text: "An answer." }], usage: this.usage };
  }
}

function memorySink(): ReportSink & { writes: { markdown: string; json: string }[] } {
  const writes: { markdown: string; json: string }[] = [];
  return { writes, write: (markdown, json) => writes.push({ markdown, json }) };
}

const base = {
  reps: 1,
  concurrency: 1,
  model: "m",
  set: "dev" as const,
  pricing,
  now: () => new Date("2026-11-10T20:00:00Z"),
  retryPauseMs: 0,
  judgeMeta: { mode: "off" as const },
};

// A judge that passes or fails every criterion with a real quote, or throws.
class ScriptedJudge implements Judge {
  readonly model = "scripted";
  calls = 0;
  constructor(
    private readonly pass: boolean,
    private readonly errors: readonly unknown[] = [],
    private readonly quote?: string,
  ) {}
  async judge(input: JudgeInput): Promise<JudgeResult> {
    this.calls += 1;
    const error = this.errors[this.calls - 1];
    if (error) throw error;
    return {
      verdicts: input.criteria.map((c) => ({
        id: c.id,
        type: c.type,
        text: c.text,
        verdict: this.quote === undefined ? (this.pass ? "pass" : "fail") : "judge_error",
        evidence: this.quote ?? input.answer,
      })),
      usage: { inputTokens: 100_000, outputTokens: 0 },
    };
  }
}

const judged = (id: string): LiveScenario => ({
  id,
  category: "refuse",
  question: `q ${id}`,
  why: "fixture",
  expect: { class: "answer", criteria: [crit("limits", "Says it cannot do that.")] },
});

describe("pricing", () => {
  it("prices plain input, cache reads, cache writes and output separately, per million tokens", () => {
    // 1M plain input $2, 1M cache read $0.20, 1M cache write $2.50, 1M output $10.
    expect(costUsd({ inputTokens: 3_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, pricing)).toBeCloseTo(14.7);
    expect(pricingFor("claude-sonnet-5-5")).toBe(pricing);
    expect(pricingFor("toString")).toBeUndefined();
  });

  it("starts a run only while spent plus the expected cost of runs in flight stays under the cap", () => {
    const budget = new Budget(1, pricing, 0.4);
    expect(budget.tryStart()).toBe(true);
    expect(budget.tryStart()).toBe(true);
    expect(budget.tryStart()).toBe(false); // 3 x 0.4 > 1
    budget.record({ inputTokens: 100_000, outputTokens: 0 }); // $0.20
    budget.finish(0.2);
    expect(budget.spentUsd).toBeCloseTo(0.2);
    expect(budget.perRunUsd).toBeCloseTo(0.2); // the observed average replaces the assumption
    expect(budget.running).toBe(1);
  });

  it("starts a run that would bring the projected spend exactly to the cap, and none past it", () => {
    const budget = new Budget(1, pricing, 0.5);
    expect(budget.tryStart()).toBe(true);
    expect(budget.tryStart()).toBe(true); // 0.5 + 0.5 = 1.0, not over
    expect(budget.tryStart()).toBe(false);
  });

  it("does not charge a running run's spend twice, as spent and inside its estimate", () => {
    const budget = new Budget(1, pricing, 0.4);
    expect(budget.tryStart()).toBe(true);
    budget.record({ inputTokens: 150_000, outputTokens: 0 }); // $0.30 of that run's $0.40 estimate
    // 0.30 spent + 0.10 still expected + 0.40 for the new run = 0.80, under the cap.
    expect(budget.tryStart()).toBe(true);
    // A third would make 1.20.
    expect(budget.tryStart()).toBe(false);
  });

  it("counts cache reads and writes once: they are part of inputTokens, priced at their own rate", () => {
    // 10k input of which 8k read from cache and 1k written: 1k plain.
    const usage = { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 8_000, cacheWriteTokens: 1_000 };
    expect(costUsd(usage, pricing)).toBeCloseTo((1_000 * 2 + 8_000 * 0.2 + 1_000 * 2.5) / 1_000_000, 10);
  });
});

describe("fatalReason", () => {
  it("names the errors after which no call can succeed", () => {
    expect(fatalReason(new Anthropic.AuthenticationError(401, body("authentication_error", "bad key"), "bad key", headers))).toBe("authentication failed (401)");
    expect(fatalReason(new Anthropic.PermissionDeniedError(403, body("permission_error", "no"), "no", headers))).toBe("permission denied (403)");
    expect(fatalReason(Anthropic.APIError.generate(402, body("billing_error", "pay"), "pay", headers))).toBe("billing error (402)");
    const credit = "Your credit balance is too low to access the Anthropic API.";
    expect(fatalReason(new Anthropic.BadRequestError(400, body("invalid_request_error", credit), credit, headers))).toBe("credit balance too low (400)");
    expect(fatalReason(Anthropic.APIError.generate(529, body("overloaded_error", "busy"), "busy", headers))).toBe("API still overloaded after retries (529)");
    expect(fatalReason(new Anthropic.NotFoundError(404, body("not_found_error", "model: x"), "model: x", headers))).toBe("model or endpoint not found (404)");
    expect(fatalReason(new Anthropic.APIConnectionError({ message: "down" }))).toBeUndefined();
    expect(infraReason(new Anthropic.APIConnectionError({ message: "down" }))).toBe("the API could not be reached");
    expect(fatalReason(new FatalApiError("custom"))).toBe("custom");
  });

  it("leaves an ordinary failure to be scored as the run's own", () => {
    expect(fatalReason(new Anthropic.BadRequestError(400, body("invalid_request_error", "bad tool"), "bad tool", headers))).toBeUndefined();
    expect(fatalReason(new Anthropic.InternalServerError(500, body("api_error", "oops"), "oops", headers))).toBeUndefined();
    expect(fatalReason(new Error("anything"))).toBeUndefined();
  });
});

describe("infraReason", () => {
  it("classifies a server error that outlasted the retries as infrastructure, not the model's failure", () => {
    expect(infraReason(new Anthropic.InternalServerError(500, body("api_error", "oops"), "oops", headers))).toBe("server error after retries (500)");
    expect(infraReason(Anthropic.APIError.generate(503, body("api_error", "down"), "down", headers))).toBe("server error after retries (503)");
    expect(infraReason(new InfraApiError("custom"))).toBe("custom");
    expect(infraReason(new Anthropic.RateLimitError(429, body("rate_limit_error", "slow"), "slow", headers))).toBe("still rate limited after retries (429)");
    expect(fatalReason(new Anthropic.RateLimitError(429, body("rate_limit_error", "slow"), "slow", headers))).toBeUndefined();
  });

  it("reads a malformed-request reason from a 400 only", () => {
    expect(badRequestReason(new Anthropic.BadRequestError(400, body("invalid_request_error", "bad shape"), "bad shape", headers))).toBe("bad shape");
    expect(badRequestReason(new Anthropic.InternalServerError(500, body("api_error", "oops"), "oops", headers))).toBeUndefined();
    expect(badRequestReason(new Error("bad shape"))).toBeUndefined();
  });

  it("leaves 529 to the fatal path and anything else to scoring", () => {
    expect(infraReason(Anthropic.APIError.generate(529, body("overloaded_error", "busy"), "busy", headers))).toBeUndefined();
    expect(infraReason(new Anthropic.BadRequestError(400, body("invalid_request_error", "bad"), "bad", headers))).toBeUndefined();
    expect(infraReason(new Error("boom"))).toBeUndefined();
  });
});

// Throws the given error on the listed calls and answers the rest.
class FlakyLlm implements LlmClient {
  calls = 0;
  constructor(
    private readonly failOn: ReadonlySet<number>,
    private readonly error: unknown,
  ) {}
  async respond(): Promise<LlmResponse> {
    this.calls += 1;
    if (this.failOn.has(this.calls)) throw this.error;
    return { stop: "end", blocks: [{ type: "text", text: "An answer." }], usage: { inputTokens: 10_000, outputTokens: 1_000 } };
  }
}

const serverError = () => new Anthropic.InternalServerError(500, body("api_error", "oops"), "oops", headers);
const rateLimited = () => new Anthropic.RateLimitError(429, body("rate_limit_error", "slow"), "slow", headers);

describe("runLiveEval", () => {
  it("retries a server error once, and counts it as infrastructure when the retry fails too", async () => {
    const sink = memorySink();
    // b fails on call 2 and on its retry, call 3.
    const result = await runLiveEval({ ...base, scenarios, llm: new FlakyLlm(new Set([2, 3]), serverError()), maxUsd: 50, perRunUsd: 0.03, sink });
    expect(result.aborted).toBeUndefined();
    expect(result.runs.filter((r) => r.skipped === "infra").map((r) => r.id)).toEqual(["b"]);
    expect(result.reports.filter((r) => r.summary.status === "red")).toHaveLength(0);
    expect(result.reports.filter((r) => r.summary.status === "green")).toHaveLength(4);
    const last = sink.writes.at(-1)!;
    expect(last.markdown).toContain("Infrastructure errors (API server errors after retries, neither passed nor failed): 1");
    expect(last.markdown).not.toContain("Skipped runs (never started");
    expect(last.markdown).not.toContain("INCOMPLETE");
    expect(JSON.parse(last.json)).toMatchObject({ infraErrors: 1, skippedRuns: 1, ranRuns: 4 });
  });

  it("passes a scenario whose retry succeeds, with nothing counted against it", async () => {
    const result = await runLiveEval({ ...base, scenarios, llm: new FlakyLlm(new Set([2]), serverError()), maxUsd: 50, perRunUsd: 0.03, sink: memorySink() });
    expect(result.runs.every((r) => r.skipped === undefined)).toBe(true);
    expect(result.reports.every((r) => r.summary.status === "green")).toBe(true);
  });

  it("does not abort on three server errors that are not in a row, since a success resets the streak", async () => {
    // a fails twice (1, 2), b passes (3), c fails twice (4, 5), d passes (6), e fails twice (7, 8).
    const result = await runLiveEval({ ...base, scenarios, llm: new FlakyLlm(new Set([1, 2, 4, 5, 7, 8]), serverError()), maxUsd: 50, perRunUsd: 0.03, sink: memorySink() });
    expect(result.aborted).toBeUndefined();
    expect(result.runs.filter((r) => r.skipped === "infra").map((r) => r.id)).toEqual(["a", "c", "e"]);
  });

  it("scores a malformed request as the run's failure, and aborts after three of them", async () => {
    const malformed = new Anthropic.BadRequestError(400, body("invalid_request_error", "messages: bad shape"), "messages: bad shape", headers);
    const one = await runLiveEval({ ...base, scenarios, llm: new FlakyLlm(new Set([1]), malformed), maxUsd: 50, perRunUsd: 0.03, sink: memorySink() });
    expect(one.aborted).toBeUndefined();
    expect(one.reports.filter((r) => r.summary.status === "red")).toHaveLength(1);
    const many = await runLiveEval({ ...base, scenarios, llm: new FlakyLlm(new Set([1, 2, 3, 4, 5]), malformed), maxUsd: 50, perRunUsd: 0.03, sink: memorySink() });
    expect(many.aborted).toMatch(/^3 requests rejected as malformed \(400\)/);
    expect(many.runs.filter((r) => r.skipped === "aborted").length).toBeGreaterThan(0);
  });

  it("aborts after three server errors in a row, retries included, and skips the rest", async () => {
    const sink = memorySink();
    const result = await runLiveEval({ ...base, scenarios, llm: new FlakyLlm(new Set([1, 2, 3, 4, 5, 6]), serverError()), maxUsd: 50, perRunUsd: 0.03, sink });
    expect(result.aborted).toBe("3 API errors in a row after retries (last: server error after retries (500))");
    expect(result.runs.filter((r) => r.skipped === "infra")).toHaveLength(3);
    expect(result.runs.filter((r) => r.skipped === "aborted")).toHaveLength(2);
    expect(result.reports.filter((r) => r.summary.status === "red")).toHaveLength(0);
    expect(sink.writes.at(-1)!.markdown).toContain("**INCOMPLETE: aborted because 3 API errors in a row");
  });

  it("retries a 429 once after a pause instead of aborting the run", async () => {
    const result = await runLiveEval({ ...base, scenarios, llm: new FlakyLlm(new Set([1]), rateLimited()), maxUsd: 50, perRunUsd: 0.03, sink: memorySink() });
    expect(result.aborted).toBeUndefined();
    expect(result.runs.every((r) => r.skipped === undefined)).toBe(true);
  });

  it("counts a 429 that survives the retry as infrastructure, and aborts only on several in a row", async () => {
    const once = await runLiveEval({ ...base, scenarios, llm: new FlakyLlm(new Set([1, 2]), rateLimited()), maxUsd: 50, perRunUsd: 0.03, sink: memorySink() });
    expect(once.aborted).toBeUndefined();
    expect(once.runs.filter((r) => r.skipped === "infra").map((r) => r.id)).toEqual(["a"]);
    const many = await runLiveEval({ ...base, scenarios, llm: new FlakyLlm(new Set([1, 2, 3, 4, 5, 6]), rateLimited()), maxUsd: 50, perRunUsd: 0.03, sink: memorySink() });
    expect(many.aborted).toBe("3 API errors in a row after retries (last: still rate limited after retries (429))");
  });

  it("waits the pause before the retry", async () => {
    const started = Date.now();
    await runLiveEval({ ...base, retryPauseMs: 60, scenarios: scenarios.slice(0, 1), llm: new FlakyLlm(new Set([1]), rateLimited()), maxUsd: 50, perRunUsd: 0.03, sink: memorySink() });
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("stops starting runs at the spending cap and reports the rest as skipped, neither red nor green", async () => {
    // Each run costs 10k x $2/M + 1k x $10/M = $0.03.
    const sink = memorySink();
    const result = await runLiveEval({ ...base, scenarios, llm: new FixedLlm(), maxUsd: 0.07, perRunUsd: 0.03, sink });
    expect(result.runs.filter((r) => r.skipped === undefined)).toHaveLength(2);
    expect(result.runs.filter((r) => r.skipped === "budget")).toHaveLength(3);
    expect(result.costUsd).toBeCloseTo(0.06);
    const statuses = result.reports.map((r) => r.summary.status);
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(3);
    const last = sink.writes.at(-1)!;
    expect(last.markdown).toContain("**INCOMPLETE: stopped at the spending cap.**");
    expect(last.markdown).toContain("2 green, 0 flaky, 0 red, 3 skipped");
    expect(last.markdown).toContain("- c: 1 run(s) skipped (budget)");
    expect(JSON.parse(last.json)).toMatchObject({ ranRuns: 2, skippedRuns: 3, maxUsd: 0.07, incomplete: "stopped at the spending cap" });
  });

  it("runs rep by rep, so a cap hit still leaves every scenario with a first run", async () => {
    const sink = memorySink();
    const result = await runLiveEval({ ...base, reps: 2, scenarios, llm: new FixedLlm(), maxUsd: 0.19, perRunUsd: 0.03, sink });
    expect(result.reports.map((r) => r.summary.reps)).toEqual([2, 1, 1, 1, 1]);
    expect(sink.writes.at(-1)!.markdown).toContain("5 scenarios × 2 rep(s) = 10 runs, 6 finished");
  });

  it("waits for runs in flight rather than skipping, when their real cost leaves room", async () => {
    const sink = memorySink();
    // The estimate ($1 a run) is far above the real cost, so only the first run fits it.
    const result = await runLiveEval({ ...base, concurrency: 3, scenarios, llm: new FixedLlm(), maxUsd: 1.5, perRunUsd: 1, sink });
    expect(result.runs.every((r) => r.skipped === undefined)).toBe(true);
  });

  it("aborts on a fatal API error, does not score it as a model failure, and labels the report", async () => {
    const auth = new Anthropic.AuthenticationError(401, body("authentication_error", "bad key"), "bad key", headers);
    const sink = memorySink();
    const result = await runLiveEval({ ...base, scenarios, llm: new FixedLlm(undefined, { call: 3, error: auth }), maxUsd: 50, perRunUsd: 0.03, sink });
    expect(result.aborted).toBe("authentication failed (401)");
    expect(result.runs.filter((r) => r.skipped === undefined)).toHaveLength(2);
    // The run the error hit had started, so it is cut off, not never started.
    expect(result.runs.filter((r) => r.skipped === "cut_off")).toHaveLength(1);
    expect(result.runs.filter((r) => r.skipped === "aborted")).toHaveLength(2);
    expect(result.reports.filter((r) => r.summary.status === "red")).toHaveLength(0);
    const last = sink.writes.at(-1)!;
    expect(last.markdown).toContain("**INCOMPLETE: aborted because authentication failed (401).**");
    expect(JSON.parse(last.json).incomplete).toBe("aborted because authentication failed (401)");
    expect(last.markdown).toContain("Runs cut off mid-run by a fatal API error (tokens spent and counted in the spend, not scored): 1");
    expect(last.markdown).toContain("Skipped runs (never started, neither passed nor failed): 2");
  });

  it("keeps every finished run's answer and proposal texts in the JSON report", async () => {
    const sink = memorySink();
    await runLiveEval({ ...base, reps: 2, scenarios: scenarios.slice(0, 1), llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink });
    const [row] = JSON.parse(sink.writes.at(-1)!.json).reports;
    expect(row.runs).toHaveLength(2);
    for (const run of row.runs) {
      expect(run).toEqual({ failures: expect.any(Array), text: expect.any(String), proposalKinds: [], proposalTexts: [], status: ["No change was proposed."] });
      expect(run.text).not.toBe("");
    }
  });

  it("scores an ordinary error as a failed run and carries on", async () => {
    const result = await runLiveEval({
      ...base,
      scenarios,
      llm: new FixedLlm(undefined, { call: 2, error: new Error("boom") }),
      maxUsd: 50,
      perRunUsd: 0.03,
      sink: memorySink(),
    });
    expect(result.aborted).toBeUndefined();
    expect(result.reports[1]!.summary).toMatchObject({ status: "red", failures: ["threw: boom"] });
    expect(result.reports.filter((r) => r.summary.status === "green")).toHaveLength(4);
  });

  it("rewrites a valid report after every finished run", async () => {
    const sink = memorySink();
    await runLiveEval({ ...base, scenarios, llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink });
    expect(sink.writes).toHaveLength(scenarios.length + 1);
    expect(sink.writes.map((w) => JSON.parse(w.json).ranRuns)).toEqual([1, 2, 3, 4, 5, 5]);
  });

  it("runs every dev scenario end to end against the dry-run model, with no key and no network", async () => {
    const sink = memorySink();
    const llm = new DryRunLlm();
    const result = await runLiveEval({ ...base, concurrency: 8, scenarios: LIVE_SCENARIOS, llm, maxUsd: 55, perRunUsd: 0.1, sink, dryRun: true });
    expect(result.reports).toHaveLength(LIVE_SCENARIOS.length);
    expect(result.runs.every((r) => r.skipped === undefined)).toBe(true);
    expect(llm.calls).toBeGreaterThanOrEqual(LIVE_SCENARIOS.length);
    expect(result.costUsd).toBe(0);
    expect(JSON.parse(sink.writes.at(-1)!.json)).toMatchObject({ ranRuns: LIVE_SCENARIOS.length, skippedRuns: 0 });
  }, 30_000);

  it("reports a dry run as $0 spent and never prices its synthetic tokens", async () => {
    const sink = memorySink();
    const result = await runLiveEval({ ...base, scenarios, llm: new DryRunLlm(), maxUsd: 55, perRunUsd: 0.1, sink, dryRun: true });
    expect(result.costUsd).toBe(0);
    const last = sink.writes.at(-1)!;
    expect(last.markdown).toContain("Spend: $0.00 of a $55.00 cap");
    expect(last.markdown).toContain("Dry run: no model was called. Its token counts are synthetic, so no cost is shown for them.");
    expect(last.markdown).not.toMatch(/estimat/i);
    expect(JSON.parse(last.json)).toMatchObject({ costUsd: 0, dryRun: true });
    expect(JSON.parse(last.json)).not.toHaveProperty("estimatedUsd");
  });

  it("records the effort level next to the model, and n/a for a dry run", async () => {
    const real = memorySink();
    await runLiveEval({ ...base, scenarios, effort: "medium", llm: new DryRunLlm(), maxUsd: 55, perRunUsd: 0.1, sink: real });
    expect(real.writes.at(-1)!.markdown).toContain("Model: `m` · effort: medium · set:");
    expect(JSON.parse(real.writes.at(-1)!.json)).toMatchObject({ model: "m", effort: "medium" });
    const dry = memorySink();
    await runLiveEval({ ...base, scenarios, effort: "high", llm: new DryRunLlm(), maxUsd: 55, perRunUsd: 0.1, sink: dry, dryRun: true });
    expect(dry.writes.at(-1)!.markdown).toContain(`· effort: ${DRY_RUN_EFFORT} ·`);
    expect(JSON.parse(dry.writes.at(-1)!.json)).toMatchObject({ effort: "n/a (dry run)" });
  });
});

describe("the judge in a live run", () => {
  // $2 per million input tokens: each judge call costs $0.20.
  const judgeStep = (judge: Judge) => ({ judge, priceUsd: (u: { inputTokens: number }) => (u.inputTokens * 2) / 1_000_000 });
  const two = [judged("x"), judged("y")];

  it("fails a run on a failed criterion and shows the criterion and its evidence quote", async () => {
    const sink = memorySink();
    const result = await runLiveEval({ ...base, scenarios: two, llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink, judgeStep: judgeStep(new ScriptedJudge(false)) });
    expect(result.reports.every((r) => r.summary.status === "red")).toBe(true);
    expect(result.reports[0]!.summary.failures).toEqual(['judge [limits] failed "Says it cannot do that." (evidence: "An answer.")']);
    const last = sink.writes.at(-1)!;
    expect(last.markdown).toContain('judge ✗ [limits] Says it cannot do that. (evidence: "An answer.")');
    expect(JSON.parse(last.json).reports[0].runs[0].judge[0]).toMatchObject({ verdict: "fail", evidence: "An answer." });
  });

  it("passes a run the code and the judge both pass, and leaves scenarios without criteria unjudged", async () => {
    const judge = new ScriptedJudge(true);
    const result = await runLiveEval({ ...base, scenarios: [...two, scenario("plain")], llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink: memorySink(), judgeStep: judgeStep(judge) });
    expect(result.reports.every((r) => r.summary.status === "green")).toBe(true);
    expect(judge.calls).toBe(2);
  });

  it("counts the judge's spend toward the cap and reports it apart", async () => {
    const sink = memorySink();
    // Each run: $0.03 for the model, $0.20 for the judge.
    const result = await runLiveEval({ ...base, scenarios: two, llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.23, sink, judgeStep: judgeStep(new ScriptedJudge(true)) });
    expect(result.costUsd).toBeCloseTo(0.46);
    expect(result.judgeCostUsd).toBeCloseTo(0.4);
    expect(sink.writes.at(-1)!.markdown).toContain("Spend: $0.46 ($0.40 of it the judge) of a $50.00 cap");
    const capped = await runLiveEval({ ...base, scenarios: two, llm: new FixedLlm(), maxUsd: 0.3, perRunUsd: 0.23, sink: memorySink(), judgeStep: judgeStep(new ScriptedJudge(true)) });
    expect(capped.runs.filter((r) => r.skipped === "budget")).toHaveLength(1);
  });

  it("retries a judge server error once, then counts it as infrastructure and keeps the answer", async () => {
    const sink = memorySink();
    const judge = new ScriptedJudge(true, [serverError(), serverError()]);
    const result = await runLiveEval({ ...base, scenarios: two, llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink, judgeStep: judgeStep(judge) });
    expect(result.runs.map((r) => r.skipped)).toEqual(["infra", undefined]);
    expect(result.reports[0]!.summary.status).toBe("skipped");
    expect(JSON.parse(sink.writes.at(-1)!.json).reports[0].runs[0]).toMatchObject({ text: "An answer.", unscored: "infra" });
  });

  // Expects a proposal, so the plain answer fails the code checks.
  const codeFailing = (id: string): LiveScenario => ({ ...judged(id), expect: { class: "propose", criteria: [crit("limits", "Says it cannot do that.")] } });

  it("never sends a run the code checks failed to the judge, so a judge error cannot un-score it", async () => {
    const sink = memorySink();
    const judge = new ScriptedJudge(true, [serverError(), serverError(), serverError(), serverError()]);
    const result = await runLiveEval({ ...base, scenarios: [codeFailing("x"), codeFailing("y")], llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink, judgeStep: judgeStep(judge) });
    expect(judge.calls).toBe(0);
    expect(result.runs.map((r) => r.skipped)).toEqual([undefined, undefined]);
    expect(result.reports.map((r) => r.summary.status)).toEqual(["red", "red"]);
    expect(result.reports[0]!.summary.failures).toEqual(["expected a proposal, got none"]);
  });

  it("does not send a run that threw to the judge", async () => {
    const judge = new ScriptedJudge(true);
    const result = await runLiveEval({ ...base, scenarios: [judged("x")], llm: new FlakyLlm(new Set([1]), new Error("boom")), maxUsd: 50, perRunUsd: 0.03, sink: memorySink(), judgeStep: judgeStep(judge) });
    expect(judge.calls).toBe(0);
    expect(result.reports[0]!.summary.status).toBe("red");
  });

  it("aborts on a fatal judge error, never scoring it against the model", async () => {
    const auth = new Anthropic.AuthenticationError(401, body("authentication_error", "bad key"), "bad key", headers);
    const result = await runLiveEval({ ...base, scenarios: two, llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink: memorySink(), judgeStep: judgeStep(new ScriptedJudge(true, [auth])) });
    expect(result.aborted).toBe("judge: authentication failed (401)");
    expect(result.reports.filter((r) => r.summary.status === "red")).toHaveLength(0);
  });

  it("leaves a run unjudged, neither pass nor fail, when a verdict has no verifiable quote", async () => {
    const sink = memorySink();
    const result = await runLiveEval({ ...base, scenarios: two, llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink, judgeStep: judgeStep(new ScriptedJudge(true, [], "not in the answer")) });
    expect(result.runs.every((r) => r.skipped === "unjudged")).toBe(true);
    expect(result.reports.every((r) => r.summary.status === "skipped")).toBe(true);
    expect(sink.writes.at(-1)!.markdown).toContain("Unjudged runs (code checks passed, the judge could not return a verified verdict; neither passed nor failed): 2");
  });

  it("fails a run whose judge fails one criterion and errors on another, rather than leaving it unjudged", async () => {
    const twoCriteria: LiveScenario = { ...judged("x"), expect: { class: "answer", criteria: [crit("limits", "Says it cannot do that."), crit("reading", "Names the item asked about.")] } };
    const mixed: Judge = {
      model: "mixed",
      judge: async (input) => ({
        verdicts: input.criteria.map((c, i) => ({ id: c.id, type: c.type, text: c.text, verdict: i === 0 ? ("fail" as const) : ("judge_error" as const), evidence: input.answer })),
      }),
    };
    const result = await runLiveEval({ ...base, scenarios: [twoCriteria], llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink: memorySink(), judgeStep: judgeStep(mixed) });
    expect(result.runs[0]!.skipped).toBeUndefined();
    expect(result.reports[0]!.summary.status).toBe("red");
    expect(result.reports[0]!.summary.failures).toEqual(['judge [limits] failed "Says it cannot do that." (evidence: "An answer.")']);
  });

  it("stamps how behaviour was graded at the top of the report", async () => {
    const off = memorySink();
    await runLiveEval({ ...base, scenarios: two, llm: new FixedLlm(), maxUsd: 50, perRunUsd: 0.03, sink: off });
    expect(off.writes.at(-1)!.markdown).toContain("Behaviour: NOT GRADED (EVAL_JUDGE=off)");
    const unvalidated = memorySink();
    await runLiveEval({
      ...base,
      scenarios: two,
      llm: new FixedLlm(),
      maxUsd: 50,
      perRunUsd: 0.03,
      sink: unvalidated,
      judgeStep: judgeStep(new ScriptedJudge(true)),
      judgeMeta: { mode: "unvalidated", model: "claude-sonnet-5-5", promptHash: "p1", criteriaHash: "c1", reason: "the judge prompt changed" },
    });
    expect(unvalidated.writes.at(-1)!.markdown).toContain("**UNVALIDATED JUDGE** (EVAL_JUDGE=unvalidated): no passing judge check backs these verdicts (the judge prompt changed).");
    expect(JSON.parse(unvalidated.writes.at(-1)!.json).judge).toEqual({
      mode: "unvalidated",
      model: "claude-sonnet-5-5",
      promptHash: "p1",
      criteriaHash: "c1",
      reason: "the judge prompt changed",
    });
  });

  it("passes no scenario but small talk in a dry run of every set with the fake judge", async () => {
    const result = await runLiveEval({
      ...base,
      concurrency: 8,
      scenarios: ALL_LIVE_SCENARIOS,
      llm: new DryRunLlm(),
      maxUsd: 55,
      perRunUsd: 0.1,
      sink: memorySink(),
      dryRun: true,
      judgeStep: { judge: new FakeJudge(), priceUsd: () => 0 },
      judgeMeta: { mode: "fake" },
    });
    const passed = result.reports.filter((r) => r.summary.status === "green" && r.scenario.category !== "smalltalk").map((r) => r.scenario.id);
    expect(passed).toEqual([]);
    expect(result.costUsd).toBe(0);
  }, 30_000);
});

describe("report files", () => {
  it("writes atomically, leaving no temporary file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "counter-eval-"));
    const path = join(dir, "r.json");
    writeAtomic(path, "{}");
    writeAtomic(path, '{"ok":true}');
    expect(readFileSync(path, "utf8")).toBe('{"ok":true}');
    expect(readdirSync(dir)).toEqual(["r.json"]);
    const sink = fileSink(join(dir, "r.md"), path);
    sink.write("# md", "{}");
    expect(existsSync(join(dir, "r.md"))).toBe(true);
  });
});

describe("pre-flight helpers", () => {
  it("takes the per-run cost from an earlier report, never from one that spent nothing or a broken file", () => {
    expect(perRunFromReport(JSON.stringify({ costUsd: 0.3, ranRuns: 3 }))).toBeCloseTo(0.1);
    expect(perRunFromReport(JSON.stringify({ costUsd: 0, ranRuns: 3 }))).toBeUndefined();
    expect(perRunFromReport("not json")).toBeUndefined();
    expect(perRunFromReport(undefined)).toBeUndefined();
    const sonnet = JSON.stringify({ model: "claude-sonnet-5-5", effort: "medium", costUsd: 0.3, ranRuns: 3 });
    expect(perRunFromReport(sonnet, "claude-sonnet-5-5", "medium")).toBeCloseTo(0.1);
    expect(perRunFromReport(sonnet, "claude-opus-5-5", "medium")).toBeUndefined();
    expect(perRunFromReport(sonnet, "claude-sonnet-5-5", "high")).toBeUndefined();
  });

  it("takes the judge's share out of an earlier report's per-run cost, whether it had a judge or not", () => {
    expect(perRunFromReport(JSON.stringify({ costUsd: 0.9, judgeCostUsd: 0.3, ranRuns: 3 }))).toBeCloseTo(0.2);
    // A judge-off report still writes judgeCostUsd, as 0.
    expect(perRunFromReport(JSON.stringify({ costUsd: 0.6, judgeCostUsd: 0, ranRuns: 3 }))).toBeCloseTo(0.2);
    expect(perRunFromReport(JSON.stringify({ costUsd: 0.3, judgeCostUsd: 0.3, ranRuns: 3 }))).toBeUndefined();
  });

  it("selects EVAL_ONLY ids once each and names the unknown ones", () => {
    expect(selectOnly(scenarios, " a, c ,zz,a")).toEqual({ scenarios: [scenarios[0], scenarios[2]], unknown: ["zz"] });
  });

  it("parses EVAL_MAX_USD", () => {
    expect(parseMaxUsd(undefined, 55)).toBe(55);
    expect(parseMaxUsd("12.5", 55)).toBe(12.5);
    for (const bad of ["0", "-1", "abc", "Infinity"]) expect(parseMaxUsd(bad, 55)).toBeUndefined();
  });
});
