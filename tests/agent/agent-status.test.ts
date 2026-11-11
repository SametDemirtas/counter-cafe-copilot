import { describe, expect, it } from "vitest";

import {
  Agent,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  createDemoGate,
  defaultToolRegistry,
  loadDemoContext,
} from "../../lib/agent/index.js";
import { ScriptedLlm } from "../../lib/agent/testing.js";

class RecordingLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly script: readonly LlmResponse[]) {}
  async respond(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.script[this.i++];
    if (!next) throw new Error("script exhausted");
    return next;
  }
}

const say = (text: string): LlmResponse => ({ stop: "end", blocks: [{ type: "text", text }] });
const proposeAt = (pence: number, id = "p1"): LlmResponse => ({
  stop: "tool_use",
  blocks: [{ type: "tool_use", id, name: "propose_price_change", input: { sku: "avocado_toast", proposedPriceMinor: pence } }],
});

function context() {
  const bundle = createDemoGate();
  return { bundle, ctx: loadDemoContext(bundle.gate, bundle.store) };
}

describe("Agent: what the answer says against what the gate did", () => {
  it("never rewrites an answer for its wording: the status line under it says what happened", async () => {
    const llm = new RecordingLlm([proposeAt(100), say("Done, I've created the proposal.")]);
    const { ctx } = context();
    const answer = await new Agent(llm, defaultToolRegistry()).ask(ctx, "Set avocado toast to £1");
    expect(llm.requests).toHaveLength(2);
    expect(answer.corrections).toBe(0);
    expect(answer.proposals).toHaveLength(0);
    expect(answer.body).toBe("Done, I've created the proposal.");
    expect(answer.status).toEqual([{ kind: "not_proposed", text: expect.stringMatching(/^Not proposed: .*food cost.*\.$/) }]);
    expect(answer.text).toBe(`${answer.body}\n\n${answer.status[0]!.text}`);
  });

  it("says no change was proposed under a claim made with no proposal tool call", async () => {
    const llm = new ScriptedLlm([say("I've raised the price of the toastie to £7.15.")]);
    const { ctx } = context();
    const answer = await new Agent(llm, defaultToolRegistry(), { checkFigures: false }).ask(ctx, "Raise the toastie to £7.15");
    expect(answer.status).toEqual([{ kind: "none", text: "No change was proposed." }]);
    expect(answer.text).toBe("I've raised the price of the toastie to £7.15.\n\nNo change was proposed.");
  });

  it("puts the status line under every answer, a real proposal and an honest refusal alike", async () => {
    const { ctx } = context();
    const honest = await new Agent(new ScriptedLlm([proposeAt(100), say("I couldn't create the proposal because it is below food cost.")]), defaultToolRegistry()).ask(ctx, "q");
    expect(honest.text).toMatch(/^I couldn't create the proposal because it is below food cost\.\n\nNot proposed: .*food cost/);
    const real = await new Agent(new ScriptedLlm([proposeAt(850), say("It is waiting for your approval.")]), defaultToolRegistry()).ask(ctx, "q");
    expect(real.proposals).toHaveLength(1);
    expect(real.text).toBe("It is waiting for your approval.\n\nWaiting for your approval: Change Avocado Toast price from £7.80 to £8.50.");
  });

  it("counts a proposal over the per-question limit as not created", async () => {
    const { ctx } = context();
    const answer = await new Agent(new ScriptedLlm([proposeAt(850), say("One proposal was created.")]), defaultToolRegistry(), { maxProposals: 0 }).ask(ctx, "q");
    expect(answer.proposals).toHaveLength(0);
    expect(answer.status).toEqual([{ kind: "not_proposed", text: "Not proposed: proposal limit of 0 per question reached." }]);
  });

  it("lets the model repeat the food cost from a refusal, but not the price it asked for", async () => {
    const { ctx } = context();
    const ok = await new Agent(new ScriptedLlm([proposeAt(100), say("Below the £3.40 food cost, so not proposed.")]), defaultToolRegistry()).ask(ctx, "q");
    expect(ok.ungroundedFigures).toEqual([]);
    const own = await new Agent(new ScriptedLlm([proposeAt(100), say("£1.00 is too low."), say("£1.00 is too low.")]), defaultToolRegistry()).ask(ctx, "q");
    expect(own.ungroundedFigures).toEqual(["£1.00"]);
  });
});

describe("Agent: a refused review reply", () => {
  const replyTo = (reviewId: string, id: string): LlmResponse => ({
    stop: "tool_use",
    blocks: [{ type: "tool_use", id, name: "propose_review_reply", input: { reviewId, replyText: "Thanks so much!" } }],
  });

  it("shows the gate's reason for a duplicate reply and for an unknown review", async () => {
    const { ctx } = context();
    const llm = new ScriptedLlm([replyTo("rev-2", "a"), replyTo("rev-2", "b"), replyTo("rev-999", "c"), say("Done.")]);
    const answer = await new Agent(llm, defaultToolRegistry()).ask(ctx, "Thank Jasmin");
    expect(answer.status.map((l) => l.text)).toEqual([
      // A summary that ends inside its quote takes no second full stop.
      'Waiting for your approval: Reply to Jasmin\'s review: "Thanks so much!"',
      expect.stringMatching(/^Not proposed: A proposal for this is already waiting for approval: Reply to Jasmin's review/),
      'Not proposed: No review with id "rev-999".',
    ]);
  });
});

describe("Agent: a proposal call the tool could not read", () => {
  it("tells the owner the request could not be read, not the parser's error", async () => {
    const { ctx } = context();
    const bad: LlmResponse = { stop: "tool_use", blocks: [{ type: "tool_use", id: "x", name: "propose_review_reply", input: {} }] };
    const llm = new RecordingLlm([bad, say("I could not send that.")]);
    const answer = await new Agent(llm, defaultToolRegistry()).ask(ctx, "Thank Jasmin");
    expect(answer.status).toEqual([{ kind: "not_proposed", text: "Not proposed: the request could not be read." }]);
    // The model still gets the full error, so it can fix the call.
    expect(llm.requests[1]!.messages.at(-1)!.blocks).toEqual([
      { type: "tool_result", toolUseId: "x", content: expect.stringMatching(/^Error: .*reviewId/s), isError: true },
    ]);
  });
});

describe("Agent: conversation history", () => {
  it("sends earlier turns as plain text before the new question", async () => {
    const llm = new RecordingLlm([say("The second is Sunday's staff cost.")]);
    const { ctx } = context();
    const history = [{ question: "Two biggest problems?", answer: "First the tomatoes, then Sunday." }];
    await new Agent(llm, defaultToolRegistry()).ask(ctx, "And the second one?", history);
    expect(llm.requests[0]!.messages).toEqual([
      { role: "user", blocks: [{ type: "text", text: "Two biggest problems?" }] },
      { role: "assistant", blocks: [{ type: "text", text: "First the tomatoes, then Sunday." }] },
      { role: "user", blocks: [{ type: "text", text: "And the second one?" }] },
    ]);
  });

  it("does not let a figure from an earlier answer vouch for this one", async () => {
    const { ctx } = context();
    const history = [{ question: "Overcharged?", answer: "You overpaid £12.00." }];
    const answer = await new Agent(new ScriptedLlm([say("Still £12.00."), say("Still £12.00.")]), defaultToolRegistry()).ask(ctx, "Again?", history);
    expect(answer.ungroundedFigures).toEqual(["£12.00"]);
  });
});

describe("Agent: the status line", () => {
  it("names each proposal created in this answer from its stored summary", async () => {
    const { ctx } = context();
    const answer = await new Agent(new ScriptedLlm([proposeAt(850), say("Done.")]), defaultToolRegistry()).ask(ctx, "Avocado toast to £8.50");
    expect(answer.status).toEqual([
      { kind: "waiting", text: "Waiting for your approval: Change Avocado Toast price from £7.80 to £8.50.", proposalId: answer.proposals[0]!.id },
    ]);
    expect(answer.text).toBe("Done.\n\nWaiting for your approval: Change Avocado Toast price from £7.80 to £8.50.");
  });

  it("lists a refused call and a created proposal from the same answer", async () => {
    const { ctx } = context();
    const llm = new ScriptedLlm([proposeAt(100, "a"), proposeAt(850, "b"), say("Proposed £8.50 instead.")]);
    const answer = await new Agent(llm, defaultToolRegistry()).ask(ctx, "Avocado toast to £1, or £8.50 if not");
    expect(answer.status.map((l) => l.kind)).toEqual(["waiting", "not_proposed"]);
  });

  it("calls a draft to a rating autopilot covers waiting: autopilot never posts the agent's drafts", async () => {
    const bundle = createDemoGate();
    const ctx = loadDemoContext(bundle.gate, bundle.store);
    const tools = defaultToolRegistry();
    for (const reviewId of ["rev-1", "rev-4", "rev-5", "rev-6", "rev-7"]) {
      const out = tools.run("propose_review_reply", { reviewId, replyText: "Thank you." }, ctx) as { proposalId: string };
      bundle.gate.execute(bundle.gate.approve(out.proposalId, "owner"));
    }
    bundle.gate.setReplyTemplate(5, "Thank you so much, {name}!", "owner");
    bundle.gate.setAutopilot({ enabled: true, ratings: [5] }, "owner");
    const reply: LlmResponse = {
      stop: "tool_use",
      blocks: [{ type: "tool_use", id: "r", name: "propose_review_reply", input: { reviewId: "rev-2", replyText: "Thank you!" } }],
    };
    const answer = await new Agent(new ScriptedLlm([reply, say("Drafted.")]), tools).ask(ctx, "Thank rev-2");
    expect(answer.status).toEqual([expect.objectContaining({ kind: "waiting", text: 'Waiting for your approval: Reply to Jasmin\'s review: "Thank you!"' })]);
  });

  it("is carried on every answer and always shown under it, even when nothing was proposed", async () => {
    const { ctx } = context();
    const answer = await new Agent(new ScriptedLlm([say("Hello!")]), defaultToolRegistry()).ask(ctx, "hi");
    expect(answer.status).toEqual([{ kind: "none", text: "No change was proposed." }]);
    expect(answer.text).toBe("Hello!\n\nNo change was proposed.");
    expect(answer.body).toBe("Hello!");
  });
});
