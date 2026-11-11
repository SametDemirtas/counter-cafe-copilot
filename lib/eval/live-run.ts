// The live eval's run loop, apart from the entry point so it can be tested
// without a key: one rep per scenario run, the spending cap, the abort on a
// fatal API error, and a report rewritten after every finished run.

import { renameSync, writeFileSync } from "node:fs";

import { Agent, type LlmClient, type LlmResponse, createDemoGate, defaultToolRegistry, loadDemoContext } from "../agent/index.js";
import {
  Budget,
  type CallUsage,
  FatalApiError,
  InfraApiError,
  MAX_BAD_REQUESTS,
  MAX_CONSECUTIVE_INFRA_ERRORS,
  MeteredLlm,
  badRequestReason,
  type ModelPricing,
  fatalReason,
  infraReason,
} from "./live-cost.js";
import { type CriterionVerdict, DRY_RUN_ANSWER, type Judge, judgeErrors, judgeFailures } from "./live-judge.js";
import { falseProposalClaim } from "./claim-metric.js";
import { judgeInputFor } from "./live-judge-input.js";
import { type JudgeMeta, type RepRun, type RunMeta, type SkipReason, type ScenarioReport, aggregate, buildJson, buildMarkdown, skippedRun, totalUsage } from "./live-report.js";
import { type LiveScenario } from "./live-scenarios.js";
import { type LiveOutcome, proposalFacts, scoreScenario, unjudgeable } from "./live-score.js";
import { type EvalSet } from "./live-sets.js";
import { safetyCounts } from "./safety-rail.js";

// A fatal or infrastructure error is rethrown so the loop can leave it out of
// scoring; any other error is the model's (or the code's) failure on this run
// and is scored as one.
export async function runRep(llm: LlmClient, scenario: LiveScenario): Promise<RepRun> {
  // Autopilot stays off, so any approval in a live run is a breach.
  const bundle = createDemoGate();
  const ctx = loadDemoContext(bundle.gate, bundle.store);
  const agent = new Agent(llm, defaultToolRegistry());

  let outcome: Omit<LiveOutcome, "executed" | "escalated" | "notPending" | "autoSent"> = { text: "", proposalKinds: [] };
  let usage: RepRun["usage"];
  let badRequest: string | undefined;
  try {
    const answer = await agent.ask(ctx, scenario.question);
    outcome = {
      // The model's words only; the code-rendered status lines go in `status`.
      text: answer.body,
      ...proposalFacts(answer.proposals),
      ungrounded: answer.ungroundedFigures,
      corrections: answer.corrections,
      falseProposalClaim: falseProposalClaim(answer.body, answer.proposals.length),
      status: answer.status.map((l) => ({ kind: l.kind, text: l.text })),
      toolCalls: answer.toolCalls.map((c) => c.name),
      ...(answer.refusal ? { refusal: answer.refusal } : {}),
    };
    usage = answer.usage;
  } catch (error) {
    const fatal = fatalReason(error);
    if (fatal !== undefined) throw new FatalApiError(fatal);
    const infra = infraReason(error);
    if (infra !== undefined) throw new InfraApiError(infra);
    badRequest = badRequestReason(error);
    outcome = { ...outcome, threw: error instanceof Error ? error.message : String(error) };
  }
  const full: LiveOutcome = { ...outcome, ...safetyCounts(bundle) };
  return {
    id: scenario.id,
    failures: scoreScenario(scenario, full),
    outcome: full,
    ...(usage ? { usage } : {}),
    ...(badRequest !== undefined ? { badRequest } : {}),
  };
}

// A server error or a 429 that outlasted the SDK's own retries is usually
// passing, so the scenario gets one more try after a pause before it counts as
// an infrastructure error. The pause is long next to the SDK's backoff.
export const DEFAULT_RETRY_PAUSE_MS = 20_000;

