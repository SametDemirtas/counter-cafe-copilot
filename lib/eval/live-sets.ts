// Which live scenarios a run covers. The dev set is the one the prompt was
// developed against. The prompt was not tuned on the held-out set or the
// persona-written owner sets, so their pass rates are the more honest ones.
// "all" is every set.

import { ALL_LIVE_SCENARIOS, LIVE_SCENARIOS, LIVE_SCENARIOS_OWNER, type LiveScenario } from "./live-scenarios.js";
import { LIVE_SCENARIOS_HELDOUT } from "./live-scenarios-heldout.js";
import { type RepSummary } from "./live-score.js";

export const EVAL_SETS = ["dev", "heldout", "owner", "all"] as const;
export type EvalSet = (typeof EVAL_SETS)[number];

// undefined means the value is invalid and the run must stop.
export function parseEvalSet(raw: string | undefined): EvalSet | undefined {
  if (raw === undefined || raw.trim() === "") return "dev";
  const value = raw.trim();
  return (EVAL_SETS as readonly string[]).includes(value) ? (value as EvalSet) : undefined;
}

export function scenariosFor(set: EvalSet): readonly LiveScenario[] {
  if (set === "heldout") return LIVE_SCENARIOS_HELDOUT;
  if (set === "owner") return LIVE_SCENARIOS_OWNER;
  return set === "all" ? ALL_LIVE_SCENARIOS : LIVE_SCENARIOS;
}

export interface SetTally {
  readonly runs: number;
  readonly passes: number;
  readonly green: number;
  readonly scenarios: number;
}

interface Tallied {
  readonly scenario: LiveScenario;
  readonly summary: Pick<RepSummary, "reps" | "passes" | "status">;
}

// heldOut true counts the held-out and owner sets together; ownerOnly narrows
// that to the owner sets.
export function tally(reports: readonly Tallied[], heldOut: boolean, ownerOnly = false): SetTally {
  const mine = reports.filter((r) => (r.scenario.heldOut ?? false) === heldOut && (!ownerOnly || r.scenario.ownerSet === true));
  return {
    runs: mine.reduce((s, r) => s + r.summary.reps, 0),
    passes: mine.reduce((s, r) => s + r.summary.passes, 0),
    green: mine.filter((r) => r.summary.status === "green").length,
    scenarios: mine.length,
  };
}
