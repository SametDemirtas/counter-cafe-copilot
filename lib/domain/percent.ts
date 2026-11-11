import { roundTo } from "./round.js";

// Fractions travel as *Pct fields (0.178); text shows them as percentages
// (17.8). The grounding check rounds with the same roundTo, so a percentage
// the brief or the demo prints is always one the check accepts.
export function percentOf(fraction: number, decimals = 0): number {
  return roundTo(fraction * 100, decimals);
}
