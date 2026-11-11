export interface LlmTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export type LlmBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly content: string;
      readonly isError?: boolean;
    }
  // A block only the provider understands, such as a thinking block with its
  // signature. The agent never reads it; it keeps it in place so the adapter
  // can send it back exactly as received.
  | { readonly type: "opaque"; readonly provider: string; readonly raw: unknown };

export interface LlmMessage {
  // "system" is an operator note appended mid-conversation: never the owner's
  // words. It must follow a user message and be last or followed by an
  // assistant turn, and it carries text blocks only.
  readonly role: "user" | "assistant" | "system";
  readonly blocks: readonly LlmBlock[];
}

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmTool[];
}

export interface LlmResponse {
  readonly blocks: readonly LlmBlock[];
  readonly stop: "tool_use" | "end";
  // Set when the provider declined to answer. The blocks then hold only a
  // short decline for the owner; any partial output was discarded.
  readonly refusal?: { readonly category: string | null };
  // inputTokens counts every input token; the cache figures are its shares.
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
}

export interface LlmClient {
  respond(request: LlmRequest): Promise<LlmResponse>;
}
