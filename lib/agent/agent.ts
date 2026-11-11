import { type ActionStatus, type ProposedAction, replyTitle } from "../safety/index.js";
import { type AgentContext } from "./context.js";
import { ungroundedFigures } from "./grounding.js";
import { type Turn, historyMessages } from "./history.js";
import { type LlmBlock, type LlmClient, type LlmMessage } from "./llm.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { POLICY_FIGURES, ToolError, type ToolRegistry } from "./tools.js";

export interface Usage {
  readonly modelCalls: number;
  // All input tokens, cached or not; cacheReadTokens is the cached share.
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

// Whether this answer changed anything, rendered by code from what the gate
// and the store hold, never from the model's wording.
export type StatusKind = "waiting" | "approved_by_autopilot" | "sent_by_autopilot" | "rejected" | "not_proposed" | "none";

export interface StatusLine {
  readonly kind: StatusKind;
  readonly text: string;
  readonly proposalId?: string;
}

export interface AgentAnswer {
  // What the owner reads: `body`, then the status lines. They are always
  // there, so whatever the model's wording says about a proposal, the line
  // under it, rendered from the store, says what really happened.
  readonly text: string;
  // The model's answer, with any figure warning, without the status lines.
  readonly body: string;
  // Always at least one line: one per proposal created or refused in this
  // answer, or "No change was proposed."
  readonly status: readonly StatusLine[];
  readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
  readonly proposals: readonly ProposedAction[];
  // Figures still not traceable to a tool result after one correction; the
  // text then carries a visible warning.
  readonly ungroundedFigures: readonly string[];
  // How many times the model had to be asked to fix its answer.
  readonly corrections: number;
  // Set when the model declined the question; the text is then a plain
  // decline, not an empty answer.
  readonly refusal?: { readonly category: string | null };
  readonly usage: Usage;
}

export interface AgentOptions {
  readonly maxTurns?: number;
  readonly systemPrompt?: string;
  // Stops a misled model from flooding the owner's approval queue.
  readonly maxProposals?: number;
  readonly checkFigures?: boolean;
}

// Starts every correction note, so a trace reads as the agent's note at a glance.
const CORRECTION_PREFIX = "Correction: ";

const NONE_PROPOSED: StatusLine = { kind: "none", text: "No change was proposed." };

const STATUS_KIND: Readonly<Record<ActionStatus, StatusKind>> = {
  pending: "waiting",
  approved: "approved_by_autopilot",
  executed: "sent_by_autopilot",
  rejected: "rejected",
};

const STATUS_LEAD: Readonly<Record<StatusKind, string>> = {
  waiting: "Waiting for your approval",
  approved_by_autopilot: "Approved by your autopilot rule, not yet sent",
  sent_by_autopilot: "Sent by your autopilot rule",
  rejected: "Rejected",
  not_proposed: "Not proposed",
  none: "",
};

// A detail that already ends a sentence inside its closing quote ("Thanks so
// much!") takes no extra full stop.
function sentence(lead: string, detail: string): string {
  const trimmed = detail.trim().replace(/[.\s]+$/, "");
  return /[.!?]["”'’]$/.test(trimmed) ? `${lead}: ${trimmed}` : `${lead}: ${trimmed}.`;
}

// What a status line names. A reply autopilot handled is named by its title
// alone ("Reply to Jasmin's review"), since the owner never saw it as a
// proposal; every other line uses the stored summary.
function statusDetail(ctx: AgentContext, kind: StatusKind, proposal: ProposedAction): string {
  const spec = proposal.spec;
  if (spec.kind !== "review_reply" || (kind !== "sent_by_autopilot" && kind !== "approved_by_autopilot")) return proposal.summary;
  return replyTitle(spec.params, ctx.reviews.find((r) => r.id === spec.params.reviewId)?.author);
}

function isToolUse(block: LlmBlock): block is Extract<LlmBlock, { type: "tool_use" }> {
  return block.type === "tool_use";
}

function textOf(blocks: readonly LlmBlock[]): string {
  return blocks
    .filter((b): b is Extract<LlmBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function extractProposalId(output: unknown): string | undefined {
  if (output && typeof output === "object" && "proposalId" in output) {
    const id = (output as { proposalId: unknown }).proposalId;
    if (typeof id === "string") return id;
  }
  return undefined;
}

// An operator note, never shown to the owner. The draft it quotes is taken out
// of the conversation, so the model writes the owner's answer afresh instead
// of replying to the note.
function correctionNote(draft: string, ungrounded: readonly string[]): string {
  return [
    `${CORRECTION_PREFIX}the draft answer below was not sent to the owner. It states ${ungrounded.join(", ")}, which no tool result contains.`,
    "Write the complete answer to the owner's question again, from the start, as if for the first time. " +
      "Use only figures the tools returned: leave out the figures named above or replace them with figures from a tool result, and do not repeat them. " +
      "The owner has not seen the draft or this note, so do not mention, explain or apologise for either.",
    `Draft:\n${draft}`,
  ].join("\n\n");
}

export class Agent {
  constructor(
    private readonly llm: LlmClient,
    private readonly tools: ToolRegistry,
    private readonly options: AgentOptions = {},
  ) {}

  // `history` is the conversation so far, as plain text. It gives a follow-up
  // its context, but figures in this answer must still come from tools run in
  // this turn, and only proposals created in this turn are reported.
  async ask(ctx: AgentContext, question: string, history: readonly Turn[] = []): Promise<AgentAnswer> {
    const maxTurns = this.options.maxTurns ?? 8;
    const maxProposals = this.options.maxProposals ?? 5;
    const checkFigures = this.options.checkFigures ?? true;
    const system = this.options.systemPrompt ?? SYSTEM_PROMPT;
    const llmTools = this.tools.toLlmTools();

    const messages: LlmMessage[] = [...historyMessages(history), { role: "user", blocks: [{ type: "text", text: question }] }];
    const toolCalls: { name: string; input: unknown }[] = [];
    const proposalIds = new Set<string>();
    const proposalErrors: string[] = [];
    const seenToolIds = new Set<string>();
    // Everything a figure in the answer may legitimately come from.
    const results: unknown[] = [];
    // What the model wrote into its tool calls, which no result can vouch for.
    const modelWritten: string[] = [];
    const check = (text: string): readonly string[] =>
      checkFigures
        ? ungroundedFigures(text, { question, currency: ctx.currency, results: [POLICY_FIGURES, ...results], modelWritten })
        : [];
    let corrections = 0;
    let usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    let refusal: AgentAnswer["refusal"];
    const finish = (text: string, ungrounded: readonly string[] = []): AgentAnswer => {
      const views = [...proposalIds].map((id) => ctx.store.get(id)).filter((v) => v !== undefined);
      const proposals = views.map((v) => v.proposal);
      const status: StatusLine[] = [
        ...views.map((v) => {
          const kind = STATUS_KIND[v.status];
          return { kind, text: sentence(STATUS_LEAD[kind], statusDetail(ctx, kind, v.proposal)), proposalId: v.proposal.id };
        }),
        ...proposalErrors.map((reason) => ({ kind: "not_proposed" as const, text: sentence(STATUS_LEAD.not_proposed, reason) })),
      ];
      if (status.length === 0) status.push(NONE_PROPOSED);
      const warning =
        ungrounded.length > 0 ? [`(I couldn't match these figures to your data, so treat them with care: ${ungrounded.join(", ")}.)`] : [];
      const body = [text || "I don't have an answer for that.", ...warning].join("\n\n");
      return {
        text: [body, status.map((l) => l.text).join("\n")].join("\n\n"),
        body,
        status,
        toolCalls,
        proposals,
        ungroundedFigures: ungrounded,
        corrections,
        ...(refusal ? { refusal } : {}),
        usage,
      };
    };

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await this.llm.respond({ system, messages, tools: llmTools });
      usage = {
        modelCalls: usage.modelCalls + 1,
        inputTokens: usage.inputTokens + (response.usage?.inputTokens ?? 0),
        outputTokens: usage.outputTokens + (response.usage?.outputTokens ?? 0),
        cacheReadTokens: usage.cacheReadTokens + (response.usage?.cacheReadTokens ?? 0),
      };
      messages.push({ role: "assistant", blocks: response.blocks });

      // A decline is final: there is nothing to correct and no tool to run.
      if (response.refusal) {
        refusal = response.refusal;
        return finish(textOf(response.blocks));
      }

      const toolUses = response.blocks.filter(isToolUse);
      if (response.stop === "end" || toolUses.length === 0) {
        // A rewrite is shown as written and checked in full: the note told the
        // model the owner never saw the draft.
        const raw = textOf(response.blocks);
        const found = check(raw);
        if (found.length === 0) return finish(raw);
        // One chance to fix it; a second miss is surfaced, not hidden. A turn
        // that still carries tool calls can't take a plain-text follow-up.
        if (corrections > 0 || toolUses.length > 0 || turn + 1 >= maxTurns) return finish(raw, found);
        corrections += 1;
        // The draft leaves the conversation, so the note follows the last user
        // message (the question or the tool results), as a system note must.
        // Only the newest turn is removed, so earlier thinking stays valid.
        messages.pop();
        messages.push({ role: "system", blocks: [{ type: "text", text: correctionNote(raw, found) }] });
        continue;
      }

      // Every tool_use must get exactly one result, or the next request is
      // malformed. A missing or repeated id can't be answered, so end the turn.
      const ids = toolUses.map((c) => c.id);
      if (ids.some((id) => !id || seenToolIds.has(id)) || new Set(ids).size !== ids.length) {
        const text = textOf(response.blocks);
        return finish(text, check(text));
      }
      ids.forEach((id) => seenToolIds.add(id));

      const resultBlocks: LlmBlock[] = [];
      for (const call of toolUses) {
        toolCalls.push({ name: call.name, input: call.input });
        if (call.input && typeof call.input === "object") {
          for (const v of Object.values(call.input)) if (typeof v === "string") modelWritten.push(v);
        }
        const isProposal = call.name.startsWith("propose_");
        if (isProposal && proposalIds.size >= maxProposals) {
          const reason = `proposal limit of ${maxProposals} per question reached`;
          proposalErrors.push(reason);
          resultBlocks.push({ type: "tool_result", toolUseId: call.id, content: `Error: ${reason}`, isError: true });
          continue;
        }
        try {
          const output = this.tools.run(call.name, call.input, ctx);
          const proposalId = extractProposalId(output);
          if (proposalId) proposalIds.add(proposalId);
          results.push(output);
          resultBlocks.push({ type: "tool_result", toolUseId: call.id, content: JSON.stringify(output) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // The message is text and never a source; a refusal's typed figures are.
          if (error instanceof ToolError) results.push(error.figures);
          // A gate refusal is written for the owner; a malformed call is not.
          if (isProposal) proposalErrors.push(error instanceof ToolError ? message : "the request could not be read");
          resultBlocks.push({ type: "tool_result", toolUseId: call.id, content: `Error: ${message}`, isError: true });
        }
      }
      messages.push({ role: "user", blocks: resultBlocks });
    }

    return finish("I ran out of steps before answering.");
  }
}
