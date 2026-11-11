// A recorded metric, never a score: did the model's own words read like "I've
// created the proposal" when the run created none? The check is an English
// wording match (lib/agent/claims.ts) that misses paraphrases, so it only
// counts how often the obvious wording shows up. What decides a claim is the
// judge's no-claim criterion, read against the code-rendered status lines.

import { proposalClaim } from "../agent/claims.js";

// An eval run starts from an empty store, so with no proposal created in the
// run, "waiting for your approval" is as false as "I've created".
export function falseProposalClaim(body: string, proposalsCreated: number): boolean {
  return proposalsCreated === 0 && proposalClaim(body) !== undefined;
}
