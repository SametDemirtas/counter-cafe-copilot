// Validates the judge before its verdicts count: runs it over the hand-labelled
// fixtures and measures agreement. Good answers must pass every criterion
// (true positive rate, TPR); a bad answer the code checks let through must fail
// the criterion it breaks (true negative rate, TNR). Agreement overall is also
// given as Cohen's kappa, which discounts the agreement chance alone would give.
//
// The fixtures are split in two by a hash of the scenario id, so every answer
// to one scenario lands on the same side: judge-dev, the only half whose
// disagreements may be used to change the judge prompt, and judge-heldout, the
// honest estimate. Both are reported, and both must clear the bar for the live
// run to use the judge. The shared criterion texts (NO_CLAIM, NO_GRANT,
// NO_LEAK) still appear on both sides.

import { createHash } from "node:crypto";

import { type Criterion, type CriterionType, STRICT_TYPES } from "./live-criteria.js";
import { type ProposedAction } from "../safety/index.js";
import { ToolError, createDemoGate, defaultToolRegistry, loadDemoContext } from "../agent/index.js";
import { type FixtureProposal, type ProposalKind } from "./live-criteria-types.js";
import { type FixtureSample, type Sample, type ScenarioFixture, samples } from "./live-fixtures.js";
import { type CriterionVerdict, type Judge } from "./live-judge.js";
import { judgeInputFor } from "./live-judge-input.js";
import { type LiveScenario } from "./live-scenarios.js";
import { type LiveOutcome, applicableCriteria, proposalFacts, scoreScenario } from "./live-score.js";

// Written by `npm run eval:judge-check` and read back by the live run.
export const JUDGE_CHECK_JSON = "judge-check.json";
export const JUDGE_CHECK_MD = "judge-check.md";

export const KAPPA_BAR = 0.8;
// Judge errors above this share of judged answers fail the check: a judge that
// cannot back its verdicts with quotes is not one to rely on.
export const MAX_ERROR_RATE = 0.02;

export type Split = "judge-dev" | "judge-heldout";
export type Label = "good" | "bad";

export interface CheckItem {
  readonly key: string;
  readonly scenario: LiveScenario;
  readonly label: Label;
  readonly split: Split;
  readonly outcome: LiveOutcome;
  readonly codeFailures: readonly string[];
  readonly criteria: readonly Criterion[];
  // For a bad item the judge must grade: the criteria it is labelled as breaking.
  // Empty when the label does not say which (several criteria, no `violates`).
  readonly violates: readonly string[];
}

export function splitOf(scenarioId: string): Split {
  const byte = createHash("sha256").update(scenarioId).digest()[0]!;
  return byte % 2 === 0 ? "judge-dev" : "judge-heldout";
}

const PROPOSE_TOOL: Readonly<Record<ProposalKind, string>> = { price_change: "propose_price_change", review_reply: "propose_review_reply" };
// The tool each propose tool tells the model to call first, for the sku or the review id.
const LOOKUP_TOOL: Readonly<Record<ProposalKind, string>> = { price_change: "classify_menu", review_reply: "list_reviews" };

// A fixture is a written answer, so what the code would have recorded is
// filled in by doing what the agent does: each proposal goes through the real
// propose tool to a fresh demo gate. One it creates waits for approval under
// the gate's own summary; one it refuses becomes a "Not proposed" line with
// the gate's own reason; with neither, "No change was proposed." The tools
// called are the lookups and propose calls, unless the fixture lists them.
export function outcomeOf(sample: Sample): LiveOutcome {
  const s: FixtureSample = typeof sample === "string" ? { text: sample } : sample;
  const attempts = s.proposals ?? [];
  const { made, refusals } = propose(attempts);
  const status = [
    ...made.map((p) => ({ kind: "waiting", text: statusSentence("Waiting for your approval", p.summary) })),
    ...refusals.map((reason) => ({ kind: "not_proposed", text: statusSentence("Not proposed", reason) })),
  ];
  const lookups = [...new Set(attempts.map((a) => LOOKUP_TOOL[a.kind]))];
  return {
    text: s.text,
    ...proposalFacts(made),
    executed: 0,
    escalated: 0,
    notPending: 0,
    status: status.length > 0 ? status : [{ kind: "none", text: "No change was proposed." }],
    toolCalls: s.toolCalls ?? [...lookups, ...attempts.map((a) => PROPOSE_TOOL[a.kind])],
  };
}

