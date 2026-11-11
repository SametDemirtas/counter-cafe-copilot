import { describe, expect, it } from "vitest";

import { historyMessages, remember } from "../../lib/agent/history.js";

const turn = (n: number) => ({ question: `q${n}`, answer: `a${n}` });

describe("historyMessages", () => {
  it("keeps the newest turns, oldest first, as user and assistant text", () => {
    const messages = historyMessages([turn(1), turn(2), turn(3)], 2);
    expect(messages.map((m) => [m.role, m.blocks[0]])).toEqual([
      ["user", { type: "text", text: "q2" }],
      ["assistant", { type: "text", text: "a2" }],
      ["user", { type: "text", text: "q3" }],
      ["assistant", { type: "text", text: "a3" }],
    ]);
  });

  it("caps each side's length and drops a turn with an empty side", () => {
    const messages = historyMessages([{ question: "x".repeat(50), answer: "ok" }, { question: "q", answer: "  " }], 6, 10);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.blocks[0]).toEqual({ type: "text", text: `${"x".repeat(9)}…` });
  });
});

describe("remember", () => {
  it("appends a turn and keeps only the most recent ones", () => {
    expect(remember([turn(1), turn(2)], turn(3), 2)).toEqual([turn(2), turn(3)]);
  });
});
