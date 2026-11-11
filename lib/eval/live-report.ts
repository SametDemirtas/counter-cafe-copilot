// The live report: aggregation per scenario, token totals, and the markdown and
// JSON renderings. Pure, so it is tested without a key.

import { type CriterionVerdict } from "./live-judge.js";
import { type LiveScenario } from "./live-scenarios.js";
import { type LiveOutcome, type RepStatus, type RepSummary, summariseReps } from "./live-score.js";
import { type EvalSet, type SetTally, tally } from "./live-sets.js";
import { isSafetyFailure } from "./safety-rail.js";

// Why a run has no score: the spending cap or a fatal API error stopped it
// starting, a server error outlasted the retries (infra, the judge's included),
// a fatal API error stopped it partway (cut_off) after it had spent tokens, or
// the code checks passed but the judge could not back a verdict with a quote
// (unjudged), so the run is neither a pass nor a fail.
export type SkipReason = "budget" | "aborted" | "infra" | "cut_off" | "unjudged";

// How behaviour was graded in this run.
export interface JudgeMeta {
  // validated: a passing judge-check for this exact prompt and criteria;
  // unvalidated: EVAL_JUDGE=unvalidated; off: criteria not graded; fake: dry run.
  readonly mode: "validated" | "unvalidated" | "off" | "fake";
  readonly model?: string;
  readonly promptHash?: string;
  readonly criteriaHash?: string;
  // When the judge-check that validated it ran.
  readonly checkedAt?: string;
  // Why an unvalidated judge did not pass the gate.
  readonly reason?: string;
}

// One finished run as the record keeps it, so a failure can be settled later
// from the report alone.
export interface RunRecord {
  readonly failures: readonly string[];
  readonly text: string;
  readonly proposalKinds: readonly string[];
  readonly proposalTexts: readonly string[];
  readonly status?: readonly string[];
  // The judge's verdict on every criterion, with its evidence quote.
  readonly judge?: readonly CriterionVerdict[];
  // Set when the run has an answer but no score (unjudged, or a judge infra error).
  readonly unscored?: SkipReason;
}

export interface RepRun {
  readonly id: string;
  readonly failures: readonly string[];
  readonly outcome: LiveOutcome;
  readonly usage?: Usage;
  readonly skipped?: SkipReason;
  // The API rejected one of this run's requests as malformed (400).
  readonly badRequest?: string;
  readonly judge?: readonly CriterionVerdict[];
}

// What the report says about the run as a whole.
export interface RunMeta {
  // Set when the run stopped early, e.g. "aborted because authentication failed (401)".
  readonly incomplete?: string;
  readonly costUsd?: number;
  // The judge's share of costUsd.
  readonly judgeCostUsd?: number;
  readonly maxUsd?: number;
  readonly judge?: JudgeMeta;
  // The ids EVAL_ONLY picked, when it did; the set is then reported as that list.
  readonly only?: readonly string[];
  // A dry run spends nothing; its token counts are synthetic and never priced.
  readonly dryRun?: boolean;
  // The output_config.effort the model ran at; results depend on it.
  readonly effort?: string;
}

export function skippedRun(id: string, reason: SkipReason): RepRun {
  return { id, failures: [], skipped: reason, outcome: { text: "", proposalKinds: [], executed: 0, escalated: 0, notPending: 0 } };
}

export interface Usage {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
}

export interface RunTotals {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  // Runs where the model stated a figure no tool gave and had to be corrected.
  readonly correctedRuns: number;
}

export function totalUsage(runs: readonly RepRun[]): RunTotals {
  return runs.reduce<RunTotals>(
    (sum, r) => ({
      modelCalls: sum.modelCalls + (r.usage?.modelCalls ?? 0),
      inputTokens: sum.inputTokens + (r.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (r.usage?.outputTokens ?? 0),
      cacheReadTokens: sum.cacheReadTokens + (r.usage?.cacheReadTokens ?? 0),
      correctedRuns: sum.correctedRuns + ((r.outcome.corrections ?? 0) > 0 ? 1 : 0),
    }),
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, correctedRuns: 0 },
  );
}

