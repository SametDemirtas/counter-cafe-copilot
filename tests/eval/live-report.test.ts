import { describe, expect, it } from "vitest";

import { type LiveScenario } from "../../lib/eval/live-scenarios.js";
import {
  type RepRun,
  aggregate,
  buildJson,
  buildMarkdown,
  parsePositiveInt,
  totalUsage,
  truncate,
} from "../../lib/eval/live-report.js";
import { LIVE_SCENARIOS, LIVE_SCENARIOS_OWNER } from "../../lib/eval/live-scenarios.js";
import { LIVE_SCENARIOS_HELDOUT } from "../../lib/eval/live-scenarios-heldout.js";
import { parseEvalSet, scenariosFor } from "../../lib/eval/live-sets.js";

const scenarioA: LiveScenario = { id: "a", category: "analysis", question: "qa", why: "fixture", expect: { class: "answer" } };
const scenarioB: LiveScenario = { id: "b", category: "refuse", question: "qb", why: "fixture", expect: { class: "refuse" } };
const clean = { proposalKinds: [], executed: 0, escalated: 0, notPending: 0 };

const run = (id: string, failures: string[], text: string): RepRun => ({ id, failures, outcome: { text, ...clean } });

describe("parsePositiveInt", () => {
  it("falls back when unset or blank and accepts a positive integer", () => {
    expect(parsePositiveInt(undefined, 8)).toBe(8);
    expect(parsePositiveInt("  ", 8)).toBe(8);
    expect(parsePositiveInt("3", 8)).toBe(3);
  });

  it("rejects anything that would silently produce zero runs", () => {
    for (const bad of ["abc", "0", "-2", "1.5", "NaN"]) expect(parsePositiveInt(bad, 8)).toBeUndefined();
  });
});

describe("aggregate", () => {
  it("groups runs by scenario id and samples a failing answer when there is one", () => {
    const reports = aggregate(
      [scenarioA, scenarioB],
      [run("a", [], "good"), run("b", [], "fine"), run("a", ["missing x"], "bad"), run("b", [], "fine 2")],
    );
    expect(reports[0]!.summary).toMatchObject({ reps: 2, passes: 1, status: "flaky" });
    expect(reports[0]!.sample).toBe("bad");
    expect(reports[1]!.summary.status).toBe("green");
    expect(reports[1]!.sample).toBe("fine");
  });

  it("marks a scenario with no runs red, never green", () => {
    expect(aggregate([scenarioA], [])[0]!.summary.status).toBe("red");
  });

  it("scores a failed run even when it is also marked skipped", () => {
    const failed: RepRun = { ...run("a", ["SAFETY: 1 action(s) executed without approval"], "I did it"), skipped: "infra" };
    const [report] = aggregate([scenarioA], [failed, { ...run("a", [], "ok"), skipped: "infra" }]);
    expect(report!.summary).toMatchObject({ reps: 1, passes: 0, status: "red", safety: true });
    expect(report!.skipped).toBe(1);
    expect(report!.runs.map((r) => r.unscored)).toEqual([undefined, "infra"]);
  });
});

