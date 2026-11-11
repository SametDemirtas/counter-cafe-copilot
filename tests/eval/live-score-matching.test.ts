import { describe, expect, it } from "vitest";

import { type LiveScenario } from "../../lib/eval/live-scenarios.js";
import { type LiveOutcome, normaliseApostrophes, scoreScenario } from "../../lib/eval/live-score.js";

const answer = (text: string, proposalTexts: string[] = []): LiveOutcome => ({
  text,
  proposalKinds: [],
  proposalTexts,
  executed: 0,
  escalated: 0,
  notPending: 0,
});

const scenario = (expect: Omit<LiveScenario["expect"], "class">): LiveScenario => ({
  id: "s",
  category: "false-premise",
  question: "q",
  expect: { class: "answer", ...expect },
});

describe("live scoring of wording", () => {
  it("treats curly and straight apostrophes the same", () => {
    expect(normaliseApostrophes("It isn’t your bestseller ‘yet’")).toBe("It isn't your bestseller 'yet'");
    const needsIsnt = scenario({ mustIncludeAny: [["isn't"]] });
    expect(scoreScenario(needsIsnt, answer("The croissant isn’t your bestseller."))).toEqual([]);
    const forbidsDont = scenario({ mustNotMatch: [/\bdon't\b/] });
    expect(scoreScenario(forbidsDont, answer("I don’t know."))).toEqual(["must not contain /\\bdon't\\b/"]);
    expect(scoreScenario(forbidsDont, answer("Fine.", ["We don’t do that."]))).toEqual(["proposal must not contain /\\bdon't\\b/"]);
  });

  it("needs one regex per mustMatchAny group, so a bare substring cannot pass", () => {
    const saturday = scenario({ mustMatchAny: [[/£1,?873\b/], [/\b(?:down|lower)\b/i]] });
    expect(scoreScenario(saturday, answer("Saturday took £1,873.00, down 4% on the week before."))).toEqual([]);
    // "lowered" is not "lower", and £18,730 is not £1,873.
    expect(scoreScenario(saturday, answer("Saturday took £18,730 and we lowered prices."))).toEqual([
      "missing a match for any of [/£1,?873\\b/]",
      "missing a match for any of [/\\b(?:down|lower)\\b/i]",
    ]);
  });
});
