// A live scenario graded two ways: exact figures and proposal facts by code,
// behaviour by the LLM judge against plain-English criteria.

import { type LiveCategory } from "./live-scenarios.js";

export type ProposalKind = "price_change" | "review_reply";

// What a proposal changes, as code can check it: the item and its new price,
// or the review a reply answers.
export type ProposalTarget =
  | { readonly kind: "price_change"; readonly sku: string; readonly toMinor: number }
  | { readonly kind: "review_reply"; readonly reviewId: string };

// A proposal a written answer stands for, as the agent would have sent it to
// the gate: a price change, or a reply with its full text.
export type FixtureProposal =
  | Extract<ProposalTarget, { kind: "price_change" }>
  | (Extract<ProposalTarget, { kind: "review_reply" }> & { readonly text: string });

export function targetOf(p: FixtureProposal | ProposalTarget): ProposalTarget {
  return p.kind === "price_change" ? { kind: p.kind, sku: p.sku, toMinor: p.toMinor } : { kind: p.kind, reviewId: p.reviewId };
}

// What a criterion is about. It sets the row of the judge-check report a
// criterion counts in, and whether the strict bar (STRICT_TYPES in
// live-criteria.ts) covers it, so every criterion's type is written by hand.
export const CRITERION_TYPES = [
  "no-claim",
  "no-grant",
  "declines",
  "no-leak",
  "premise",
  "direction",
  "advice",
  "limits",
  "asks",
  "reading",
  "owner-switch",
  "style",
  "other",
] as const;
export type CriterionType = (typeof CRITERION_TYPES)[number];

// A figure that must appear, or a list of figures any one of which will do,
// e.g. the item's margin line or its category average.
export type FigureSpec = string | readonly string[];

export interface CriteriaScenario {
  readonly id: string;
  readonly category: LiveCategory;
  readonly question: string;
  // The failure this scenario catches; unique across the set.
  readonly why: string;
  // Figures that must appear, matched as whole figures ("£1,873", "17.8%", "212").
  readonly figures?: readonly FigureSpec[];
  readonly proposal?: { readonly expected: ProposalKind | "none" | "any"; readonly forbidKinds?: readonly ProposalKind[] };
  // One to four binary behavioural criteria, judged by the LLM judge, each
  // with its type; their ids are c1..c4 in order.
  readonly criteria: readonly (readonly [CriterionType, string])[];
  readonly goodAnswer: string;
  // The proposals the good answer made. Required when a proposal kind is
  // expected, and then each one must be made: code checks the item and price,
  // or the review answered, so no criterion has to restate them.
  readonly goodProposals?: readonly FixtureProposal[];
  readonly badAnswer: string;
  // The proposals the bad answer made or tried to make, where it claims one:
  // a claim with nothing behind it is a different failure from a real one.
  readonly badProposals?: readonly FixtureProposal[];
  // The criteria (c1..c4) the bad answer breaks. Required when the code
  // checks let it through and more than one criterion applies.
  readonly badViolates?: readonly string[];
}
