// The fixed rules behind the tools and the gate. Every answer may quote them
// ("the 50% limit", "after 5 replies", "3, 4 or 5 star"), even before any tool
// has run, and the system prompt states them from here, so the prompt and the
// grounding check can never disagree with the code that enforces them.

import { MARGIN_TOLERANCE } from "../tools/menu.js";
import { INVOICE_FLAG_THRESHOLD } from "../tools/invoice.js";
import { AUTOPILOT_RATINGS, AUTOPILOT_UNLOCK_APPROVALS, MAX_PRICE_CHANGE, MIN_AUTOPILOT_RATING } from "../safety/index.js";

export interface PolicyFigures {
  // Typed fractions, read as percentages.
  readonly maxChangePct: number;
  readonly flagThresholdPct: number;
  readonly marginTolerancePct: number;
  // Plain numbers, grounded as bare digits only.
  readonly autopilotUnlockReplies: number;
  readonly autopilotRatings: readonly number[];
  readonly ownerOnlyRatings: readonly number[];
}

const OWNER_ONLY_RATINGS: readonly number[] = Object.freeze(Array.from({ length: MIN_AUTOPILOT_RATING - 1 }, (_, i) => i + 1));

export const POLICY_FIGURES: PolicyFigures = Object.freeze({
  maxChangePct: MAX_PRICE_CHANGE,
  flagThresholdPct: INVOICE_FLAG_THRESHOLD,
  marginTolerancePct: MARGIN_TOLERANCE,
  autopilotUnlockReplies: AUTOPILOT_UNLOCK_APPROVALS,
  autopilotRatings: AUTOPILOT_RATINGS,
  ownerOnlyRatings: OWNER_ONLY_RATINGS,
});
