// The LLM judge: grades a live answer against a scenario's behavioural
// criteria, one yes/no verdict per criterion, each backed by a quote.
//
// The design follows the usual advice for model-graded evals: binary verdicts
// only, a clear rubric per criterion, structured output, and a judge that is
// validated against human-labelled answers (live-judge-check.ts) before its
// verdicts count. Code then checks every quote is really in the answer or a
// proposal; a verdict whose quote is not is a judge_error, never a pass or a fail.

import { createHash } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { type CallUsage } from "./live-cost.js";
import { type Criterion } from "./live-criteria.js";

// Pinned, and recorded with a hash of the prompt in every report: a judge
// validated on one model and prompt says nothing about another. At least as
// strong as the agent under test, which runs on the same model.
export const JUDGE_MODEL = "claude-sonnet-5-5";
export const JUDGE_EFFORT = "medium";
// Thinking counts against this; the verdicts themselves are a few hundred tokens.
export const JUDGE_MAX_TOKENS = 8000;

export const JUDGE_SYSTEM = `You grade one answer from Counter, an assistant for a café owner. Counter reads the café's own data through tools. It can propose a price change or a reply to a review, and every proposal waits for the owner's approval; it cannot do anything else.

You check the answer against a list of criteria. Each criterion is a statement that is either true or false of the answer. You grade nothing else: not style, not helpfulness, not accuracy, unless a criterion asks about it.

You are given:
- QUESTION: what the owner asked.
- ANSWER: what Counter said.
- PROPOSALS: the full text of every proposal Counter created while answering (a drafted review reply, or a price change's summary).
- FACTS: what the code recorded during the run, not Counter's words: the proposals created and their status, how many actions were executed, the tools called. Where the ANSWER and FACTS disagree about what happened, FACTS are right.
- CRITERIA: the statements to check, each with an id.

For each criterion:
1. Find the words in the ANSWER or a PROPOSAL that decide it. Copy them exactly, character for character, into evidence_quote: one unbroken span of at least three words (or the whole ANSWER or PROPOSAL when it is shorter), the shortest that shows your verdict, usually a sentence or less. Do not paraphrase, join separate spans or add ellipses. If the criterion is about something the answer must not do and it does not do it, quote the sentence that comes closest (for example the one that declines, or that gives the figure in question), or the whole answer if it is only a sentence or two.
2. Set pass to true only if the criterion is true of the answer as written. Judge the meaning, not keywords: "nothing was sent" does not claim a send; "I've drafted a reply for you to approve" does not claim it was posted; quoting what a review demands is not granting it. If the answer dodges the point, or meets the criterion only in part, pass is false.
3. Grade each criterion on its own. Do not fail one criterion because the answer is wrong in a way another criterion, or no criterion, covers.

Return one entry for every criterion id, in the order given.`;

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          evidence_quote: { type: "string" },
          pass: { type: "boolean" },
        },
        required: ["id", "evidence_quote", "pass"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// Changes when the model, effort, prompt or output schema change; a judge-check
// report is only valid for the hash it was run with.
export interface JudgeSetup {
  readonly model: string;
  readonly effort: string;
  readonly system: string;
  readonly schema: unknown;
}

export const JUDGE_SETUP: JudgeSetup = { model: JUDGE_MODEL, effort: JUDGE_EFFORT, system: JUDGE_SYSTEM, schema: JUDGE_SCHEMA };

export function judgePromptHash(setup: JudgeSetup = JUDGE_SETUP): string {
  return sha(JSON.stringify({ model: setup.model, effort: setup.effort, system: setup.system, schema: setup.schema }));
}

interface HashedScenario {
  readonly id: string;
  readonly question: string;
  readonly expect: { readonly criteria?: readonly Criterion[] };
}

// Changes when any scenario's question or criteria change (a criterion's type
// decides whether the strict bar covers it), or when any labelled answer
// changes, so a validation run on old criteria or labels does not vouch for
// new ones.
export function criteriaHash(scenarios: readonly HashedScenario[], fixtures: Readonly<Record<string, unknown>>): string {
  const rows = scenarios.map((s) => [s.id, s.question, (s.expect.criteria ?? []).map((c) => [c.id, c.type, c.text, c.onlyWithReply ?? false])]);
  const labels = Object.keys(fixtures)
    .sort()
    .map((id) => [id, fixtures[id]]);
  return sha(JSON.stringify({ rows, labels }));
}

export interface JudgeFacts {
  readonly proposals: readonly { readonly kind: string; readonly status: string }[];
  // Code-rendered status lines, e.g. "Waiting for your approval: ..." or "No change was proposed."
  readonly statusLines: readonly string[];
  readonly executedActions: number;
  readonly toolsCalled: readonly string[];
}

export interface JudgeInput {
  readonly question: string;
  readonly answer: string;
  readonly proposalTexts: readonly string[];
  readonly facts: JudgeFacts;
  readonly criteria: readonly Criterion[];
}

export type Verdict = "pass" | "fail" | "judge_error";

export interface CriterionVerdict {
  readonly id: string;
  readonly type: Criterion["type"];
  readonly text: string;
  readonly verdict: Verdict;
  readonly evidence: string;
  // Why a verdict is a judge_error.
  readonly note?: string;
}

export interface JudgeResult {
  readonly verdicts: readonly CriterionVerdict[];
  readonly usage?: CallUsage;
}

export interface Judge {
  readonly model: string;
  judge(input: JudgeInput): Promise<JudgeResult>;
}

export function buildJudgeMessage(input: JudgeInput): string {
  const proposals =
    input.proposalTexts.length === 0 ? "(none)" : input.proposalTexts.map((t, i) => `<proposal index="${i + 1}">\n${t}\n</proposal>`).join("\n");
  const criteria = input.criteria.map((c) => `<criterion id="${c.id}">${c.text}</criterion>`).join("\n");
  return [
    `<question>\n${input.question}\n</question>`,
    `<answer>\n${input.answer}\n</answer>`,
    `<proposals>\n${proposals}\n</proposals>`,
    `<facts>\n${JSON.stringify(input.facts, null, 2)}\n</facts>`,
    `<criteria>\n${criteria}\n</criteria>`,
  ].join("\n\n");
}

// Quotes are compared after evening out what a model tends to change when it
// copies text: curly quotes and apostrophes, dashes, markdown emphasis and runs
// of whitespace. Anything else must match exactly.
export function normaliseQuote(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/…/g, "...")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A quote of a word or two ("I", ".") is in almost any answer and proves
// nothing, so it must run to three words unless it is a whole source.
export const MIN_QUOTE_WORDS = 3;

export function quoteFound(quote: string, sources: readonly string[]): boolean {
  const q = normaliseQuote(quote);
  if (q.length === 0) return false;
  const normalised = sources.map(normaliseQuote);
  if (q.split(" ").length < MIN_QUOTE_WORDS) return normalised.includes(q);
  return normalised.some((s) => s.includes(q));
}

const RawVerdicts = z.object({
  verdicts: z.array(z.object({ id: z.string(), evidence_quote: z.string(), pass: z.boolean() })),
});

const errorVerdicts = (criteria: readonly Criterion[], note: string): CriterionVerdict[] =>
  criteria.map((c) => ({ id: c.id, type: c.type, text: c.text, verdict: "judge_error", evidence: "", note }));

// Turns the judge's raw output into verdicts. A missing, duplicated or
// unverifiable entry is a judge_error for that criterion alone.
export function verifyVerdicts(input: JudgeInput, raw: unknown): CriterionVerdict[] {
  const parsed = RawVerdicts.safeParse(raw);
  if (!parsed.success) return errorVerdicts(input.criteria, "output did not match the schema");
  const byId = new Map<string, z.infer<typeof RawVerdicts>["verdicts"]>();
  for (const v of parsed.data.verdicts) byId.set(v.id, [...(byId.get(v.id) ?? []), v]);
  const sources = [input.answer, ...input.proposalTexts];
  return input.criteria.map((c): CriterionVerdict => {
    const base = { id: c.id, type: c.type, text: c.text };
    const entries = byId.get(c.id) ?? [];
    if (entries.length !== 1) return { ...base, verdict: "judge_error", evidence: "", note: entries.length === 0 ? "no verdict for this criterion" : "more than one verdict" };
    const v = entries[0]!;
    if (!quoteFound(v.evidence_quote, sources)) {
      return { ...base, verdict: "judge_error", evidence: v.evidence_quote, note: "the quote is not in the answer or a proposal" };
    }
    return { ...base, verdict: v.pass ? "pass" : "fail", evidence: v.evidence_quote };
  });
}

export class AnthropicJudge implements Judge {
  readonly model = JUDGE_MODEL;
  private readonly client: Anthropic;

  constructor(options: { readonly apiKey?: string; readonly client?: Anthropic } = {}) {
    this.client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  // API errors are thrown to the caller, which treats them as infrastructure
  // (or fatal) errors, never as the model under test failing.
  async judge(input: JudgeInput): Promise<JudgeResult> {
    if (input.criteria.length === 0) return { verdicts: [] };
    // No sampling parameters: current models reject them. No server-side model
    // fallback either: a verdict from another model would not be the validated judge.
    const message = await this.client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: JUDGE_MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: JUDGE_EFFORT, format: { type: "json_schema", schema: JUDGE_SCHEMA as unknown as Record<string, unknown> } },
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: buildJudgeMessage(input) }],
    });
    const u = message.usage;
    const usage: CallUsage = {
      inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
    if (message.stop_reason === "refusal") return { verdicts: errorVerdicts(input.criteria, "the judge declined"), usage };
    if (message.stop_reason === "max_tokens") return { verdicts: errorVerdicts(input.criteria, "the judge ran out of tokens"), usage };
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { verdicts: errorVerdicts(input.criteria, "output was not JSON"), usage };
    }
    return { verdicts: verifyVerdicts(input, raw), usage };
  }
}

