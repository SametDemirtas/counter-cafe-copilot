// npm run eval:judge-check: runs the judge over every hand-labelled fixture and
// reports how far it agrees with the labels, per criterion type and overall.
// The live run uses the judge only once this has passed for the same judge
// prompt, the same criteria and the same bar.
//
// ANTHROPIC_API_KEY  required unless EVAL_DRY_RUN=1
// EVAL_DRY_RUN=1     a fake judge, no network; writes judge-check.dry-run.*, never unlocks the live run
// EVAL_MAX_USD       spending cap in US dollars, default 15
// EVAL_CONCURRENCY   judge calls at once, default 4

import { AnthropicJudge, FakeJudge, JUDGE_MODEL, type Judge, criteriaHash, judgePromptHash } from "./live-judge.js";
import { ASSUMED_JUDGE_USAGE, costUsd, fatalReason, infraReason, pricingFor } from "./live-cost.js";
import {
  JUDGE_CHECK_JSON,
  JUDGE_CHECK_MD,
  type Split,
  type SplitStats,
  barHash,
  buildItems,
  checkBar,
  disagreements,
  needsJudge,
  runJudgeCheck,
  splitStats,
} from "./live-judge-check.js";
import { type JudgeCheckReport, checkMarkdown } from "./live-judge-check-report.js";
import { LIVE_FIXTURES } from "./live-fixtures.js";
import { parsePositiveInt } from "./live-report.js";
import { parseMaxUsd, writeAtomic } from "./live-run.js";
import { ALL_LIVE_SCENARIOS } from "./live-scenarios.js";

const DEFAULT_MAX_USD = 15;

async function main(): Promise<void> {
  const dryRun = process.env["EVAL_DRY_RUN"] === "1";
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!dryRun && (!key || key.trim() === "")) {
    console.error("eval:judge-check needs ANTHROPIC_API_KEY (it calls the judge model). Set it, or use EVAL_DRY_RUN=1.");
    process.exitCode = 2;
    return;
  }
  const maxUsd = parseMaxUsd(process.env["EVAL_MAX_USD"], DEFAULT_MAX_USD);
  const concurrency = parsePositiveInt(process.env["EVAL_CONCURRENCY"], 4);
  const pricing = pricingFor(JUDGE_MODEL);
  if (maxUsd === undefined || concurrency === undefined || !pricing) {
    console.error("EVAL_MAX_USD and EVAL_CONCURRENCY must be positive numbers, and the judge model needs a price in live-cost.ts.");
    process.exitCode = 2;
    return;
  }

  const items = buildItems(ALL_LIVE_SCENARIOS, LIVE_FIXTURES);
  const queue = items.filter(needsJudge);
  const estimate = queue.length * costUsd(ASSUMED_JUDGE_USAGE, pricing);
  console.log(
    `${items.length} labelled answers; ${queue.length} need the judge (${queue.filter((i) => i.label === "good").length} good, ` +
      `${queue.filter((i) => i.label === "bad").length} bad the code checks let through). ` +
      `Estimated cost: $${estimate.toFixed(2)}${dryRun ? " (dry run: nothing is spent)" : ""}; cap $${maxUsd.toFixed(2)}.`,
  );

  const judge: Judge = dryRun ? new FakeJudge() : new AnthropicJudge({ apiKey: key! });
  const result = await runJudgeCheck({
    items,
    judge,
    concurrency,
    maxUsd,
    priceUsd: (u) => (dryRun ? 0 : costUsd(u, pricing)),
    classify: (error) => {
      const fatal = fatalReason(error);
      if (fatal !== undefined) return { kind: "fatal", reason: fatal };
      const infra = infraReason(error);
      if (infra !== undefined) return { kind: "retry", reason: infra };
      return { kind: "other", reason: error instanceof Error ? error.message : String(error) };
    },
    onItem: (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`  …${done}/${total}`);
    },
  });

  const bySplit = (split: Split) => ({
    all: items.filter((i) => i.split === split),
    judged: result.judged.filter((j) => j.item.split === split),
  });
  const splits: Record<Split, SplitStats> = {
    "judge-dev": splitStats(bySplit("judge-dev").all, bySplit("judge-dev").judged),
    "judge-heldout": splitStats(bySplit("judge-heldout").all, bySplit("judge-heldout").judged),
  };
  const bar = checkBar(splits);
  const reasons = [
    ...(result.stopped ? [`stopped early: ${result.stopped}; ${result.judged.length} of ${queue.length} answers judged`] : []),
    ...(dryRun ? ["dry run: the fake judge proves nothing"] : []),
    ...bar.reasons,
  ];
  const report: JudgeCheckReport = {
    at: new Date().toISOString(),
    judgeModel: judge.model,
    promptHash: judgePromptHash(),
    criteriaHash: criteriaHash(ALL_LIVE_SCENARIOS, LIVE_FIXTURES),
    barHash: barHash(items),
    dryRun,
    costUsd: Math.round(result.costUsd * 10_000) / 10_000,
    passed: bar.passed && !result.stopped && !dryRun,
    reasons,
    splits,
    disagreements: disagreements(result.judged),
  };
  const [json, md] = dryRun ? ["judge-check.dry-run.json", "judge-check.dry-run.md"] : [JUDGE_CHECK_JSON, JUDGE_CHECK_MD];
  writeAtomic(json, JSON.stringify(report, null, 2));
  writeAtomic(md, checkMarkdown(report));

  for (const [split, s] of Object.entries(splits)) {
    const k = s.answerKappa === undefined ? "n/a" : s.answerKappa.toFixed(3);
    console.log(`${split}: ${s.judged} judged, kappa ${k}, ${s.answersWithErrors} answer(s) with a judge error`);
  }
  console.log(`\n${report.passed ? "PASSED" : "NOT PASSED"} · ${report.disagreements.length} disagreement(s) · $${result.costUsd.toFixed(2)} spent`);
  for (const r of reasons) console.log(`  - ${r}`);
  console.log(`Report written to ${md} and ${json}`);
  process.exitCode = report.passed ? 0 : 1;
}

await main();
