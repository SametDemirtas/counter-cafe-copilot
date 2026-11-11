import { afterEach, describe, expect, it, vi } from "vitest";

// The SDK is replaced with a recorder, so respond() is exercised end to end
// without a key or the network.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { AnthropicLlmClient, REFUSAL_TEXT, TRUNCATION_NOTICE } = await import("../../lib/agent/anthropic.js");
const { Agent, createDemoGate, defaultToolRegistry, loadDemoContext } = await import("../../lib/agent/index.js");

function demoAgent() {
  const bundle = createDemoGate();
  return { agent: new Agent(new AnthropicLlmClient({ model: "test-model" }), defaultToolRegistry()), ctx: loadDemoContext(bundle.gate, bundle.store) };
}

type SentMessage = { role: string; content: unknown[] };
const sentMessages = (call: number): SentMessage[] => (create.mock.calls[call]![0] as { messages: SentMessage[] }).messages;

afterEach(() => {
  create.mockReset();
  vi.unstubAllEnvs();
});

describe("AnthropicLlmClient.respond (SDK mocked)", () => {
  it("sends the model, system, tools and messages in the SDK's shape", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
    });
    const client = new AnthropicLlmClient({ model: "test-model", maxTokens: 99 });
    const response = await client.respond({
      system: "sys",
      tools: [
        { name: "a", description: "d", inputSchema: { type: "object", properties: {} } },
        { name: "b", description: "d", inputSchema: { type: "object", properties: {} } },
      ],
      messages: [{ role: "user", blocks: [{ type: "text", text: "q" }] }],
    });
    // Cached input tokens still count toward the total spent, and are reported apart.
    expect(response).toEqual({
      blocks: [{ type: "text", text: "hi" }],
      stop: "end",
      usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 },
    });
    expect(create).toHaveBeenCalledWith({
      model: "test-model",
      max_tokens: 99,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      // Breakpoints: one after the stable tools+system prefix, one on the newest block.
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      tools: [
        { name: "a", description: "d", input_schema: { type: "object", properties: {} } },
        { name: "b", description: "d", input_schema: { type: "object", properties: {} } },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }],
    });
  });

  it("reads ANTHROPIC_MODEL at construction and exposes the model it will use", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "from-env");
    expect(new AnthropicLlmClient().modelId).toBe("from-env");
    expect(new AnthropicLlmClient({ model: "explicit" }).modelId).toBe("explicit");
  });

  it("falls back to the default model when neither the option nor the env is set", () => {
    vi.stubEnv("ANTHROPIC_MODEL", undefined);
    expect(new AnthropicLlmClient().modelId).toBe("claude-sonnet-5-5");
  });

  it("asks for 16000 tokens, adaptive thinking and medium effort by default", async () => {
    vi.stubEnv("ANTHROPIC_EFFORT", undefined);
    create.mockResolvedValue({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    await new AnthropicLlmClient().respond({ system: "", tools: [], messages: [] });
    expect(create.mock.calls[0]![0]).toMatchObject({
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
  });

  it("takes the effort from ANTHROPIC_EFFORT and refuses an unknown level", () => {
    vi.stubEnv("ANTHROPIC_EFFORT", "high");
    expect(new AnthropicLlmClient().effortLevel).toBe("high");
    expect(new AnthropicLlmClient({ effort: "low" }).effortLevel).toBe("low");
    vi.stubEnv("ANTHROPIC_EFFORT", "extreme");
    expect(() => new AnthropicLlmClient()).toThrow(/ANTHROPIC_EFFORT/);
  });

  it("sends every thinking block back verbatim and in order through the tool loop", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
    const redacted = { type: "redacted_thinking", data: "enc-xyz" };
    const call = { type: "tool_use", id: "toolu_1", name: "list_reviews", input: {} };
    const firstTurn = [thinking, { type: "text", text: "Let me look." }, redacted, call];
    create
      .mockResolvedValueOnce({ content: firstTurn, stop_reason: "tool_use" })
      .mockResolvedValueOnce({ content: [{ type: "thinking", thinking: "", signature: "sig-2" }, { type: "text", text: "You have reviews." }], stop_reason: "end_turn" });
    const { agent, ctx } = demoAgent();

    const answer = await agent.ask(ctx, "Any new reviews?");

    expect(answer.body).toBe("You have reviews.");
    const second = sentMessages(1);
    expect(second[1]).toEqual({ role: "assistant", content: firstTurn });
    expect(second[1]!.content[0]).toBe(thinking);
    expect(second[1]!.content[2]).toBe(redacted);
    // The second request repeats the first byte for byte and only appends.
    expect(JSON.stringify(second.slice(0, 1))).toBe(JSON.stringify(sentMessages(0)).replace(',"cache_control":{"type":"ephemeral"}', ""));
  });

  it("sends earlier questions as plain text turns with no thinking blocks", async () => {
    create.mockResolvedValue({ content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Hello." }], stop_reason: "end_turn" });
    const { agent, ctx } = demoAgent();
    await agent.ask(ctx, "and today?", [{ question: "hi", answer: "Hi there." }]);
    expect(sentMessages(0).slice(0, 2)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there." }] },
    ]);
  });

  it("ends the question with a plain decline on a refusal, never an empty answer", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "Sure, first" }],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
    });
    const { agent, ctx } = demoAgent();
    const answer = await agent.ask(ctx, "How did Saturday go?");
    expect(answer.body).toBe(REFUSAL_TEXT);
    expect(answer.refusal).toEqual({ category: "cyber" });
    expect(answer.corrections).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("turns a max_tokens response into a visible truncation notice", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" });
    const response = await new AnthropicLlmClient().respond({ system: "", tools: [], messages: [] });
    expect(response.blocks.at(-1)).toEqual({ type: "text", text: TRUNCATION_NOTICE });
  });
});
