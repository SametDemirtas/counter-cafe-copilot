// The routing eval: does a labelled review reach the owner when it should?
// Each case runs through the classifier and the tripwire, then through
// decideAutopilot with autopilot on for 3 to 5 stars and an owner's reply
// template that passes the draft checks, so the only things deciding are the
// review's stars, its text and the classifier. A delicate review that would be posted is a miss;
// the target is none. Scoring is pure so it can be tested without a model.

import {
  type AsyncReviewClassifier,
  type AutopilotFacts,
  type ClassifierOutcome,
  MIN_AUTOPILOT_RATING,
  type TripwireResult,
  decideAutopilot,
  reviewTripwire,
} from "../safety/index.js";
import { type ModelPricing, costUsd } from "./live-cost.js";
import { type RoutingCase } from "./review-routing-set.js";

export interface RoutingResult {
  readonly id: string;
  readonly language: string;
  readonly rating: number;
  readonly text: string;
  readonly tags: readonly string[];
  readonly labelDelicate: boolean;
  readonly outcome: ClassifierOutcome;
  readonly tripwire: TripwireResult;
  readonly routed: "owner" | "post";
  readonly rule: string;
}

const AUTOPILOT_ON = { enabled: true, ratings: [3, 4, 5], unlocked: true } as const;

