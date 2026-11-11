// Earlier turns of the conversation, as plain text, so a follow-up such as
// "and the second one?" has something to refer to. Only the owner's question
// and the answer they saw are kept: no tool calls, tool results or proposals,
// so an earlier turn can never act or vouch for a figure in this one.

import { type LlmMessage } from "./llm.js";

export interface Turn {
  readonly question: string;
  readonly answer: string;
}

export const MAX_HISTORY_TURNS = 6;
const MAX_TURN_CHARS = 2000;

function clip(text: string, maxChars: number): string {
  const chars = Array.from(text.trim());
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}…` : chars.join("");
}

// The newest turns first in priority, oldest first in order. A turn with an
// empty side is dropped: the model API refuses an empty text block.
export function historyMessages(
  turns: readonly Turn[],
  maxTurns = MAX_HISTORY_TURNS,
  maxChars = MAX_TURN_CHARS,
): LlmMessage[] {
  return turns
    .filter((t) => t.question.trim() !== "" && t.answer.trim() !== "")
    .slice(-maxTurns)
    .flatMap((t): LlmMessage[] => [
      { role: "user", blocks: [{ type: "text", text: clip(t.question, maxChars) }] },
      { role: "assistant", blocks: [{ type: "text", text: clip(t.answer, maxChars) }] },
    ]);
}

// Appends a turn and keeps only the most recent ones, for a caller that holds
// the conversation (the web session).
export function remember(turns: readonly Turn[], turn: Turn, maxTurns = MAX_HISTORY_TURNS): Turn[] {
  return [...turns, turn].slice(-maxTurns);
}
