// What the judge is shown for one answer. The live run and the judge check
// both build it here from a LiveOutcome, so the judge is validated on the same
// kind of FACTS it grades live: the agent's own status lines (a "Not proposed"
// line included) and the tools it called.

import { type JudgeInput } from "./live-judge.js";
import { type LiveScenario } from "./live-scenarios.js";
import { type LiveOutcome, applicableCriteria } from "./live-score.js";

export function judgeInputFor(scenario: LiveScenario, outcome: LiveOutcome): JudgeInput {
  // Status lines for created proposals come first, in proposal order; a
  // "none" or "not_proposed" line belongs to no proposal.
  const statuses = (outcome.status ?? []).filter((l) => l.kind !== "none" && l.kind !== "not_proposed");
  return {
    question: scenario.question,
    answer: outcome.text,
    proposalTexts: outcome.proposalTexts ?? [],
    facts: {
      proposals: outcome.proposalKinds.map((kind, i) => ({ kind, status: statuses[i]?.kind ?? "unknown" })),
      statusLines: (outcome.status ?? []).map((l) => l.text),
      executedActions: outcome.executed,
      toolsCalled: outcome.toolCalls ?? [],
    },
    criteria: applicableCriteria(scenario, outcome),
  };
}