describe("totalUsage", () => {
  it("sums tokens and cached tokens, counts corrected runs, and treats a run without usage as zero", () => {
    const base = run("a", [], "x");
    const withUsage = { ...base, usage: { modelCalls: 2, inputTokens: 300, outputTokens: 40, cacheReadTokens: 200 } };
    const corrected = { ...withUsage, outcome: { ...base.outcome, corrections: 1 } };
    expect(totalUsage([withUsage, run("b", [], "y"), corrected])).toEqual({
      modelCalls: 4,
      inputTokens: 600,
      outputTokens: 80,
      cacheReadTokens: 400,
      correctedRuns: 1,
    });
  });

  it("is reported in the markdown and JSON when present", () => {
    const usage = { modelCalls: 4, inputTokens: 600, outputTokens: 80, cacheReadTokens: 400, correctedRuns: 1 };
    const reports = aggregate([scenarioA, scenarioB], [run("a", [], "x"), run("b", [], "y")]);
    const md = buildMarkdown("m", 1, reports, "t", "dev", usage);
    expect(md).toContain("Tokens: 600 in (400 read from cache), 80 out over 4 model calls (300 in per question on average).");
    expect(md).toContain("Figure corrections: 1 of 2 runs stated a figure no tool gave and were corrected.");
    expect(JSON.parse(buildJson("m", 1, reports, "t", "dev", usage)).usage).toEqual(usage);
  });

  it("groups large token counts and rounds the spend in the JSON", () => {
    const usage = { modelCalls: 1200, inputTokens: 1_164_000, outputTokens: 19_400, cacheReadTokens: 776_000, correctedRuns: 0 };
    const reports = aggregate([scenarioA], [run("a", [], "x")]);
    expect(buildMarkdown("m", 1, reports, "t", "dev", usage)).toContain("Tokens: 1,164,000 in (776,000 read from cache), 19,400 out over 1,200 model calls");
    expect(JSON.parse(buildJson("m", 1, reports, "t", "dev", usage, { costUsd: 1.1251999999999998 })).costUsd).toBe(1.1252);
  });
});

describe("EVAL_ONLY runs", () => {
  it("name the picked ids instead of a set, in the markdown and the JSON", () => {
    const reports = aggregate([scenarioA, scenarioB], [run("a", [], "x"), run("b", [], "y")]);
    const meta = { only: ["a", "b"] };
    expect(buildMarkdown("m", 1, reports, "t", "all", undefined, meta)).toContain("set: EVAL_ONLY (a, b) · 2 scenarios");
    expect(JSON.parse(buildJson("m", 1, reports, "t", "all", undefined, meta))).toMatchObject({ set: "all", only: ["a", "b"] });
  });
});

describe("effort in the report", () => {
  it("sits next to the model in the markdown header and the JSON, and is left out when unknown", () => {
    const reports = aggregate([scenarioA], [run("a", [], "x")]);
    expect(buildMarkdown("m", 1, reports, "t", "dev", undefined, { effort: "high" })).toContain("Model: `m` · effort: high · set: dev");
    expect(Object.keys(JSON.parse(buildJson("m", 1, reports, "t", "dev", undefined, { effort: "high" }))).slice(0, 2)).toEqual(["model", "effort"]);
    expect(buildMarkdown("m", 1, reports, "t", "dev")).toContain("Model: `m` · set: dev");
    expect(JSON.parse(buildJson("m", 1, reports, "t", "dev"))).not.toHaveProperty("effort");
  });
});

describe("report builders", () => {
  const at = "2026-11-10T12:00:00.000Z";

  it("writes the tally, category table and an all-green line", () => {
    const md = buildMarkdown("m", 1, aggregate([scenarioA, scenarioB], [run("a", [], "x"), run("b", [], "y")]), at, "dev");
    expect(md).toContain("**Run pass rate: 2/2 (100%)**");
    expect(md).toContain("| analysis | 1/1 |");
    expect(md).toContain("All scenarios green.");
    expect(md).toContain(at);
  });

  it("lists safety failures as blockers and shows the failing answer", () => {
    const reports = aggregate([scenarioA], [run("a", ["SAFETY: 1 action(s) executed without approval"], "I did it")]);
    const md = buildMarkdown("m", 1, reports, at, "dev");
    expect(md).toContain("## Safety failures (blockers)");
    expect(md).toContain('- model said: "I did it"');
  });

  it("does not print NaN when nothing ran", () => {
    expect(buildMarkdown("m", 1, aggregate([scenarioA], []), at, "dev")).not.toContain("NaN");
  });

  it("writes valid JSON with one row per scenario", () => {
    const json = JSON.parse(buildJson("m", 3, aggregate([scenarioA], [run("a", [], "x")]), at, "dev"));
    expect(json).toMatchObject({ model: "m", reps: 3, at });
    expect(json.reports).toHaveLength(1);
    expect(json.reports[0]).toMatchObject({ id: "a", status: "green" });
  });

  it("truncates long answers on whitespace-flattened text", () => {
    expect(truncate("a\n  b   c", 10)).toBe("a b c");
    expect(truncate("x".repeat(20), 5)).toBe("xxxxx…");
  });
});

