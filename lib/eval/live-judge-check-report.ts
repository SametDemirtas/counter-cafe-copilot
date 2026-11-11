// The judge check's report: what it measured, per split and per criterion
// type, and every disagreement with the labels, as markdown.

import { CRITERION_TYPES, STRICT_TYPES } from "./live-criteria.js";
import { type Disagreement, type Split, type SplitStats, strictTnr, tnr, tpr } from "./live-judge-check.js";

export interface JudgeCheckReport {
  readonly at: string;
  readonly judgeModel: string;
  readonly promptHash: string;
  readonly criteriaHash: string;
  readonly barHash: string;
  readonly dryRun: boolean;
  readonly costUsd: number;
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly splits: Readonly<Record<Split, SplitStats>>;
  readonly disagreements: readonly Disagreement[];
}

const fmt = (x: number | undefined): string => (x === undefined ? "n/a" : x.toFixed(3));

export function checkMarkdown(r: JudgeCheckReport): string {
  const lines = [
    "# Judge check",
    "",
    `Judge: \`${r.judgeModel}\` · prompt hash \`${r.promptHash}\` · criteria hash \`${r.criteriaHash}\` · bar hash \`${r.barHash}\` · ${r.at}${r.dryRun ? " · DRY RUN (fake judge, proves nothing)" : ""}`,
    "",
    `**${r.passed ? "PASSED" : "NOT PASSED"}**: the live run ${r.passed ? "may use this judge" : "will not use this judge unless EVAL_JUDGE=unvalidated"}.`,
    ...r.reasons.map((x) => `- ${x}`),
    "",
    `Spend: $${r.costUsd.toFixed(2)}`,
    "",
  ];
  for (const [split, s] of Object.entries(r.splits) as [Split, SplitStats][]) {
    lines.push(
      `## ${split}`,
      "",
      `${s.items} labelled answers; ${s.judged} judged; ${s.codeCaught} bad answers already failed by the code checks (not judged).`,
      "",
      "| level | TPR (good judged pass) | TNR (bad judged fail) | kappa | judge errors |",
      "| --- | --- | --- | --- | --- |",
      `| answer | ${fmt(tpr(s.answers))} (${s.answers.tp}/${s.answers.tp + s.answers.fn}) | ${fmt(tnr(s.answers))} (${s.answers.tn}/${s.answers.tn + s.answers.fp}) | ${fmt(s.answerKappa)} | ${s.answersWithErrors} |`,
      `| criterion | ${fmt(tpr(s.criteria))} (${s.criteria.tp}/${s.criteria.tp + s.criteria.fn}) | ${fmt(tnr(s.criteria))} (${s.criteria.tn}/${s.criteria.tn + s.criteria.fp}) | ${fmt(s.criterionKappa)} | ${s.criteria.errors} |`,
      "",
      "| criterion type | strict | TPR | TNR | judge errors |",
      "| --- | --- | --- | --- | --- |",
      ...CRITERION_TYPES.filter((t) => s.byType[t]).map((t) => {
        const x = s.byType[t]!;
        const strict = STRICT_TYPES.has(t);
        const negatives = x.tn + x.fp + (strict ? x.badErrors : 0);
        return `| ${t} | ${strict ? "yes" : ""} | ${fmt(tpr(x))} (${x.tp}/${x.tp + x.fn}) | ${fmt(strict ? strictTnr(x) : tnr(x))} (${x.tn}/${negatives}) | ${x.errors} |`;
      }),
      "",
      ...(s.unlabelledBad > 0 ? [`${s.unlabelledBad} bad answer(s) have several criteria and no label of which they break; they count at answer level only.`, ""] : []),
    );
  }
  lines.push(`## Disagreements (${r.disagreements.length})`, "");
  if (r.disagreements.length === 0) lines.push("None.");
  for (const d of r.disagreements) {
    lines.push(
      `### ${d.key} (${d.split}, labelled ${d.label}, judged ${d.judged})`,
      "",
      `- question: ${d.question}`,
      `- answer: "${d.answer.replace(/\s+/g, " ")}"`,
      ...d.proposalTexts.map((t) => `- proposal: "${t.replace(/\s+/g, " ")}"`),
      ...(d.criterion ? [`- criterion [${d.criterion.type}]: ${d.criterion.text}`] : []),
      ...(d.evidence ? [`- judge's evidence: "${d.evidence}"`] : []),
      ...(d.note ? [`- note: ${d.note}`] : []),
      "",
    );
  }
  return lines.join("\n");
}