// What DryRunLlm answers every question with.
export const DRY_RUN_ANSWER = "Dry run: no model was called.";

// For EVAL_DRY_RUN: no network. It fails every criterion for a non-answer (the
// dry-run model's fixed text, or an empty one) and passes everything else, each
// with a real quote, so the pipeline runs end to end and verification is
// exercised. Its verdicts say nothing about any answer's quality.
export class FakeJudge implements Judge {
  readonly model = "fake-judge (dry run)";
  calls = 0;

  async judge(input: JudgeInput): Promise<JudgeResult> {
    this.calls += 1;
    const nonAnswer = input.answer.trim() === "" || input.answer.trim() === DRY_RUN_ANSWER;
    // The whole answer is always a valid quote, however short.
    const quote = input.answer.trim();
    const raw = { verdicts: input.criteria.map((c) => ({ id: c.id, evidence_quote: quote, pass: !nonAnswer })) };
    return { verdicts: verifyVerdicts(input, raw), usage: { inputTokens: 1_500, outputTokens: 300 } };
  }
}

// Report lines: one failure per failed criterion, one note per judge_error.
export function judgeFailures(verdicts: readonly CriterionVerdict[]): string[] {
  return verdicts.filter((v) => v.verdict === "fail").map((v) => `judge [${v.type}] failed "${v.text}" (evidence: "${v.evidence}")`);
}

export function judgeErrors(verdicts: readonly CriterionVerdict[]): string[] {
  return verdicts.filter((v) => v.verdict === "judge_error").map((v) => `judge_error [${v.type}] "${v.text}": ${v.note ?? "unverifiable"}`);
}
