// An offline stand-in for the model, used when no API key is set. It answers
// the prompts in demo-script.ts and nothing else: each one is a single tool
// call, narrated from a template. It can only call the same propose_* tools as
// the model, so it too can at most leave a proposal.

import { type LlmClient, type LlmMessage, type LlmRequest, type LlmResponse } from "../agent/llm.js";
import { type Review, ReviewsSchema } from "../tools/reviews.js";
import reviewsJson from "../data/mock/reviews.json";
import { type ToolResultBlock, narrate } from "./demo-narrate.js";
import { type DemoPrompt, OFFLINE_ONLY, demoScript, promptKey } from "./demo-script.js";

export class DemoLlmClient implements LlmClient {
  private calls = 0;
  private readonly script: ReadonlyMap<string, DemoPrompt>;
  readonly prompts: readonly DemoPrompt[];

  constructor(reviews: readonly Review[] = ReviewsSchema.parse(reviewsJson)) {
    this.prompts = demoScript(reviews);
    this.script = new Map(this.prompts.map((p) => [promptKey(p.question), p]));
  }

  // The questions the page offers as buttons.
  suggestions(): readonly string[] {
    return this.prompts.map((p) => p.question);
  }

  async respond(request: LlmRequest): Promise<LlmResponse> {
    const prompt = this.script.get(promptKey(latestQuestion(request.messages)));
    const result = latestToolResult(request.messages);
    if (result) return say(narrate(result.block, result.toolName, prompt?.tool === result.toolName ? prompt.narrator : undefined));
    if (!prompt) return say(OFFLINE_ONLY);
    this.calls += 1;
    return {
      stop: "tool_use",
      blocks: [{ type: "tool_use", id: `demo-call-${this.calls}`, name: prompt.tool, input: prompt.input }],
    };
  }
}

const say = (text: string): LlmResponse => ({ stop: "end", blocks: [{ type: "text", text }] });

// The newest text the owner wrote: earlier turns of the conversation come
// first. The agent's own corrections arrive as system notes, not user turns.
function latestQuestion(messages: readonly LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const block = message.blocks.find((b) => b.type === "text");
    if (block?.type === "text") return block.text;
  }
  return "";
}

// A result since the newest question, with the name of the tool call it answers.
function latestToolResult(messages: readonly LlmMessage[]): { block: ToolResultBlock; toolName: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const block = message.blocks.find((b): b is ToolResultBlock => b.type === "tool_result");
    if (block) {
      const call = messages
        .flatMap((m) => m.blocks)
        .find((b) => b.type === "tool_use" && b.id === block.toolUseId);
      return { block, toolName: call?.type === "tool_use" ? call.name : "" };
    }
    if (message.role === "user" && message.blocks.some((b) => b.type === "text")) return undefined;
  }
  return undefined;
}
