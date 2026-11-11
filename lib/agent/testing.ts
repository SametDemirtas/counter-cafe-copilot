// In lib/ rather than tests/ because the eval harness uses it too.

import { type LlmClient, type LlmResponse } from "./llm.js";

export class ScriptedLlm implements LlmClient {
  private index = 0;
  constructor(private readonly script: readonly LlmResponse[]) {}
  async respond(): Promise<LlmResponse> {
    const next = this.script[this.index++];
    if (!next) throw new Error("scripted model: response script exhausted");
    return next;
  }
}
