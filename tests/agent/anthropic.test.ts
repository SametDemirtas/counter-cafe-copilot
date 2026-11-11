import { describe, expect, it } from "vitest";

import { type LlmMessage } from "../../lib/agent/llm.js";
import {
  REFUSAL_TEXT,
  TRUNCATION_NOTICE,
  fromContentBlock,
  toContentBlockParam,
  toLlmResponse,
  toMessageParam,
  withTrailingCacheBreakpoint,
} from "../../lib/agent/anthropic.js";

describe("Anthropic mappers (pure, no network)", () => {
  it("maps an assistant tool_use message to the Anthropic shape", () => {
    const message: LlmMessage = {
      role: "assistant",
      blocks: [{ type: "tool_use", id: "t1", name: "invoice_variance", input: {} }],
    };
    expect(toMessageParam(message)).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "invoice_variance", input: {} }],
    });
  });

  it("maps a tool_result to tool_use_id and is_error", () => {
    expect(toContentBlockParam({ type: "tool_result", toolUseId: "t1", content: "{}", isError: true })).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: "{}",
      is_error: true,
    });
    expect(toContentBlockParam({ type: "tool_result", toolUseId: "t2", content: "x" })).toEqual({
      type: "tool_result",
      tool_use_id: "t2",
      content: "x",
      is_error: false,
    });
  });

  it("reads text and tool_use blocks back from the API", () => {
    expect(fromContentBlock({ type: "text", text: "hi" } as never)).toEqual({ type: "text", text: "hi" });
    expect(fromContentBlock({ type: "tool_use", id: "t1", name: "n", input: { a: 1 } } as never)).toEqual({
      type: "tool_use",
      id: "t1",
      name: "n",
      input: { a: 1 },
    });
  });

  it("carries a thinking block as an opaque block and sends the same object back", () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
    const mapped = fromContentBlock(thinking as never);
    expect(mapped).toEqual({ type: "opaque", provider: "anthropic", raw: thinking });
    expect(toContentBlockParam(mapped)).toBe(thinking);
    const redacted = { type: "redacted_thinking", data: "enc" };
    expect(toContentBlockParam(fromContentBlock(redacted as never))).toBe(redacted);
  });

  it("never sends another provider's opaque block", () => {
    expect(toContentBlockParam({ type: "opaque", provider: "other", raw: { type: "x" } })).toBeNull();
    expect(toMessageParam({ role: "assistant", blocks: [{ type: "opaque", provider: "other", raw: {} }, { type: "text", text: "a" }] })).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "a" }],
    });
  });

  it("keeps thinking, text and tool_use in their original order", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s1" },
      { type: "text", text: "Checking." },
      { type: "redacted_thinking", data: "enc" },
      { type: "tool_use", id: "t1", name: "n", input: {} },
    ];
    const response = toLlmResponse(content as never, "tool_use");
    expect(toMessageParam({ role: "assistant", blocks: response.blocks }).content).toEqual(content);
  });

  it("sends a system note as a system message and keeps the cache breakpoint before it", () => {
    expect(toMessageParam({ role: "system", blocks: [{ type: "text", text: "note" }] })).toEqual({ role: "system", content: "note" });
    const messages = withTrailingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "system", content: "note" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "note" },
    ]);
  });

  it("turns a refusal into a plain decline, drops partial output and keeps the category", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s1" },
      { type: "text", text: "Here is how to" },
    ];
    const response = toLlmResponse(content as never, "refusal", undefined, { category: "cyber" });
    expect(response).toEqual({ blocks: [{ type: "text", text: REFUSAL_TEXT }], stop: "end", refusal: { category: "cyber" } });
    expect(toLlmResponse([] as never, "refusal", undefined, null).refusal).toEqual({ category: null });
  });

  it("maps stop reasons: tool_use continues, end_turn ends", () => {
    const tool = [{ type: "tool_use", id: "t1", name: "n", input: {} }] as never;
    expect(toLlmResponse(tool, "tool_use").stop).toBe("tool_use");
    expect(toLlmResponse([{ type: "text", text: "done" }] as never, "end_turn").stop).toBe("end");
  });

  it("marks a max_tokens answer as cut short and drops any half-written tool call", () => {
    const content = [
      { type: "text", text: "Tomatoes are" },
      { type: "tool_use", id: "t1", name: "propose_price_change", input: {} },
    ] as never;
    const response = toLlmResponse(content, "max_tokens");
    expect(response.stop).toBe("end");
    expect(response.blocks.some((b) => b.type === "tool_use")).toBe(false);
    expect(response.blocks.at(-1)).toEqual({ type: "text", text: TRUNCATION_NOTICE });
  });

  it("drops a possibly cut-off thinking block from a max_tokens answer", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s1" },
      { type: "text", text: "Tomatoes are" },
    ] as never;
    expect(toLlmResponse(content, "max_tokens").blocks).toEqual([
      { type: "text", text: "Tomatoes are" },
      { type: "text", text: TRUNCATION_NOTICE },
    ]);
  });
});
