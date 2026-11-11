// Spends real tokens, so it stays out of CI:
//   EVAL_SET=all EVAL_REPS=3 ANTHROPIC_API_KEY=... npm run eval:live
//
// EVAL_SET        dev (default), heldout, owner or all
// EVAL_ONLY       id1,id2: only these scenarios, from any set (a smoke test)
// EVAL_MAX_USD    spending cap in US dollars, the judge's calls included, default 55
// EVAL_DRY_RUN=1  the whole pipeline against a scripted fake model and a fake judge: no key, no network
// EVAL_JUDGE      unset: behaviour is judged only if judge-check.json passed for this
//                 exact judge prompt and these criteria, otherwise the run stops;
//                 "unvalidated": judge anyway, stamped UNVALIDATED on the report;
//                 "off": no judge, criteria skipped, stamped NOT GRADED
// ANTHROPIC_EFFORT  low, medium (default), high, xhigh or max; recorded in the report

import { existsSync, readFileSync } from "node:fs";

import { AnthropicLlmClient, DEFAULT_MODEL, type LlmClient } from "../agent/index.js";
import { ASSUMED_JUDGE_USAGE, ASSUMED_RUN_USAGE, costUsd, pricingFor } from "./live-cost.js";
import { AnthropicJudge, FakeJudge, JUDGE_MODEL, criteriaHash, judgePromptHash } from "./live-judge.js";
import { JUDGE_CHECK_JSON, barHash, buildItems, judgeGate } from "./live-judge-check.js";
import { LIVE_FIXTURES } from "./live-fixtures.js";
import { type JudgeMeta, parsePositiveInt, pct, truncate } from "./live-report.js";
import { DRY_RUN_EFFORT, DryRunLlm, type JudgeStep, fileSink, parseMaxUsd, perRunFromReport, runLiveEval, selectOnly } from "./live-run.js";
import { ALL_LIVE_SCENARIOS, type LiveScenario } from "./live-scenarios.js";
import { type EvalSet, parseEvalSet, scenariosFor } from "./live-sets.js";

const DEFAULT_MAX_USD = 55;
// Fewer at once keeps a run under the API's rate limit; a 429 that outlasts the
// SDK's retries is retried once more after a pause, see runLiveEval.
const DEFAULT_CONCURRENCY = 4;

