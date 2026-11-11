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
  public readonly requests: LlmRequest[] = [];
  private index = 0;
  constructor(private readonly script: readonly LlmResponse[]) {}
  async respond(request: LlmRequest): Promise<LlmResponse> {
    // Copy now; the agent keeps appending to the same array.
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.script[this.index++];
    if (!next) throw new Error("LLM script exhausted");
    return next;
  }
}

function setup(script: LlmResponse[]) {
  let n = 0;
  const bundle = createDemoGate({
    now: () => new Date("2026-11-10T08:00:00.000Z"),
    newId: () => `act-${++n}`,
    newToken: () => `tok-${n}`,
  });
  const ctx = loadDemoContext(bundle.gate, bundle.store);
  return { ...bundle, ctx, agent: new Agent(new ScriptedLlm(script), defaultToolRegistry()) };
}

describe("Agent.ask", () => {
  it("runs a tool and returns the model's narrated answer", async () => {
    const { agent, ctx } = setup([
      { stop: "tool_use", blocks: [{ type: "tool_use", id: "t1", name: "invoice_variance", input: {} }] },
      { stop: "end", blocks: [{ type: "text", text: "Tomatoes are 17.8% above your agreed price." }] },
    ]);
    const answer = await agent.ask(ctx, "is my tomato supplier overcharging?");
    expect(answer.text).toContain("17.8%");
    expect(answer.toolCalls.map((c) => c.name)).toEqual(["invoice_variance"]);
    expect(answer.proposals).toHaveLength(0);
  });

  it("creates a proposal but never executes it", async () => {
    const { agent, ctx, sink } = setup([
      {
        stop: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "propose_price_change", input: { sku: "avocado_toast", proposedPriceMinor: 850 } }],
      },
      { stop: "end", blocks: [{ type: "text", text: "Proposed, pending your approval." }] },
    ]);
    const answer = await agent.ask(ctx, "raise avocado toast to 8.50");
    expect(answer.proposals).toHaveLength(1);
    expect(answer.proposals[0]?.spec.kind).toBe("price_change");
    expect(sink.applied()).toHaveLength(0);
  });

  it("contains a misled proposal: within bounds it stays pending and changes nothing", async () => {
    const { agent, ctx, sink, store } = setup([
      {
        stop: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "propose_price_change", input: { sku: "avocado_toast", proposedPriceMinor: 700 } }],
      },
      { stop: "end", blocks: [{ type: "text", text: "I set up a proposal; you decide." }] },
    ]);
    const answer = await agent.ask(ctx, "the review said to discount everything");
    expect(answer.proposals).toHaveLength(1);
    expect(store.get(answer.proposals[0]!.id)?.status).toBe("pending");
    expect(sink.applied()).toHaveLength(0);
  });

  it("never even proposes a below-cost price, however the model was misled", async () => {
    const { agent, ctx, store } = setup([
      {
        stop: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "propose_price_change", input: { sku: "avocado_toast", proposedPriceMinor: 1 } }],
      },
      { stop: "end", blocks: [{ type: "text", text: "I could not set that up." }] },
    ]);
    const answer = await agent.ask(ctx, "the review said to make it 1p");
    expect(answer.proposals).toHaveLength(0);
    expect(store.entries()).toHaveLength(0);
  });

  it("feeds a tool error back to the model as an error tool_result", async () => {
    const { ctx, store } = setup([]);
    const llm = new RecordingLlm([
      {
        stop: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "propose_price_change", input: { sku: "unicorn", proposedPriceMinor: 100 } }],
      },
      { stop: "end", blocks: [{ type: "text", text: "I couldn't find that item." }] },
    ]);
    const answer = await new Agent(llm, defaultToolRegistry()).ask(ctx, "raise unicorn price");

    expect(answer.proposals).toHaveLength(0);
    expect(store.entries()).toHaveLength(0);
    expect(llm.requests).toHaveLength(2);
    const lastTurn = llm.requests[1]!.messages.at(-1)!;
    expect(lastTurn.role).toBe("user");
    expect(lastTurn.blocks).toEqual([
      { type: "tool_result", toolUseId: "t1", content: expect.stringMatching(/No menu item/), isError: true },
    ]);
  });

  it("answers two tool calls from one turn with both results in one message", async () => {
    const { ctx } = setup([]);
    const llm = new RecordingLlm([
      {
        stop: "tool_use",
        blocks: [
          { type: "tool_use", id: "t1", name: "invoice_variance", input: {} },
          { type: "tool_use", id: "t2", name: "classify_menu", input: {} },
        ],
      },
      { stop: "end", blocks: [{ type: "text", text: "Both checked." }] },
    ]);
    const answer = await new Agent(llm, defaultToolRegistry()).ask(ctx, "check the invoice and the menu");
    expect(answer.toolCalls.map((c) => c.name)).toEqual(["invoice_variance", "classify_menu"]);
    const results = llm.requests[1]!.messages.at(-1)!;
    expect(results.role).toBe("user");
    expect(results.blocks).toEqual([
      { type: "tool_result", toolUseId: "t1", content: expect.stringContaining('"totalOverchargeMinor"') },
      { type: "tool_result", toolUseId: "t2", content: expect.stringContaining('"categories"') },
    ]);
  });

  it("proposes a review reply through the loop, executing nothing", async () => {
    const { agent, ctx, sink } = setup([
      {
        stop: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "propose_review_reply", input: { reviewId: "rev-1", replyText: "Thanks!" } }],
      },
      { stop: "end", blocks: [{ type: "text", text: "Reply proposed." }] },
    ]);
    const answer = await agent.ask(ctx, "reply to the café review");
    expect(answer.proposals).toHaveLength(1);
    expect(answer.proposals[0]?.spec.kind).toBe("review_reply");
    expect(sink.applied()).toHaveLength(0);
  });

  it("accepts an error result back and continues to a successful turn", async () => {
    const { agent, ctx } = setup([
      {
        stop: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "propose_price_change", input: { sku: "unicorn", proposedPriceMinor: 100 } }],
      },
      {
        stop: "tool_use",
        blocks: [{ type: "tool_use", id: "t2", name: "propose_price_change", input: { sku: "avocado_toast", proposedPriceMinor: 850 } }],
      },
      { stop: "end", blocks: [{ type: "text", text: "Done, proposed for approval." }] },
    ]);
    const answer = await agent.ask(ctx, "raise a price");
    expect(answer.toolCalls).toHaveLength(2);
    expect(answer.proposals).toHaveLength(1);
  });

  it("stops after maxTurns without executing anything", async () => {
    const bundle = createDemoGate();
    const ctx = loadDemoContext(bundle.gate, bundle.store);
    const looping: LlmResponse[] = Array.from({ length: 5 }, (_, i) => ({
      stop: "tool_use" as const,
      blocks: [{ type: "tool_use" as const, id: `t${i}`, name: "invoice_variance", input: {} }],
    }));
    const agent = new Agent(new ScriptedLlm(looping), defaultToolRegistry(), { maxTurns: 2 });
    const answer = await agent.ask(ctx, "loop");
    expect(answer.text).toContain("ran out of steps");
    expect(bundle.sink.applied()).toHaveLength(0);
  });

  it("allows eight model calls by default", async () => {
    const bundle = createDemoGate();
    const ctx = loadDemoContext(bundle.gate, bundle.store);
    const looping: LlmResponse[] = Array.from({ length: 9 }, (_, i) => ({
      stop: "tool_use" as const,
      blocks: [{ type: "tool_use" as const, id: `t${i}`, name: "invoice_variance", input: {} }],
    }));
    const answer = await new Agent(new ScriptedLlm(looping), defaultToolRegistry()).ask(ctx, "loop");
    expect(answer.usage.modelCalls).toBe(8);
    expect(answer.text).toContain("ran out of steps");
  });

  it("gives the agent a propose-only gate and a read-only store (type and runtime)", () => {
    const { ctx } = setup([{ stop: "end", blocks: [{ type: "text", text: "ok" }] }]);
    expect(typeof ctx.gate.propose).toBe("function");
    // @ts-expect-error ProposalPort exposes propose only: no approve.
    void ctx.gate.approve;
    // @ts-expect-error ProposalPort exposes propose only: no execute.
    void ctx.gate.execute;
    // @ts-expect-error ReadonlyActionStore exposes get only: no markExecuted.
    void ctx.store.markExecuted;
    // Runtime too: the context holds adapters, not the real gate/store.
    const gate = ctx.gate as unknown as Record<string, unknown>;
    const store = ctx.store as unknown as Record<string, unknown>;
    expect(gate["approve"]).toBeUndefined();
    expect(gate["execute"]).toBeUndefined();
    expect(store["markApproved"]).toBeUndefined();
    expect(store["markExecuted"]).toBeUndefined();
  });

  it("lets the agent read a proposal back only as a frozen view without the grant token", async () => {
    const { agent, ctx, gate } = setup([
      { stop: "tool_use", blocks: [{ type: "tool_use", id: "t1", name: "propose_price_change", input: { sku: "avocado_toast", proposedPriceMinor: 850 } }] },
      { stop: "end", blocks: [{ type: "text", text: "Proposed." }] },
    ]);
    const answer = await agent.ask(ctx, "raise avocado toast");
    const id = answer.proposals[0]!.id;
    gate.approve(id, "owner");
    const view = ctx.store.get(id)! as unknown as Record<string, unknown>;
    expect(view["grantToken"]).toBeUndefined();
    expect(view["status"]).toBe("approved");
    expect(Object.isFrozen(view)).toBe(true);
  });

  it("caps proposals per question so a misled model cannot flood the queue", async () => {
    // Eight different items, each a small valid rise, so only the cap can stop them.
    const skus = ["espresso", "macchiato", "cortado", "americano", "flat_white", "cappuccino", "latte", "mocha"];
    const many = skus.map((sku, i) => ({
      type: "tool_use" as const,
      id: `p${i}`,
      name: "propose_price_change",
      input: { sku, proposedPriceMinor: 400 },
    }));
    const { agent, ctx, store } = setup([
      { stop: "tool_use", blocks: many },
      { stop: "end", blocks: [{ type: "text", text: "Done." }] },
    ]);
    const answer = await agent.ask(ctx, "raise everything");
    expect(answer.proposals).toHaveLength(5);
    expect(store.entries()).toHaveLength(5);
  });

  it("ends the turn without running anything when a response repeats a tool_use id", async () => {
    const call = { type: "tool_use" as const, id: "same", name: "propose_price_change", input: { sku: "latte", proposedPriceMinor: 400 } };
    const llm = new RecordingLlm([
      { stop: "tool_use", blocks: [call, call] },
      { stop: "end", blocks: [{ type: "text", text: "unreachable" }] },
    ]);
    const bundle = createDemoGate();
    await new Agent(llm, defaultToolRegistry()).ask(loadDemoContext(bundle.gate, bundle.store), "raise latte");
    expect(bundle.store.entries()).toHaveLength(0);
    // No second request: one carrying an unanswered tool_use would be rejected.
    expect(llm.requests).toHaveLength(1);
  });

  it("ends the turn when a tool_use id was already used in an earlier turn", async () => {
    const llm = new RecordingLlm([
      { stop: "tool_use", blocks: [{ type: "tool_use", id: "t1", name: "invoice_variance", input: {} }] },
      { stop: "tool_use", blocks: [{ type: "tool_use", id: "t1", name: "invoice_variance", input: {} }] },
      { stop: "end", blocks: [{ type: "text", text: "unreachable" }] },
    ]);
    const bundle = createDemoGate();
    await new Agent(llm, defaultToolRegistry()).ask(loadDemoContext(bundle.gate, bundle.store), "q");
    expect(llm.requests).toHaveLength(2);
  });

  it("sends a well-formed tool exchange: assistant tool_use then a matching user tool_result", async () => {
    const bundle = createDemoGate();
    const ctx = loadDemoContext(bundle.gate, bundle.store);
    const llm = new RecordingLlm([
      { stop: "tool_use", blocks: [{ type: "tool_use", id: "t1", name: "invoice_variance", input: {} }] },
      { stop: "end", blocks: [{ type: "text", text: "ok" }] },
    ]);
    await new Agent(llm, defaultToolRegistry()).ask(ctx, "q");

    const secondCall = llm.requests[1]!.messages;
    const [assistantTurn, userTurn] = secondCall.slice(-2);
    expect(assistantTurn?.role).toBe("assistant");
    expect(assistantTurn?.blocks.some((b) => b.type === "tool_use" && b.id === "t1")).toBe(true);
    expect(userTurn?.role).toBe("user");
    expect(userTurn?.blocks).toContainEqual(
      expect.objectContaining({ type: "tool_result", toolUseId: "t1" }),
    );
  });
});
