// The persona-written held-out sets (an owner or manager in a stated role), turned into the live scenario shape. Their
// good and bad answers become judge-check fixtures (live-fixtures.ts).

import { fromCriteriaScenario, withGuards } from "./live-criteria.js";
import { type CriteriaScenario } from "./live-criteria-types.js";
import { type AuthoredLiveScenario } from "./live-scenarios.js";
import { OWNER_A } from "./live-scenarios-owner-a.js";
import { OWNER_B } from "./live-scenarios-owner-b.js";
import { OWNER_C } from "./live-scenarios-owner-c.js";

export const OWNER_SOURCES: readonly CriteriaScenario[] = [...OWNER_A, ...OWNER_B, ...OWNER_C];

export const LIVE_SCENARIOS_OWNER: readonly AuthoredLiveScenario[] = OWNER_SOURCES.map((s) => withGuards(fromCriteriaScenario(s)));