function envInt(name: string, fallback: number): number | undefined {
  const value = parsePositiveInt(process.env[name], fallback);
  if (value === undefined) console.error(`${name} must be a positive integer, got "${process.env[name]}".`);
  return value;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  const dryRun = process.env["EVAL_DRY_RUN"] === "1";
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!dryRun && (!key || key.trim().length === 0)) {
    return fail("eval:live needs ANTHROPIC_API_KEY (it calls the real model). Set it, or use EVAL_DRY_RUN=1.");
  }
  const reps = envInt("EVAL_REPS", 1);
  const concurrency = envInt("EVAL_CONCURRENCY", DEFAULT_CONCURRENCY);
  const maxUsd = parseMaxUsd(process.env["EVAL_MAX_USD"], DEFAULT_MAX_USD);
  if (maxUsd === undefined) console.error(`EVAL_MAX_USD must be a positive number, got "${process.env["EVAL_MAX_USD"]}".`);
  let set = parseEvalSet(process.env["EVAL_SET"]);
  if (set === undefined) console.error(`EVAL_SET must be dev, heldout, owner or all, got "${process.env["EVAL_SET"]}".`);
  const judgeEnv = (process.env["EVAL_JUDGE"] ?? "").trim();
  if (!["", "unvalidated", "off"].includes(judgeEnv)) console.error(`EVAL_JUDGE must be unset, "unvalidated" or "off", got "${judgeEnv}".`);
  if (reps === undefined || concurrency === undefined || set === undefined || maxUsd === undefined || !["", "unvalidated", "off"].includes(judgeEnv)) {
    process.exitCode = 2;
    return;
  }

  let scenarios: readonly LiveScenario[] = scenariosFor(set);
  let only: readonly string[] | undefined;
  const onlyRaw = process.env["EVAL_ONLY"];
  if (onlyRaw !== undefined && onlyRaw.trim() !== "") {
    const picked = selectOnly(ALL_LIVE_SCENARIOS, onlyRaw);
    if (picked.unknown.length > 0) return fail(`EVAL_ONLY names unknown scenario id(s): ${picked.unknown.join(", ")}.`);
    if (picked.scenarios.length === 0) return fail(`EVAL_ONLY names no scenario id, got "${onlyRaw}".`);
    scenarios = picked.scenarios;
    only = scenarios.map((s) => s.id);
    // The picks may come from several sets, so the report splits them.
    set = "all" satisfies EvalSet;
  }

  const llm: LlmClient = dryRun ? new DryRunLlm() : new AnthropicLlmClient({ apiKey: key! });
  const model = dryRun ? `dry-run (priced as ${DEFAULT_MODEL})` : (llm as AnthropicLlmClient).modelId;
  const effort = dryRun ? DRY_RUN_EFFORT : (llm as AnthropicLlmClient).effortLevel;
  const pricing = pricingFor(dryRun ? DEFAULT_MODEL : model);
  if (!pricing) return fail(`No prices are recorded for ${model}, so the spending cap cannot be enforced. Add it to PRICING in lib/eval/live-cost.ts.`);
  const judgePricing = pricingFor(JUDGE_MODEL);
  if (!judgePricing) return fail(`No prices are recorded for the judge model ${JUDGE_MODEL}. Add it to PRICING in lib/eval/live-cost.ts.`);

  // The criteria hash covers every scenario, not only this run's, so the same
  // judge-check validates any set or EVAL_ONLY pick.
  const ids = { model: JUDGE_MODEL, promptHash: judgePromptHash(), criteriaHash: criteriaHash(ALL_LIVE_SCENARIOS, LIVE_FIXTURES) };
  let judgeMeta: JudgeMeta;
  let judgeStep: JudgeStep | undefined;
  if (dryRun) {
    judgeMeta = { mode: "fake" };
    judgeStep = { judge: new FakeJudge(), priceUsd: () => 0 };
  } else if (judgeEnv === "off") {
    judgeMeta = { mode: "off" };
  } else {
    const gate = judgeGate(existsSync(JUDGE_CHECK_JSON) ? readFileSync(JUDGE_CHECK_JSON, "utf8") : undefined, {
      promptHash: ids.promptHash,
      criteriaHash: ids.criteriaHash,
      barHash: barHash(buildItems(ALL_LIVE_SCENARIOS, LIVE_FIXTURES)),
      judgeModel: ids.model,
    });
    if (!gate.ok && judgeEnv !== "unvalidated") {
      return fail(
        `The judge is not validated: ${gate.reason}.\n` +
          "Run `npm run eval:judge-check` (if it does not pass, judge-check.md says which criterion types missed the bar), or rerun with EVAL_JUDGE=unvalidated (stamped on the report) " +
          "or EVAL_JUDGE=off (behaviour not graded).",
      );
    }
    judgeMeta = gate.ok ? { mode: "validated", ...ids, checkedAt: gate.at } : { mode: "unvalidated", ...ids, reason: gate.reason };
    judgeStep = { judge: new AnthropicJudge({ apiKey: key! }), priceUsd: (u) => costUsd(u, judgePricing) };
  }

  const [mdPath, jsonPath] = dryRun ? ["eval-report.dry-run.md", "eval-report.dry-run.json"] : ["eval-report.md", "eval-report.json"];
  const earlier = !dryRun && existsSync("eval-report.json") ? readFileSync("eval-report.json", "utf8") : undefined;
  // The earlier report's model spend per run, its judge share taken out, so the
  // judge is added on top the same way whether that run had one or not.
  const smoke = perRunFromReport(earlier, model, effort);
  const judgePerRun = judgeStep ? costUsd(ASSUMED_JUDGE_USAGE, judgePricing) : 0;
  const perRunUsd = (smoke ?? costUsd(ASSUMED_RUN_USAGE, pricing)) + judgePerRun;
  const runsPlanned = scenarios.length * reps;
  console.log(
    `Running ${only ? "the EVAL_ONLY picks" : `the ${set} set`}: ${scenarios.length} scenarios × ${reps} rep(s) = ${runsPlanned} runs against ${model} (effort: ${effort}), ${concurrency} at a time.`,
  );
  console.log(
    judgeMeta.mode === "off"
      ? "Judge: OFF. Behaviour is not graded; only the code checks run."
      : judgeMeta.mode === "fake"
        ? "Judge: fake (dry run)."
        : `Judge: ${JUDGE_MODEL}, prompt ${ids.promptHash}, criteria ${ids.criteriaHash}, ${judgeMeta.mode === "validated" ? `validated by the judge check of ${judgeMeta.checkedAt}` : `UNVALIDATED (${judgeMeta.reason ?? "no reason recorded"})`}.`,
  );
  console.log(
    `Estimated cost: ${runsPlanned} runs × $${perRunUsd.toFixed(4)} = $${(runsPlanned * perRunUsd).toFixed(2)} ` +
      `(${smoke !== undefined ? "average per run in the last eval-report.json for this model and effort" : `assumed ${ASSUMED_RUN_USAGE.inputTokens} input and ${ASSUMED_RUN_USAGE.outputTokens} output tokens per run, no caching`}` +
      `${judgeStep ? `, plus $${judgePerRun.toFixed(4)} for the judge` : ""}). ` +
      `Cap: $${maxUsd.toFixed(2)}; no new run starts once the projected spend would pass it.` +
      (runsPlanned * perRunUsd > maxUsd
        ? `\nThe estimate is over the cap: unless real runs cost less, about ${Math.floor(maxUsd / perRunUsd)} runs will start and the rest will be reported as skipped.`
        : "") +
      "\n",
  );

  // The report on disk is rewritten after every run; on Ctrl-C it is already valid.
  process.once("SIGINT", () => {
    console.error(`\nInterrupted. ${jsonPath} and ${mdPath} hold every run that finished.`);
    process.exit(130);
  });

  const started = Date.now();
  const result = await runLiveEval({
    scenarios,
    reps,
    concurrency,
    llm,
    model,
    effort,
    set,
    pricing,
    maxUsd,
    perRunUsd,
    sink: fileSink(mdPath, jsonPath),
    judgeMeta,
    ...(judgeStep ? { judgeStep } : {}),
    ...(only ? { only } : {}),
    ...(dryRun ? { dryRun } : {}),
    onRun: (_run, done, total) => {
      if (done % 10 === 0 || done === total) console.log(`  …${done}/${total}`);
    },
  });

  for (const r of result.reports) {
    const mark = { green: "PASS", flaky: "FLAKY", red: "FAIL", skipped: r.infraErrors > 0 ? "INFRA" : r.unjudged > 0 ? "UNJDG" : "SKIP" }[r.summary.status];
    const heldOut = r.scenario.ownerSet ? "[owner] " : r.scenario.heldOut ? "[held-out] " : "";
    console.log(`${heldOut}${mark.padEnd(5)} [${r.scenario.category}] ${r.scenario.id}  ${pct(r.summary.passRate)}`);
    if (r.summary.status === "red" || r.summary.status === "flaky") {
      for (const f of r.summary.failures) console.log(`        - ${f}`);
      console.log(`        model: "${truncate(r.sample, 220)}"`);
    }
  }

  const green = result.reports.filter((r) => r.summary.status === "green").length;
  const skipped = result.runs.filter((r) => r.skipped === "budget" || r.skipped === "aborted").length;
  const cutOff = result.runs.filter((r) => r.skipped === "cut_off").length;
  const infra = result.runs.filter((r) => r.skipped === "infra").length;
  const unjudged = result.runs.filter((r) => r.skipped === "unjudged").length;
  const safety = result.reports.filter((r) => r.summary.safety).length;
  if (result.aborted) console.error(`\nINCOMPLETE: aborted because ${result.aborted}.`);
  console.log(
    `\n${green}/${result.reports.length} scenarios green · ${skipped} run(s) skipped · ${cutOff} cut off mid-run · ${infra} infrastructure error(s) · ${unjudged} unjudged · ${safety} safety failure(s) · ` +
      `$${result.costUsd.toFixed(2)} spent ($${result.judgeCostUsd.toFixed(2)} judge)${dryRun ? " (dry run: synthetic tokens, not priced)" : ""} · ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  console.log(`Report written to ${mdPath} and ${jsonPath}`);
  process.exitCode = result.aborted ? 3 : green === result.reports.length ? 0 : 1;
}

await main();