export function routeCase(c: RoutingCase, outcome: ClassifierOutcome): RoutingResult {
  const tripwire = reviewTripwire(c.text);
  const facts: AutopilotFacts = {
    settings: { ...AUTOPILOT_ON, ratings: [...AUTOPILOT_ON.ratings] },
    review: { rating: c.rating, hasText: true },
    reply: { source: "template", named: false },
    tripwire,
    classifier: outcome,
    draft: { ok: true, failures: [] },
  };
  const decision = decideAutopilot(facts);
  return {
    id: c.id,
    language: c.language,
    rating: c.rating,
    text: c.text,
    tags: c.tags,
    labelDelicate: c.delicate,
    outcome,
    tripwire,
    routed: decision.action,
    rule: decision.rule,
  };
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Confusion {
  readonly delicate: number;
  readonly caught: number;
  readonly flagged: number;
  // Labelled delicate but posted (system) or not flagged (classifier).
  readonly misses: number;
  // Labelled fine but sent to the owner anyway.
  readonly falseHolds: number;
  readonly recall: number | null;
  readonly precision: number | null;
}

export interface LanguageRow extends Confusion {
  readonly language: string;
  readonly cases: number;
  readonly errors: number;
}

export interface RoutingReport {
  readonly model: string;
  readonly promptHash: string;
  readonly dryRun: boolean;
  readonly cases: number;
  // What the owner would see: classifier, tripwire and star rating together.
  readonly system: Confusion;
  // The classifier's verdict on its own. An error counts as flagged, since it
  // sends the review to the owner.
  readonly classifier: Confusion;
  // The system on the cases the classifier alone decides: rating 3 or more and
  // no tripwire hit. Stars and the tripwire route the rest before it is read.
  readonly classifierDecided: Confusion;
  readonly errors: number;
  readonly byLanguage: readonly LanguageRow[];
  readonly missed: readonly RoutingResult[];
  readonly falseHolds: readonly RoutingResult[];
  readonly erroredCases: readonly RoutingResult[];
  readonly usage: Usage;
  readonly costUsd: number;
  // Why the run failed, in the order checked. Empty when it passed.
  readonly failures: readonly string[];
  readonly passed: boolean;
}

// A false hold costs the owner a minute, a miss posts to an upset customer, so
// misses must be zero and false holds only bounded. The bound is on the plain
// reviews the classifier alone decides: elsewhere stars or the tripwire hold a
// review before the classifier is read, so a classifier that flags everything
// would otherwise still pass.
export const MAX_FALSE_HOLD_RATE = 0.25;

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

function confusion(results: readonly RoutingResult[], flaggedBy: (r: RoutingResult) => boolean): Confusion {
  const delicate = results.filter((r) => r.labelDelicate).length;
  const flagged = results.filter(flaggedBy).length;
  const caught = results.filter((r) => r.labelDelicate && flaggedBy(r)).length;
  return {
    delicate,
    caught,
    flagged,
    misses: delicate - caught,
    falseHolds: flagged - caught,
    recall: ratio(caught, delicate),
    precision: ratio(caught, flagged),
  };
}

const sentToOwner = (r: RoutingResult) => r.routed === "owner";
const classifierDecides = (r: RoutingResult) => r.rating >= MIN_AUTOPILOT_RATING && !r.tripwire.hit;
const classifierFlags = (r: RoutingResult) => r.outcome.status !== "ok" || r.outcome.verdict.delicate || r.outcome.verdict.reasons.length > 0;

export function scoreRouting(
  results: readonly RoutingResult[],
  meta: { readonly model: string; readonly promptHash: string; readonly dryRun: boolean; readonly usage: Usage; readonly pricing: ModelPricing },
): RoutingReport {
  const languages = [...new Set(results.map((r) => r.language))];
  const system = confusion(results, sentToOwner);
  const decidedRows = results.filter(classifierDecides);
  const classifierDecided = confusion(decidedRows, sentToOwner);
  const errors = results.filter((r) => r.outcome.status === "error").length;
  const failures = routingFailures(results.length, errors, system, classifierDecided, decidedRows.length);
  return {
    model: meta.model,
    promptHash: meta.promptHash,
    dryRun: meta.dryRun,
    cases: results.length,
    system,
    classifier: confusion(results, classifierFlags),
    classifierDecided,
    errors,
    byLanguage: languages.map((language) => {
      const rows = results.filter((r) => r.language === language);
      return { language, cases: rows.length, errors: rows.filter((r) => r.outcome.status === "error").length, ...confusion(rows, sentToOwner) };
    }),
    missed: results.filter((r) => r.labelDelicate && !sentToOwner(r)),
    falseHolds: results.filter((r) => !r.labelDelicate && sentToOwner(r)),
    erroredCases: results.filter((r) => r.outcome.status === "error"),
    usage: meta.usage,
    costUsd: costUsd(meta.usage, meta.pricing),
    failures,
    passed: failures.length === 0,
  };
}

// A classifier error routes to the owner, so it can never be a miss. It is not
// a measurement either: with a bad key every call fails and recall reads 100%.
// Any error therefore fails the run.
function routingFailures(cases: number, errors: number, system: Confusion, decided: Confusion, decidedCases: number): string[] {
  if (cases === 0) return ["no cases ran"];
  const failures: string[] = [];
  if (system.misses > 0) failures.push(`${system.misses} delicate review(s) would have been posted (target: 0)`);
  if (errors > 0) failures.push(`${errors} of ${cases} classifier call(s) failed, so the classifier was not measured on them`);
  const fine = decidedCases - decided.delicate;
  if (fine > 0 && decided.falseHolds / fine > MAX_FALSE_HOLD_RATE) {
    failures.push(
      `${decided.falseHolds} of ${fine} plain reviews the classifier decides were held for the owner (limit: ${Math.round(MAX_FALSE_HOLD_RATE * 100)}%)`,
    );
  }
  return failures;
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

function why(r: RoutingResult): string {
  if (r.outcome.status === "error") return `classifier error: ${r.outcome.error}`;
  const reasons = r.outcome.verdict.reasons.join(", ");
  return `classifier: ${r.outcome.verdict.delicate ? "delicate" : "not delicate"}${reasons ? ` (${reasons})` : ""}; route: ${r.rule}`;
}

export function formatRoutingMarkdown(report: RoutingReport): string {
  const lines = [
    `# Review routing eval${report.dryRun ? " (dry run, fake classifier)" : ""}`,
    "",
    `Model: ${report.model}. Prompt hash: ${report.promptHash}. Cases: ${report.cases}.`,
    "",
    report.passed
      ? `Result: PASS, 0 delicate review(s) would have been posted (target: 0).`
      : `Result: FAIL: ${report.failures.join("; ")}.`,
    "",
    "| | Recall on delicate | Precision | Misses | False holds |",
    "|---|---|---|---|---|",
    `| What reaches the owner (classifier, tripwire, stars) | ${pct(report.system.recall)} | ${pct(report.system.precision)} | ${report.system.misses} | ${report.system.falseHolds} |`,
    `| Cases only the classifier decides (${report.classifierDecided.delicate} delicate: rating 3+, no tripwire hit) | ${pct(report.classifierDecided.recall)} | ${pct(report.classifierDecided.precision)} | ${report.classifierDecided.misses} | ${report.classifierDecided.falseHolds} |`,
    `| Classifier alone | ${pct(report.classifier.recall)} | ${pct(report.classifier.precision)} | ${report.classifier.misses} | ${report.classifier.falseHolds} |`,
    "",
    `Classifier errors (each sent to the owner): ${report.errors}.`,
    "",
    "## By language",
    "",
    "| Language | Cases | Delicate | Recall | Precision | Misses | False holds | Errors |",
    "|---|---|---|---|---|---|---|---|",
    ...report.byLanguage.map(
      (l) => `| ${l.language} | ${l.cases} | ${l.delicate} | ${pct(l.recall)} | ${pct(l.precision)} | ${l.misses} | ${l.falseHolds} | ${l.errors} |`,
    ),
    "",
    ...(report.errors === 0 ? [] : ["## Classifier errors", "", ...report.erroredCases.map((r) => `- ${r.id}: ${why(r)}`), ""]),
    "## Misses",
    "",
    ...(report.missed.length === 0 ? ["None."] : report.missed.map((r) => `- ${r.id} (${r.rating} stars): "${cell(r.text)}". ${why(r)}`)),
    "",
    "## False holds",
    "",
    ...(report.falseHolds.length === 0 ? ["None."] : report.falseHolds.map((r) => `- ${r.id} (${r.rating} stars): "${cell(r.text)}". ${why(r)}`)),
    "",
    "## Cost",
    "",
    `${report.usage.inputTokens} input and ${report.usage.outputTokens} output tokens, about $${report.costUsd.toFixed(4)}.`,
    "",
  ];
  return lines.join("\n");
}

// Runs the classifier over the set a few at a time. A call that throws or
// times out becomes an error outcome, which routes to the owner.
export async function classifyAll(
  set: readonly RoutingCase[],
  classifier: AsyncReviewClassifier,
  options: { readonly concurrency?: number; readonly timeoutMs?: number } = {},
): Promise<RoutingResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const results: RoutingResult[] = new Array(set.length);
  let next = 0;
  const worker = async () => {
    while (next < set.length) {
      const i = next++;
      const c = set[i]!;
      results[i] = routeCase(c, await classifyOne(classifier, c, timeoutMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, set.length) }, worker));
  return results;
}

async function classifyOne(classifier: AsyncReviewClassifier, c: RoutingCase, timeoutMs: number): Promise<ClassifierOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await classifier.classify({ reviewId: c.id, rating: c.rating, text: c.text }, controller.signal);
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
