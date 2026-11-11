// npm run eval:routing
//
// Runs the labelled review set through the real classifier and reports recall
// on delicate reviews (target: no misses), precision, per-language results and
// cost, in routing-report.md and routing-report.json.
//
// ANTHROPIC_API_KEY  required for a real run
// EVAL_DRY_RUN=1     no key, no network: a fake classifier that answers each
//                    case's own label, so only the plumbing is tested. Writes
//                    routing-report.dry-run.md and .json instead.

import { writeFileSync } from "node:fs";

import { type AsyncReviewClassifier, type ClassifierOutcome } from "../safety/index.js";
import { AnthropicReviewClassifier, CLASSIFIER_MODEL, CLASSIFIER_PROMPT_HASH } from "../agent/review-classifier.js";
import { ROUTING_SET } from "./review-routing-set.js";
import { pricingFor } from "./live-cost.js";
import { classifyAll, formatRoutingMarkdown, scoreRouting } from "./review-routing.js";

const dryRun = process.env["EVAL_DRY_RUN"] === "1";
const key = process.env["ANTHROPIC_API_KEY"];

// Knows the labels, which a real classifier never sees.
function labelEcho(): AsyncReviewClassifier {
  const labels = new Map(ROUTING_SET.map((c) => [c.id, c.delicate] as const));
  return {
    classify: async (review): Promise<ClassifierOutcome> => {
      const delicate = labels.get(review.reviewId);
      if (delicate === undefined) return { status: "error", error: "not in the set" };
      return { status: "ok", verdict: { delicate, reasons: delicate ? ["other"] : [], language: "xx" }, model: "dry-run-fake", promptHash: "dry-run" };
    },
  };
}

async function main(): Promise<void> {
  if (!dryRun && (!key || key.trim() === "")) {
    console.error("eval:routing needs ANTHROPIC_API_KEY (it calls the real classifier). Set it, or use EVAL_DRY_RUN=1.");
    process.exitCode = 2;
    return;
  }
  const pricing = pricingFor(CLASSIFIER_MODEL);
  if (!pricing) {
    console.error(`No prices are recorded for ${CLASSIFIER_MODEL}. Add it to PRICING in lib/eval/live-cost.ts.`);
    process.exitCode = 2;
    return;
  }
  const usage = { inputTokens: 0, outputTokens: 0 };
  const classifier = dryRun
    ? labelEcho()
    : new AnthropicReviewClassifier({
        apiKey: key!,
        onUsage: (u) => {
          usage.inputTokens += u.inputTokens;
          usage.outputTokens += u.outputTokens;
        },
      });
  const results = await classifyAll(ROUTING_SET, classifier);
  const report = scoreRouting(results, {
    model: dryRun ? "dry-run-fake" : CLASSIFIER_MODEL,
    promptHash: dryRun ? "dry-run" : CLASSIFIER_PROMPT_HASH,
    dryRun,
    usage,
    pricing,
  });
  const base = dryRun ? "routing-report.dry-run" : "routing-report";
  const markdown = formatRoutingMarkdown(report);
  writeFileSync(`${base}.md`, markdown);
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(markdown);
  console.log(`Wrote ${base}.md and ${base}.json`);
  process.exitCode = report.passed ? 0 : 1;
}

await main();