export interface ScenarioReport {
  readonly scenario: LiveScenario;
  readonly summary: RepSummary;
  readonly sample: string;
  // Runs that never started; neither passes nor failures.
  readonly skipped: number;
  readonly skipReason?: SkipReason;
  // Of the skipped runs, those lost to a server error rather than never started.
  readonly infraErrors: number;
  // Of the skipped runs, those a fatal API error stopped partway.
  readonly cutOff: number;
  // Of the skipped runs, those the judge could not grade.
  readonly unjudged: number;
  // Every run that finished, in order.
  readonly runs: readonly RunRecord[];
}

// undefined means the value is invalid and the run must stop, never zero runs reported green.
export function parsePositiveInt(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

// The sample shown is a failing run's answer when there is one. Skipped runs
// count for neither side; a scenario with only skipped runs is "skipped". A run
// with a failure always counts, whatever else marked it skipped, so no caller
// can turn a failed run into an unscored one.
export function aggregate(scenarios: readonly LiveScenario[], runs: readonly RepRun[]): ScenarioReport[] {
  return scenarios.map((scenario) => {
    const mine = runs.filter((r) => r.id === scenario.id);
    const scored = (r: RepRun) => r.skipped === undefined || r.failures.length > 0;
    const ran = mine.filter(scored);
    const skips = mine.filter((r) => !scored(r));
    const failing = ran.find((r) => r.failures.length > 0);
    const summary = summariseReps(ran.map((r) => r.failures));
    const onlySkipped = ran.length === 0 && skips.length > 0;
    return {
      scenario,
      summary: onlySkipped ? { ...summary, status: "skipped" as const } : summary,
      sample: (failing ?? ran[0])?.outcome.text ?? "",
      skipped: skips.length,
      ...(skips[0]?.skipped ? { skipReason: skips[0].skipped } : {}),
      infraErrors: skips.filter((r) => r.skipped === "infra").length,
      cutOff: skips.filter((r) => r.skipped === "cut_off").length,
      unjudged: skips.filter((r) => r.skipped === "unjudged").length,
      // Every run with an answer, scored or not, so any verdict can be settled from the record.
      runs: mine
        .filter((r) => r.skipped === undefined || r.outcome.text !== "" || r.failures.length > 0)
        .map((r) => ({
          failures: r.failures,
          text: r.outcome.text,
          proposalKinds: r.outcome.proposalKinds,
          proposalTexts: r.outcome.proposalTexts ?? [],
          ...(r.outcome.status ? { status: r.outcome.status.map((l) => l.text) } : {}),
          ...(r.judge ? { judge: r.judge } : {}),
          ...(r.skipped && !scored(r) ? { unscored: r.skipped } : {}),
        })),
    };
  });
}

function judgeLine(judge: JudgeMeta | undefined): string {
  if (!judge || judge.mode === "off") return "Behaviour: NOT GRADED (EVAL_JUDGE=off). Only the code checks ran; criteria were skipped.";
  const id = `\`${judge.model ?? "?"}\` (prompt ${judge.promptHash ?? "?"}, criteria ${judge.criteriaHash ?? "?"})`;
  if (judge.mode === "fake") return "Behaviour: graded by a fake judge (dry run): it fails every criterion for a non-answer and passes the rest.";
  if (judge.mode === "unvalidated") {
    return `Behaviour: judged by ${id}. **UNVALIDATED JUDGE** (EVAL_JUDGE=unvalidated): no passing judge check backs these verdicts${judge.reason ? ` (${judge.reason})` : ""}.`;
  }
  return `Behaviour: judged by ${id}, validated by the judge check of ${judge.checkedAt ?? "?"}.`;
}

export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

const count = (n: number): string => n.toLocaleString("en-US");

function rate(passes: number, runs: number): string {
  return runs === 0 ? "0%" : pct(passes / runs);
}

function setLine(name: string, t: SetTally): string {
  return `**${name}: ${t.passes}/${t.runs} runs passed (${rate(t.passes, t.runs)}), ${t.green}/${t.scenarios} scenarios green**`;
}

function categoryTable(reports: readonly ScenarioReport[], split: boolean): string[] {
  const cats = new Map<string, { dev: [number, number]; heldOut: [number, number] }>();
  for (const r of reports) {
    const c = cats.get(r.scenario.category) ?? { dev: [0, 0], heldOut: [0, 0] };
    const cell = r.scenario.heldOut ? c.heldOut : c.dev;
    cell[1] += 1;
    if (r.summary.status === "green") cell[0] += 1;
    cats.set(r.scenario.category, c);
  }
  const rows = [...cats.entries()].sort(([a], [b]) => a.localeCompare(b));
  const cell = ([pass, total]: [number, number]) => (total === 0 ? "-" : `${pass}/${total}`);
  if (split) {
    return [
      "| category | dev green/total | held-out green/total |",
      "| --- | --- | --- |",
      ...rows.map(([cat, c]) => `| ${cat} | ${cell(c.dev)} | ${cell(c.heldOut)} |`),
    ];
  }
  // One set ran, so one of the two cells is always empty.
  const both = ([a, b]: [number, number], [c, d]: [number, number]): [number, number] => [a + c, b + d];
  return ["| category | green/total |", "| --- | --- |", ...rows.map(([cat, c]) => `| ${cat} | ${cell(both(c.dev, c.heldOut))} |`)];
}

export function buildMarkdown(
  model: string,
  reps: number,
  reports: readonly ScenarioReport[],
  at: string,
  set: EvalSet,
  usage?: RunTotals,
  meta: RunMeta = {},
): string {
  const withStatus = (status: RepStatus) => reports.filter((r) => r.summary.status === status).length;
  const safety = reports.filter((r) => r.summary.safety);
  const runs = reports.reduce((s, r) => s + r.summary.reps, 0);
  const passes = reports.reduce((s, r) => s + r.summary.passes, 0);
  const split = set === "all";
  const tag = (r: ScenarioReport) => (r.scenario.heldOut ? " (held-out)" : "");

  const skippedRuns = reports.reduce((s, r) => s + r.skipped, 0);
  const infraRuns = reports.reduce((s, r) => s + r.infraErrors, 0);
  const cutOffRuns = reports.reduce((s, r) => s + r.cutOff, 0);
  const unjudgedRuns = reports.reduce((s, r) => s + r.unjudged, 0);
  const neverStarted = skippedRuns - infraRuns - cutOffRuns - unjudgedRuns;
  const lines = [
    "# Counter live model eval",
    "",
    ...(meta.incomplete ? [`**INCOMPLETE: ${meta.incomplete}.** Everything below is what finished before that.`, ""] : []),
    `Model: \`${model}\`${meta.effort ? ` · effort: ${meta.effort}` : ""} · set: ${meta.only ? `EVAL_ONLY (${meta.only.join(", ")})` : set} · ${reports.length} scenarios × ${reps} rep(s) = ${reports.length * reps} runs${runs < reports.length * reps ? `, ${runs} finished` : ""} · ${at}`,
    "",
    judgeLine(meta.judge),
    "",
    `**Run pass rate: ${passes}/${runs} (${rate(passes, runs)})**`,
    ...(split ? [setLine("Dev", tally(reports, false)), setLine("Held-out", tally(reports, true))] : []),
    ...(split && tally(reports, true, true).scenarios > 0 ? [setLine("Of which the owner sets", tally(reports, true, true))] : []),
    `**Scenarios: ${withStatus("green")} green, ${withStatus("flaky")} flaky, ${withStatus("red")} red, ${withStatus("skipped")} skipped** - safety failures: ${safety.length}`,
    ...(neverStarted > 0 ? [`Skipped runs (never started, neither passed nor failed): ${neverStarted}`] : []),
    ...(unjudgedRuns > 0 ? [`Unjudged runs (code checks passed, the judge could not return a verified verdict; neither passed nor failed): ${unjudgedRuns}`] : []),
    ...(cutOffRuns > 0 ? [`Runs cut off mid-run by a fatal API error (tokens spent and counted in the spend, not scored): ${cutOffRuns}`] : []),
    ...(infraRuns > 0 ? [`Infrastructure errors (API server errors after retries, neither passed nor failed): ${infraRuns}`] : []),
    ...(meta.costUsd !== undefined
      ? [
          `Spend: $${meta.costUsd.toFixed(2)}${meta.judgeCostUsd ? ` ($${meta.judgeCostUsd.toFixed(2)} of it the judge)` : ""}` +
            `${meta.maxUsd !== undefined ? ` of a $${meta.maxUsd.toFixed(2)} cap` : ""}`,
        ]
      : []),
    ...(meta.dryRun ? ["Dry run: no model was called. Its token counts are synthetic, so no cost is shown for them."] : []),
    ...(usage && usage.modelCalls > 0
      ? [
          "",
          `Tokens: ${count(usage.inputTokens)} in (${count(usage.cacheReadTokens)} read from cache), ${count(usage.outputTokens)} out ` +
            `over ${count(usage.modelCalls)} model calls (${count(Math.round(usage.inputTokens / Math.max(1, runs)))} in per question on average).`,
          `Figure corrections: ${usage.correctedRuns} of ${runs} runs stated a figure no tool gave and were corrected.`,
        ]
      : []),
    "",
    "## By category (green scenarios)",
    "",
    ...categoryTable(reports, split),
    "",
  ];

  if (safety.length > 0) {
    lines.push("## Safety failures (blockers)", "");
    for (const r of safety) lines.push(`- **${r.scenario.id}**${tag(r)}: ${r.summary.failures.filter(isSafetyFailure).join("; ")}`);
    lines.push("");
  }

  const skippedList = reports.filter((r) => r.skipped > 0);
  if (skippedList.length > 0) {
    lines.push("## Skipped", "");
    for (const r of skippedList) lines.push(`- ${r.scenario.id}${tag(r)}: ${r.skipped} run(s) skipped (${r.skipReason ?? "budget"})`);
    lines.push("");
  }

  const problems = reports.filter((r) => r.summary.status === "red" || r.summary.status === "flaky");
  if (problems.length === 0) {
    lines.push(skippedList.length === 0 && !meta.incomplete ? "All scenarios green." : "No failures among the runs that finished.");
    return lines.join("\n");
  }
  lines.push("## Failures and flaky scenarios", "");
  for (const r of problems) {
    lines.push(`### ${r.summary.status.toUpperCase()} · ${r.scenario.id}${tag(r)} (${r.scenario.category}) - ${pct(r.summary.passRate)} pass`, "");
    lines.push(`- question: ${r.scenario.question}`);
    for (const f of r.summary.failures) lines.push(`- ✗ ${f}`);
    lines.push(`- model said: "${truncate(r.sample, 300)}"`);
    const judged = r.runs.find((x) => x.text === r.sample && x.judge)?.judge ?? [];
    for (const v of judged) {
      const mark = v.verdict === "pass" ? "✓" : v.verdict === "fail" ? "✗" : "?";
      lines.push(`  - judge ${mark} [${v.type}] ${v.text} (evidence: "${truncate(v.evidence, 160)}")`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function buildJson(
  model: string,
  reps: number,
  reports: readonly ScenarioReport[],
  at: string,
  set: EvalSet,
  usage?: RunTotals,
  meta: RunMeta = {},
): string {
  const rows = reports.map((r) => ({
    id: r.scenario.id,
    category: r.scenario.category,
    heldOut: r.scenario.heldOut ?? false,
    ...r.summary,
    skipped: r.skipped,
    ...(r.skipReason ? { skipReason: r.skipReason } : {}),
    infraErrors: r.infraErrors,
    ...(r.cutOff > 0 ? { cutOff: r.cutOff } : {}),
    ...(r.unjudged > 0 ? { unjudged: r.unjudged } : {}),
    sample: r.sample,
    runs: r.runs,
  }));
  const sets = { dev: tally(reports, false), heldOut: tally(reports, true), owner: tally(reports, true, true) };
  const ranRuns = reports.reduce((s, r) => s + r.summary.reps, 0);
  const skippedRuns = reports.reduce((s, r) => s + r.skipped, 0);
  const infraErrors = reports.reduce((s, r) => s + r.infraErrors, 0);
  return JSON.stringify(
    {
      model,
      ...(meta.effort ? { effort: meta.effort } : {}),
      reps,
      at,
      set,
      ...(meta.only ? { only: meta.only } : {}),
      ...(meta.incomplete ? { incomplete: meta.incomplete } : {}),
      ranRuns,
      skippedRuns,
      infraErrors,
      // Rounded to a hundredth of a cent so the file shows no float noise.
      ...(meta.costUsd !== undefined ? { costUsd: Math.round(meta.costUsd * 10_000) / 10_000 } : {}),
      ...(meta.judgeCostUsd !== undefined ? { judgeCostUsd: Math.round(meta.judgeCostUsd * 10_000) / 10_000 } : {}),
      ...(meta.judge ? { judge: meta.judge } : {}),
      ...(meta.maxUsd !== undefined ? { maxUsd: meta.maxUsd } : {}),
      ...(meta.dryRun ? { dryRun: true } : {}),
      sets,
      ...(usage ? { usage } : {}),
      reports: rows,
    },
    null,
    2,
  );
}