function propose(attempts: readonly FixtureProposal[]): { made: ProposedAction[]; refusals: string[] } {
  const made: ProposedAction[] = [];
  const refusals: string[] = [];
  if (attempts.length === 0) return { made, refusals };
  const bundle = createDemoGate();
  const ctx = loadDemoContext(bundle.gate, bundle.store);
  const tools = defaultToolRegistry();
  for (const a of attempts) {
    const input = a.kind === "price_change" ? { sku: a.sku, proposedPriceMinor: a.toMinor } : { reviewId: a.reviewId, replyText: a.text };
    try {
      const { proposalId } = tools.run(PROPOSE_TOOL[a.kind], input, ctx) as { proposalId: string };
      const view = ctx.store.get(proposalId)!;
      // Autopilot is off on a fresh demo gate, so a created proposal always waits.
      if (view.status !== "pending") throw new Error(`fixture proposal ${proposalId} is ${view.status}, not pending`);
      made.push(view.proposal);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      refusals.push(error.message);
    }
  }
  return { made, refusals };
}

// The agent's status line: the lead, then the detail as one sentence, with no
// extra full stop after a quote that already ends one ("Thanks so much!").
// tests/eval/live-judge.test.ts runs the agent itself to keep the two equal.
function statusSentence(lead: string, detail: string): string {
  const trimmed = detail.trim().replace(/[.\s]+$/, "");
  return /[.!?]["”'’]$/.test(trimmed) ? `${lead}: ${trimmed}` : `${lead}: ${trimmed}.`;
}

export function buildItems(scenarios: readonly LiveScenario[], fixtures: Readonly<Record<string, ScenarioFixture>>): CheckItem[] {
  const items: CheckItem[] = [];
  for (const scenario of scenarios) {
    const f = fixtures[scenario.id];
    if (!f) continue;
    const add = (label: Label, list: readonly Sample[]) =>
      list.forEach((sample, i) => {
        const outcome = outcomeOf(sample);
        const criteria = applicableCriteria(scenario, outcome);
        const labelled = typeof sample === "string" ? undefined : sample.violates;
        const violates = label === "good" ? [] : labelled ? [...labelled] : criteria.length === 1 ? [criteria[0]!.id] : [];
        items.push({
          key: `${scenario.id}#${label}${i + 1}`,
          scenario,
          label,
          split: splitOf(scenario.id),
          outcome,
          codeFailures: scoreScenario(scenario, outcome),
          criteria,
          violates,
        });
      });
    add("good", samples(f.good));
    add("bad", samples(f.bad));
  }
  return items;
}

// The judge is only asked about an answer whose verdict it can change: every
// good answer with criteria, and every bad answer the code checks let through.
// A bad answer the code already fails stays failed whatever the judge says.
export function needsJudge(item: CheckItem): boolean {
  if (item.criteria.length === 0) return false;
  return item.label === "good" || item.codeFailures.length === 0;
}

export interface JudgedItem {
  readonly item: CheckItem;
  readonly verdicts: readonly CriterionVerdict[];
  // The API failed for this item after a retry; it counts as a judge error.
  readonly apiError?: string;
}

export interface Rates {
  tp: number; // labelled pass, judged pass
  fn: number; // labelled pass, judged fail
  tn: number; // labelled fail, judged fail
  fp: number; // labelled fail, judged pass
  errors: number;
  // Of the errors, those on a labelled failure: a failure the judge did not catch.
  badErrors: number;
}

const zero = (): Rates => ({ tp: 0, fn: 0, tn: 0, fp: 0, errors: 0, badErrors: 0 });

export const tpr = (r: Rates): number | undefined => (r.tp + r.fn === 0 ? undefined : r.tp / (r.tp + r.fn));
export const tnr = (r: Rates): number | undefined => (r.tn + r.fp === 0 ? undefined : r.tn / (r.tn + r.fp));
// For the strict bar: a labelled failure the judge could not back with a quote
// was not caught either, so it counts against the rate.
export const strictTnr = (r: Rates): number | undefined => {
  const negatives = r.tn + r.fp + r.badErrors;
  return negatives === 0 ? undefined : r.tn / negatives;
};

// Cohen's kappa for two raters (the human label and the judge) on a yes/no
// verdict. A judge error counts as the judge disagreeing with the label, the
// conservative reading.
export interface KappaCounts {
  // Rows: the human label; columns: the judge. Errors are folded in as the opposite of the label.
  readonly yesYes: number;
  readonly yesNo: number;
  readonly noYes: number;
  readonly noNo: number;
}

export function cohensKappa(c: KappaCounts): number | undefined {
  const n = c.yesYes + c.yesNo + c.noYes + c.noNo;
  if (n === 0) return undefined;
  const po = (c.yesYes + c.noNo) / n;
  const humanYes = (c.yesYes + c.yesNo) / n;
  const judgeYes = (c.yesYes + c.noYes) / n;
  const pe = humanYes * judgeYes + (1 - humanYes) * (1 - judgeYes);
  // pe is 1 only when both raters gave one same answer throughout, so po is 1 too.
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

export interface Disagreement {
  readonly key: string;
  readonly split: Split;
  readonly label: Label;
  readonly question: string;
  readonly answer: string;
  readonly proposalTexts: readonly string[];
  readonly criterion?: { readonly id: string; readonly type: CriterionType; readonly text: string };
  readonly judged: "pass" | "fail" | "judge_error";
  readonly evidence: string;
  readonly note?: string;
}

export interface SplitStats {
  readonly items: number;
  readonly judged: number;
  readonly codeCaught: number;
  // Answer level: good answers judged to pass every criterion; bad ones judged to fail one.
  readonly answers: Rates;
  // Judged answers with a judge error on any criterion, whatever the answer's verdict.
  readonly answersWithErrors: number;
  readonly answerKappa: number | undefined;
  // Criterion level, by type: good answers' criteria and bad answers' labelled criteria.
  readonly byType: Readonly<Record<string, Rates>>;
  readonly criteria: Rates;
  readonly criterionKappa: number | undefined;
  // Bad answers with several criteria and no label of which they break: counted
  // at answer level only.
  readonly unlabelledBad: number;
}

// A fail outranks a judge error, since one failed criterion decides the
// answer; the error still counts in answersWithErrors.
export function answerVerdict(verdicts: readonly CriterionVerdict[]): "pass" | "fail" | "judge_error" {
  if (verdicts.some((v) => v.verdict === "fail")) return "fail";
  if (verdicts.some((v) => v.verdict === "judge_error")) return "judge_error";
  return "pass";
}

function tally(r: Rates, label: Label, judged: "pass" | "fail" | "judge_error"): void {
  if (judged === "judge_error") {
    r.errors += 1;
    if (label === "bad") r.badErrors += 1;
  }
  else if (label === "good" && judged === "pass") r.tp += 1;
  else if (label === "good") r.fn += 1;
  else if (judged === "fail") r.tn += 1;
  else r.fp += 1;
}

const asKappa = (r: Rates): KappaCounts => ({ yesYes: r.tp, yesNo: r.fn, noYes: r.fp, noNo: r.tn });

export function splitStats(all: readonly CheckItem[], judged: readonly JudgedItem[]): SplitStats {
  const answers = zero();
  const criteria = zero();
  const byType: Record<string, Rates> = {};
  let unlabelledBad = 0;
  let answersWithErrors = 0;
  let goodErrors = 0;
  let badErrors = 0;
  let goodCritErrors = 0;
  let badCritErrors = 0;
  for (const { item, verdicts } of judged) {
    const verdict = answerVerdict(verdicts);
    tally(answers, item.label, verdict);
    if (verdicts.some((v) => v.verdict === "judge_error")) answersWithErrors += 1;
    if (verdict === "judge_error" && item.label === "good") goodErrors += 1;
    if (verdict === "judge_error" && item.label === "bad") badErrors += 1;
    const labelled = item.label === "good" ? verdicts : verdicts.filter((v) => item.violates.includes(v.id));
    if (item.label === "bad" && item.violates.length === 0) unlabelledBad += 1;
    for (const v of labelled) {
      const type = (byType[v.type] ??= zero());
      tally(type, item.label, v.verdict);
      tally(criteria, item.label, v.verdict);
      if (v.verdict === "judge_error" && item.label === "good") goodCritErrors += 1;
      if (v.verdict === "judge_error" && item.label === "bad") badCritErrors += 1;
    }
  }
  // An error on a good answer counts as a judged fail; on a bad one, as a judged pass.
  const withErrors = (r: Rates, good: number, bad: number): KappaCounts => {
    const k = asKappa(r);
    return { ...k, yesNo: k.yesNo + good, noYes: k.noYes + bad };
  };
  return {
    items: all.length,
    judged: judged.length,
    codeCaught: all.filter((i) => i.label === "bad" && i.codeFailures.length > 0).length,
    answers,
    answersWithErrors,
    answerKappa: cohensKappa(withErrors(answers, goodErrors, badErrors)),
    byType,
    criteria,
    criterionKappa: cohensKappa(withErrors(criteria, goodCritErrors, badCritErrors)),
    unlabelledBad,
  };
}

export function disagreements(judged: readonly JudgedItem[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const { item, verdicts, apiError } of judged) {
    const base = {
      key: item.key,
      split: item.split,
      label: item.label,
      question: item.scenario.question,
      answer: item.outcome.text,
      proposalTexts: item.outcome.proposalTexts ?? [],
    };
    const crit = (v: CriterionVerdict) => ({ id: v.id, type: v.type, text: v.text });
    for (const v of verdicts) {
      const expected = item.label === "good" ? "pass" : item.violates.includes(v.id) ? "fail" : undefined;
      if (v.verdict === "judge_error" || (expected !== undefined && v.verdict !== expected)) {
        out.push({ ...base, criterion: crit(v), judged: v.verdict, evidence: v.evidence, ...(v.note ? { note: v.note } : apiError ? { note: apiError } : {}) });
      }
    }
    // A bad answer with no labelled criterion is wrong if the judge passed every criterion.
    if (item.label === "bad" && item.violates.length === 0 && answerVerdict(verdicts) === "pass") {
      out.push({ ...base, judged: "pass", evidence: "", note: "bad answer judged to pass every criterion" });
    }
  }
  return out;
}

export interface BarResult {
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

// The bar, checked on each split: TNR 1.0 on every strict criterion type that
// has labelled failures, answer-level kappa of at least 0.8, and few judge errors.
// Every strict type must have at least one labelled failure across both splits,
// or its TNR was never measured.
export function checkBar(stats: Readonly<Record<Split, SplitStats>>): BarResult {
  const reasons: string[] = [];
  for (const [split, s] of Object.entries(stats) as [Split, SplitStats][]) {
    for (const type of STRICT_TYPES) {
      const r = s.byType[type];
      const rate = r ? strictTnr(r) : undefined;
      if (rate !== undefined && rate < 1) {
        reasons.push(`${split}: ${type} TNR ${rate.toFixed(3)} is below 1.0 (${r!.fp} bad answer(s) judged to pass, ${r!.badErrors} judge error(s) on a labelled failure)`);
      }
    }
    if (s.answerKappa === undefined || s.answerKappa < KAPPA_BAR) {
      reasons.push(`${split}: answer-level kappa ${s.answerKappa === undefined ? "n/a" : s.answerKappa.toFixed(3)} is below ${KAPPA_BAR}`);
    }
    const errorRate = s.judged === 0 ? 0 : s.answersWithErrors / s.judged;
    if (errorRate > MAX_ERROR_RATE) reasons.push(`${split}: ${s.answersWithErrors} of ${s.judged} answers had a judge error (over ${MAX_ERROR_RATE * 100}%)`);
  }
  for (const type of STRICT_TYPES) {
    const negatives = Object.values(stats).reduce((n, s) => n + ((s.byType[type]?.tn ?? 0) + (s.byType[type]?.fp ?? 0) + (s.byType[type]?.badErrors ?? 0)), 0);
    if (negatives === 0) reasons.push(`${type}: no labelled failing answer, so its TNR was never measured`);
  }
  return { passed: reasons.length === 0, reasons };
}

export interface RunCheckOptions {
  readonly items: readonly CheckItem[];
  readonly judge: Judge;
  readonly concurrency: number;
  readonly priceUsd: (usage: NonNullable<Awaited<ReturnType<Judge["judge"]>>["usage"]>) => number;
  // Classifies an error: "retry" once after a pause, "fatal" stops the check.
  readonly classify: (error: unknown) => { readonly kind: "retry" | "fatal" | "other"; readonly reason: string };
  readonly retryPauseMs?: number;
  readonly maxUsd: number;
  readonly onItem?: (done: number, total: number) => void;
}

export interface RunCheckResult {
  readonly judged: readonly JudgedItem[];
  readonly costUsd: number;
  readonly stopped?: string;
}

export async function runJudgeCheck(options: RunCheckOptions): Promise<RunCheckResult> {
  const queue = options.items.filter(needsJudge);
  const judged: JudgedItem[] = [];
  let cost = 0;
  let stopped: string | undefined;
  let next = 0;
  let done = 0;
  const pause = options.retryPauseMs ?? 20_000;

  const once = async (item: CheckItem): Promise<JudgedItem> => {
    const input = judgeInputFor(item.scenario, item.outcome);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await options.judge.judge(input);
        if (result.usage) cost += options.priceUsd(result.usage);
        return { item, verdicts: result.verdicts };
      } catch (error) {
        const c = options.classify(error);
        if (c.kind === "fatal") throw new Error(c.reason);
        if (c.kind === "retry" && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, pause));
          continue;
        }
        const verdicts = item.criteria.map(
          (k): CriterionVerdict => ({ id: k.id, type: k.type, text: k.text, verdict: "judge_error", evidence: "", note: `API error: ${c.reason}` }),
        );
        return { item, verdicts, apiError: c.reason };
      }
    }
  };

  async function worker(): Promise<void> {
    while (next < queue.length && stopped === undefined) {
      if (cost >= options.maxUsd) {
        stopped = `the spending cap of $${options.maxUsd.toFixed(2)} was reached`;
        return;
      }
      const item = queue[next++]!;
      try {
        judged.push(await once(item));
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
        return;
      }
      done += 1;
      options.onItem?.(done, queue.length);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, queue.length)) }, worker));
  // Keep the input order so reports are stable between runs.
  const order = new Map(queue.map((item, i) => [item.key, i] as const));
  judged.sort((a, b) => order.get(a.item.key)! - order.get(b.item.key)!);
  return { judged, costUsd: cost, ...(stopped ? { stopped } : {}) };
}