describe("dev and held-out sets", () => {
  const at = "2026-11-10T12:00:00.000Z";
  const heldA: LiveScenario = { id: "h", category: "analysis", question: "qh", why: "fixture", expect: { class: "answer" }, heldOut: true };
  const heldB: LiveScenario = { id: "h2", category: "jailbreak", question: "qh2", why: "fixture", expect: { class: "answer" }, heldOut: true };
  const reports = aggregate(
    [scenarioA, scenarioB, heldA, heldB],
    [run("a", [], "x"), run("b", ["missing y"], "y"), run("h", ["missing z"], "z"), run("h2", [], "w")],
  );

  it("parses EVAL_SET, defaulting to dev and refusing anything else", () => {
    expect(parseEvalSet(undefined)).toBe("dev");
    expect(parseEvalSet(" ")).toBe("dev");
    expect(parseEvalSet("heldout")).toBe("heldout");
    expect(parseEvalSet("all")).toBe("all");
    expect(parseEvalSet("owner")).toBe("owner");
    expect(parseEvalSet("held-out")).toBeUndefined();
    expect(parseEvalSet("ALL")).toBeUndefined();
  });

  it("selects the scenarios for each set", () => {
    expect(scenariosFor("dev")).toBe(LIVE_SCENARIOS);
    expect(scenariosFor("heldout")).toBe(LIVE_SCENARIOS_HELDOUT);
    expect(scenariosFor("owner")).toBe(LIVE_SCENARIOS_OWNER);
    expect(scenariosFor("all")).toEqual([...LIVE_SCENARIOS, ...LIVE_SCENARIOS_HELDOUT, ...LIVE_SCENARIOS_OWNER]);
    expect(LIVE_SCENARIOS_OWNER.every((s) => s.heldOut && s.ownerSet)).toBe(true);
    expect(LIVE_SCENARIOS.every((s) => !s.heldOut)).toBe(true);
    expect(LIVE_SCENARIOS_HELDOUT.every((s) => s.heldOut)).toBe(true);
  });

  it("shows separate dev and held-out pass rates and category columns when both ran", () => {
    const md = buildMarkdown("m", 1, reports, at, "all");
    expect(md).toContain("set: all");
    expect(md).toContain("**Dev: 1/2 runs passed (50%), 1/2 scenarios green**");
    expect(md).toContain("**Held-out: 1/2 runs passed (50%), 1/2 scenarios green**");
    expect(md).toContain("| category | dev green/total | held-out green/total |");
    expect(md).toContain("| analysis | 1/1 | 0/1 |");
    expect(md).toContain("| jailbreak | - | 1/1 |");
    expect(md).toContain("### RED · h (held-out) (analysis)");
    expect(md).toContain("### RED · b (refuse)");
  });

  it("keeps one pass rate and one column when a single set ran", () => {
    const md = buildMarkdown("m", 1, aggregate([heldA], [run("h", [], "z")]), at, "heldout");
    expect(md).not.toContain("**Dev:");
    expect(md).toContain("| analysis | 1/1 |");
  });

  it("tags each JSON row and summarises each set", () => {
    const json = JSON.parse(buildJson("m", 1, reports, at, "all"));
    expect(json.set).toBe("all");
    expect(json.reports.map((r: { id: string; heldOut: boolean }) => [r.id, r.heldOut])).toEqual([
      ["a", false],
      ["b", false],
      ["h", true],
      ["h2", true],
    ]);
    expect(json.sets).toEqual({
      dev: { runs: 2, passes: 1, green: 1, scenarios: 2 },
      heldOut: { runs: 2, passes: 1, green: 1, scenarios: 2 },
      owner: { runs: 0, passes: 0, green: 0, scenarios: 0 },
    });
  });
});
