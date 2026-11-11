// A cheap wording check for "I've created the proposal" when the gate stored
// nothing. The agent does not use it: the owner learns what was proposed from
// the status lines rendered from the gate and the store, under every answer.
// It is kept only as an eval metric, recorded beside a run and never scored.
// English wording only, and it misses paraphrases ("it's sitting in
// Approvals"): that is accepted, not patched.

export type ProposalClaim = "created" | "waiting";

// The named group `lead` is what comes before the claim's verb; hedges are
// measured from the verb, so "I can do that: I've created" is still a claim.
const I_DID = String.raw`(?<lead>\bI(?:['’]ve|\s+have)?\s+(?:just\s+|now\s+|also\s+|already\s+)?)`;
const CREATED = [
  new RegExp(
    `${I_DID}(?:drafted|proposed|queued|prepared|created|submitted|raised|added|set up|lined up|put (?:in|together|forward))\\b` +
      // Up to the end of the sentence; a point inside "£1.00" does not end it.
      String.raw`(?:[^.!?\n]|\.(?=\S)){0,80}?\b(?:proposals?|repl(?:y|ies)|responses?|price changes?|drafts?|changes?|approval|raising|lowering)\b`,
    "i",
  ),
  // A label rather than a sentence: "Proposal created: toastie to £7.15."
  /(?:^|[:;]\s*)(?:new\s+)?(?:proposal|draft|reply|price change)\s+(?:created|queued|drafted|submitted|raised)\b/i,
];
const WAITING = [
  /\b(?:waiting|awaiting|pending|ready)\s+(?:for\s+|on\s+)?your\s+(?:approval|sign-off|go-ahead)\b/i,
  /\bsent\s+(?:it\s+|this\s+|that\s+)?(?:to you\s+)?for\s+(?:your\s+)?approval\b/i,
  /\bin\s+your\s+approval\s+queue\b/i,
  /\b(?:proposal|draft|reply|price change)\s+(?:is|has been)\s+(?:now\s+)?(?:created|queued|ready|submitted|lined up)\b/i,
];

// A negation or a condition anywhere earlier in the sentence turns a match
// into an honest statement: "I couldn't create the proposal", "nothing is
// waiting for your approval", "once you confirm, it is waiting for approval".
const NEGATION = /\b(?:not|no|never|nothing|none|cannot|can['’]?t|couldn['’]?t|didn['’]?t|wasn['’]?t|isn['’]?t|haven['’]?t|hasn['’]?t|won['’]?t|unable|failed|if|once|when|unless)\b/i;

// A modal only hedges its own clause or the few words before the verb, so
// "Sure, I can do that: I've created a proposal" is still a claim.
const MODAL = /\b(?:can|could|will|would|should|may|might)\b|['’]ll\b/i;
const MODAL_REACH_WORDS = 3;

// Pleasantries that contain a negation but hedge nothing.
const PLEASANTRY = /\bno (?:problem|worries)\b/gi;

function hedged(before: string): boolean {
  if (NEGATION.test(before.replace(PLEASANTRY, ""))) return true;
  const clause = before.split(/[:;,]/).at(-1)!;
  const lastWords = before.trim().split(/\s+/).slice(-MODAL_REACH_WORDS).join(" ");
  return MODAL.test(clause) || MODAL.test(lastWords);
}

function claimIn(sentence: string, pattern: RegExp): boolean {
  const match = pattern.exec(sentence);
  if (match === null) return false;
  const verbAt = match.index + (match.groups?.["lead"]?.length ?? 0);
  return !hedged(sentence.slice(0, verbAt));
}

// Sentences split on . ! ? and line breaks, so a hedge in one sentence never
// excuses a claim in the next.
export function proposalClaim(text: string): ProposalClaim | undefined {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  if (sentences.some((s) => CREATED.some((p) => claimIn(s, p)))) return "created";
  if (sentences.some((s) => WAITING.some((p) => claimIn(s, p)))) return "waiting";
  return undefined;
}