// What the report shows for effort when no model was called.
export const DRY_RUN_EFFORT = "n/a (dry run)";

async function runWithOneRetry(llm: LlmClient, scenario: LiveScenario, pauseMs: number): Promise<RepRun> {
  try {
    return await runRep(llm, scenario);
  } catch (error) {
    if (infraReason(error) === undefined) throw error;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    return await runRep(llm, scenario);
  }
}

export interface JudgeStep {
  readonly judge: Judge;
  // Prices one judge call; 0 for the fake judge.
  readonly priceUsd: (usage: NonNullable<Awaited<ReturnType<Judge["judge"]>>["usage"]>) => number;
}

// Grades a finished run's behaviour. A run the code checks already failed is
// not sent: its verdict is fail whatever the judge says, so a judge error could
// only lose that failure. An API error is retried once after the pause; a
// second one is an infrastructure error, and a fatal one stops the eval.
// Neither is scored against the model under test.
async function judgeRun(step: JudgeStep, scenario: LiveScenario, run: RepRun, pauseMs: number, onUsd: (usd: number) => void): Promise<RepRun> {
  if (run.failures.length > 0) return run;
  const input = judgeInputFor(scenario, run.outcome);
  if (input.criteria.length === 0 || unjudgeable(run.outcome)) return run;
  let verdicts: readonly CriterionVerdict[] | undefined;
  for (let attempt = 0; verdicts === undefined; attempt++) {
    try {
      const result = await step.judge.judge(input);
      if (result.usage) onUsd(step.priceUsd(result.usage));
      verdicts = result.verdicts;
    } catch (error) {
      const fatal = fatalReason(error);
      if (fatal !== undefined) throw new FatalApiError(`judge: ${fatal}`);
      const infra = infraReason(error);
      if (infra === undefined) {
        // Not the API: the judge's own output or code broke. Unscored, and said so.
        const note = error instanceof Error ? error.message : String(error);
        verdicts = input.criteria.map((c) => ({ id: c.id, type: c.type, text: c.text, verdict: "judge_error" as const, evidence: "", note }));
      } else if (attempt > 0) {
        throw new InfraApiError(`judge: ${infra}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    }
  }
  const failures = [...run.failures, ...judgeFailures(verdicts)];
  // A run the code passed but whose behaviour could not be fully judged is
  // neither a pass nor a fail.
  const unjudged = failures.length === 0 && judgeErrors(verdicts).length > 0;
  return { ...run, failures, judge: verdicts, ...(unjudged ? { skipped: "unjudged" as const } : {}) };
}

// Write to a temporary file and rename it over the old one, so a crash or
// Ctrl-C mid-write never leaves a half-written report.
export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export interface ReportSink {
  write(markdown: string, json: string): void;
}

export function fileSink(markdownPath: string, jsonPath: string): ReportSink {
  return {
    write: (markdown, json) => {
      writeAtomic(jsonPath, json);
      writeAtomic(markdownPath, markdown);
    },
  };
}

export interface LiveRunOptions {
  readonly scenarios: readonly LiveScenario[];
  readonly reps: number;
  readonly concurrency: number;
  readonly llm: LlmClient;
  readonly model: string;
  // The effort level the model runs at, for the report; a dry run has none.
  readonly effort?: string;
  readonly set: EvalSet;
  readonly pricing: ModelPricing;
  readonly maxUsd: number;
  // Expected cost of one run before any has finished.
  readonly perRunUsd: number;
  readonly sink: ReportSink;
  // The ids EVAL_ONLY picked, for the report's heading.
  readonly only?: readonly string[];
  // The model is DryRunLlm: the cap still runs on its synthetic usage, but the
  // report states $0 spent and never prices those made-up tokens.
  readonly dryRun?: boolean;
  readonly now?: () => Date;
  // How long to wait before the one retry after a server error or a 429.
  readonly retryPauseMs?: number;
  readonly onRun?: (run: RepRun, done: number, total: number) => void;
  // Grades each run's behaviour; without it, criteria go ungraded and the
  // report says so (judge.mode "off").
  readonly judgeStep?: JudgeStep;
  readonly judgeMeta: JudgeMeta;
}

export interface LiveRunResult {
  readonly reports: readonly ScenarioReport[];
  readonly runs: readonly RepRun[];
  readonly aborted?: string;
  // Money actually spent, the judge's share included: always 0 for a dry run.
  readonly costUsd: number;
  readonly judgeCostUsd: number;
}

export async function runLiveEval(options: LiveRunOptions): Promise<LiveRunResult> {
  // Rep by rep, so a run cut short by the cap has given every scenario, held-out
  // ones included, its first run before any scenario gets a second.
  const tasks = Array.from({ length: options.reps }, () => options.scenarios).flat();
  const budget = new Budget(options.maxUsd, options.pricing, options.perRunUsd);
  let judgeUsd = 0;
  const runs: (RepRun | undefined)[] = new Array(tasks.length);
  const now = options.now ?? (() => new Date());
  let aborted: string | undefined;
  let budgetHit = false;
  let infraStreak = 0;
  let badRequests = 0;
  const retryPauseMs = options.retryPauseMs ?? DEFAULT_RETRY_PAUSE_MS;
  let next = 0;
  let done = 0;

  const meta = (): RunMeta => ({
    ...(aborted ? { incomplete: `aborted because ${aborted}` } : budgetHit ? { incomplete: "stopped at the spending cap" } : {}),
    costUsd: options.dryRun ? 0 : budget.spentUsd,
    judgeCostUsd: options.dryRun ? 0 : judgeUsd,
    maxUsd: options.maxUsd,
    judge: options.judgeMeta,
    ...(options.only ? { only: options.only } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.dryRun ? { effort: DRY_RUN_EFFORT } : options.effort ? { effort: options.effort } : {}),
  });
  const report = (): ScenarioReport[] => {
    const finished = runs.filter((r): r is RepRun => r !== undefined);
    const reports = aggregate(options.scenarios, finished);
    const at = now().toISOString();
    const usage = totalUsage(finished);
    options.sink.write(
      buildMarkdown(options.model, options.reps, reports, at, options.set, usage, meta()),
      buildJson(options.model, options.reps, reports, at, options.set, usage, meta()),
    );
    return reports;
  };

  // Over the cap only on the estimate for runs still going, a worker waits for
  // one to finish, since its real cost may leave room. Once the cap is reached
  // with nothing running, no new run starts.
  const waiters: (() => void)[] = [];
  async function admit(): Promise<"run" | SkipReason> {
    for (;;) {
      if (aborted !== undefined) return "aborted";
      if (budgetHit) return "budget";
      if (budget.tryStart()) return "run";
      if (budget.running === 0) {
        budgetHit = true;
        return "budget";
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      const scenario = tasks[i]!;
      const admitted = await admit();
      if (admitted !== "run") {
        runs[i] = skippedRun(scenario.id, admitted);
        continue;
      }
      const metered = new MeteredLlm(options.llm, options.pricing, (u: CallUsage) => budget.record(u));
      let runJudgeUsd = 0;
      try {
        runs[i] = await runWithOneRetry(metered, scenario, retryPauseMs);
        if (options.judgeStep) {
          runs[i] = await judgeRun(options.judgeStep, scenario, runs[i]!, retryPauseMs, (usd) => {
            runJudgeUsd += usd;
            judgeUsd += usd;
            budget.recordUsd(usd);
          });
        }
        infraStreak = 0;
        const bad = runs[i]!.badRequest;
        if (bad !== undefined && ++badRequests >= MAX_BAD_REQUESTS) {
          aborted ??= `${badRequests} requests rejected as malformed (400), last: ${bad}`;
        }
      } catch (error) {
        // Only a fatal or infrastructure API error reaches here; neither is the model's failure.
        // A run the code checks failed never reaches the judge (see judgeRun),
        // so a judge error here only ever leaves a code-passed run unscored.
        const infra = infraReason(error);
        if (infra !== undefined) {
          // A judge error after the run keeps the run's answer in the record.
          runs[i] = runs[i] ? { ...runs[i]!, skipped: "infra" } : skippedRun(scenario.id, "infra");
          infraStreak += 1;
          if (infraStreak >= MAX_CONSECUTIVE_INFRA_ERRORS) aborted ??= `${infraStreak} API errors in a row after retries (last: ${infra})`;
        } else {
          // This run had started and may have spent tokens, so it is reported
          // as cut off, not as one that never started.
          aborted ??= fatalReason(error) ?? String(error);
          runs[i] = runs[i] ? { ...runs[i]!, skipped: "cut_off" } : skippedRun(scenario.id, "cut_off");
        }
      } finally {
        budget.finish(metered.spentUsd + runJudgeUsd);
        for (const wake of waiters.splice(0)) wake();
      }
      done += 1;
      options.onRun?.(runs[i]!, done, tasks.length);
      report();
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, tasks.length)) }, worker));
  const reports = report();
  return {
    reports,
    runs: runs.filter((r): r is RepRun => r !== undefined),
    ...(aborted ? { aborted } : {}),
    costUsd: options.dryRun ? 0 : budget.spentUsd,
    judgeCostUsd: options.dryRun ? 0 : judgeUsd,
  };
}

// For EVAL_DRY_RUN: a fixed answer with fixed, synthetic token counts, so the
// whole pipeline (scoring, sets, cap, report) runs with no key and no network.
// The tokens are made up, so runLiveEval never reports a cost for them.
export class DryRunLlm implements LlmClient {
  calls = 0;
  async respond(): Promise<LlmResponse> {
    this.calls += 1;
    return {
      stop: "end",
      blocks: [{ type: "text", text: DRY_RUN_ANSWER }],
      usage: { inputTokens: 3_000, outputTokens: 50, cacheReadTokens: 2_000, cacheWriteTokens: 0 },
    };
  }
}

// The average model spend of one run in an earlier real report, typically the
// EVAL_ONLY smoke run, with the judge's share taken out (the caller adds its
// own judge estimate), or undefined when there is none worth using. A dry run
// writes its own files, so it never feeds this.
// Only a report from the same model at the same effort says anything about this run's cost.
export function perRunFromReport(raw: string | undefined, model?: string, effort?: string): number | undefined {
  if (raw === undefined) return undefined;
  try {
    const report = JSON.parse(raw) as { costUsd?: unknown; judgeCostUsd?: unknown; ranRuns?: unknown; model?: unknown; effort?: unknown };
    const { costUsd, ranRuns } = report;
    if (model !== undefined && report.model !== model) return undefined;
    if (effort !== undefined && report.effort !== effort) return undefined;
    if (typeof costUsd !== "number" || typeof ranRuns !== "number" || ranRuns < 1 || costUsd <= 0) return undefined;
    const judge = typeof report.judgeCostUsd === "number" && report.judgeCostUsd > 0 ? report.judgeCostUsd : 0;
    const modelSpend = costUsd - judge;
    return modelSpend > 0 ? modelSpend / ranRuns : undefined;
  } catch {
    return undefined;
  }
}

// EVAL_ONLY=id1,id2: a handful of scenarios by id, from either set. A repeated
// id counts once; EVAL_REPS is how to run a scenario more than once.
export function selectOnly(all: readonly LiveScenario[], raw: string): { scenarios: LiveScenario[]; unknown: string[] } {
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
  const byId = new Map(all.map((s) => [s.id, s] as const));
  return {
    scenarios: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    unknown: ids.filter((id) => !byId.has(id)),
  };
}

export function parseMaxUsd(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
