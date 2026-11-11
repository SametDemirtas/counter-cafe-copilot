// Mapping functions are exported so they can be tested without an API key.

import Anthropic from "@anthropic-ai/sdk";

import { type LlmBlock, type LlmClient, type LlmMessage, type LlmRequest, type LlmResponse } from "./llm.js";

export type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface AnthropicLlmOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly effort?: Effort;
}

// The one place the default model id lives; the live eval prices runs against it.
export const DEFAULT_MODEL = "claude-sonnet-5-5";
// Thinking counts against max_tokens, so this leaves room for it and a full
// answer with its tool calls. 16000 stays under the SDK's 10 minute limit for a
// non-streaming request.
export const DEFAULT_MAX_TOKENS = 16000;
// Sonnet 5.5 recalibrated its effort levels; medium is Anthropic's starting
// point for multistep tool use, which is what every question here is.
export const DEFAULT_EFFORT: Effort = "medium";
export const TRUNCATION_NOTICE = "(This answer was cut short by the length limit.)";
export const REFUSAL_TEXT = "I can't help with that request.";
const PROVIDER = "anthropic";

function effortFrom(value: string | undefined): Effort | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const effort = EFFORTS.find((e) => e === value.trim());
  if (!effort) throw new Error(`ANTHROPIC_EFFORT must be one of ${EFFORTS.join(", ")}, not "${value}"`);
  return effort;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: Effort;

  constructor(options: AnthropicLlmOptions = {}) {
    this.client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    // Read here, not at import, so an env change before startup still counts.
    this.model = options.model ?? process.env["ANTHROPIC_MODEL"] ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.effort = options.effort ?? effortFrom(process.env["ANTHROPIC_EFFORT"]) ?? DEFAULT_EFFORT;
  }

  get modelId(): string {
    return this.model;
  }

  get effortLevel(): Effort {
    return this.effort;
  }

  async respond(request: LlmRequest): Promise<LlmResponse> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort },
      // Tools and the system prompt form a stable prefix; the first breakpoint
      // caches it across questions. The second, on the newest block, caches the
      // growing conversation across the turns of one question.
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      tools: request.tools.map(
        (t): Anthropic.Tool => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        }),
      ),
      messages: withTrailingCacheBreakpoint(request.messages.map(toMessageParam)),
    });

    return toLlmResponse(message.content, message.stop_reason, message.usage, message.stop_details);
  }
}

interface ApiUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
}

// On max_tokens, drop any half-written tool call and say the answer was cut
// short. On a refusal, drop whatever was written and say so plainly.
export function toLlmResponse(
  content: readonly Anthropic.ContentBlock[],
  stopReason: string | null,
  apiUsage?: ApiUsage,
  stopDetails?: { readonly category?: string | null } | null,
): LlmResponse {
  const blocks = content.map(fromContentBlock);
  const usage = apiUsage
    ? {
        inputTokens:
          apiUsage.input_tokens + (apiUsage.cache_read_input_tokens ?? 0) + (apiUsage.cache_creation_input_tokens ?? 0),
        outputTokens: apiUsage.output_tokens,
        cacheReadTokens: apiUsage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: apiUsage.cache_creation_input_tokens ?? 0,
      }
    : undefined;
  const withUsage = usage ? { usage } : {};
  if (stopReason === "refusal") {
    return {
      blocks: [{ type: "text", text: REFUSAL_TEXT }],
      stop: "end",
      refusal: { category: stopDetails?.category ?? null },
      ...withUsage,
    };
  }
  if (stopReason === "max_tokens") {
    // A thinking block cut off mid-way may not carry a valid signature, so
    // only the text survives.
    const text = blocks.filter((b) => b.type === "text");
    return { blocks: [...text, { type: "text", text: TRUNCATION_NOTICE }], stop: "end", ...withUsage };
  }
  return { blocks, stop: stopReason === "tool_use" ? "tool_use" : "end", ...withUsage };
}

// The breakpoint goes on the newest user or assistant block. A trailing
// system note is new on every correction, so it stays after the breakpoint.
export function withTrailingCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.role === "system") index--;
  const last = messages[index];
  if (!last || typeof last.content === "string" || last.content.length === 0) return messages;
  const blocks = [...last.content];
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1]!, cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
  return [...messages.slice(0, index), { ...last, content: blocks } as Anthropic.MessageParam, ...messages.slice(index + 1)];
}

export function toMessageParam(message: LlmMessage): Anthropic.MessageParam {
  if (message.role === "system") {
    const text = message.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
    return { role: "system", content: text };
  }
  return {
    role: message.role,
    content: message.blocks.flatMap((b) => {
      const param = toContentBlockParam(b);
      return param ? [param] : [];
    }),
  };
}

// An opaque block goes back as the very object the API returned: a thinking
// block's text and signature must reach the API unchanged and in order.
export function toContentBlockParam(block: LlmBlock): Anthropic.ContentBlockParam | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError ?? false,
      };
    case "opaque":
      return block.provider === PROVIDER ? (block.raw as Anthropic.ContentBlockParam) : null;
  }
}

// Text and tool calls are mapped; thinking and anything else is carried as is.
export function fromContentBlock(block: Anthropic.ContentBlock): LlmBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  return { type: "opaque", provider: PROVIDER, raw: block };
}