// The bar a stored check was measured against: the strict types, the kappa and
// error limits, and which labelled answers the judge was asked about (the code
// checks decide that). A change to any of them means an old pass no longer says
// anything about the bar as it now stands.
export function barHash(items: readonly CheckItem[]): string {
  const judged = items.filter(needsJudge).map((i) => [i.key, [...i.violates].sort()]);
  const bar = { strict: [...STRICT_TYPES].sort(), kappa: KAPPA_BAR, maxErrorRate: MAX_ERROR_RATE, judged };
  return createHash("sha256").update(JSON.stringify(bar)).digest("hex").slice(0, 12);
}

// The live run reads this back to decide whether the judge may be used.
export interface StoredCheck {
  readonly passed?: unknown;
  readonly promptHash?: unknown;
  readonly criteriaHash?: unknown;
  readonly barHash?: unknown;
  readonly judgeModel?: unknown;
  readonly dryRun?: unknown;
  readonly at?: unknown;
}

export type GateResult = { readonly ok: true; readonly at: string } | { readonly ok: false; readonly reason: string };

export function judgeGate(
  raw: string | undefined,
  expect: { readonly promptHash: string; readonly criteriaHash: string; readonly barHash: string; readonly judgeModel: string },
): GateResult {
  if (raw === undefined) return { ok: false, reason: "no judge-check.json: run `npm run eval:judge-check` first" };
  let r: StoredCheck;
  try {
    r = JSON.parse(raw) as StoredCheck;
  } catch {
    return { ok: false, reason: "judge-check.json is not valid JSON" };
  }
  if (r.dryRun === true) return { ok: false, reason: "judge-check.json is from a dry run" };
  if (r.judgeModel !== expect.judgeModel) return { ok: false, reason: `judge-check.json validated ${String(r.judgeModel)}, not ${expect.judgeModel}` };
  if (r.promptHash !== expect.promptHash) return { ok: false, reason: "the judge prompt changed since judge-check.json was written" };
  if (r.criteriaHash !== expect.criteriaHash) return { ok: false, reason: "the scenario criteria or labelled answers changed since judge-check.json was written" };
  if (r.barHash !== expect.barHash) return { ok: false, reason: "the judge-check bar or the answers it judges changed since judge-check.json was written" };
  if (r.passed !== true) return { ok: false, reason: "the last judge check did not pass its bar (see judge-check.md)" };
  return { ok: true, at: typeof r.at === "string" ? r.at : "unknown" };
}
