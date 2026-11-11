// The deterministic checks autopilot runs next to the classifier. Both are a
// floor and both can only send a reply to the owner, never clear one.
//
// The review tripwire is a short, frozen list of words for the cases that must
// never be answered by a machine: illness, allergy, injury, refunds and legal
// trouble. It does not try to read tone or catch every phrasing; that is the
// classifier's job. A hit sends the review to the owner whatever the classifier
// said. The list is frozen on purpose: growing it into a sentiment model is the
// failure this design avoids.
//
// The draft checks look at the reply autopilot would post, which is always a
// reply the owner approved before with a new name in it. They are structural
// and work in any language: no digits, no link or domain, no email, no phone,
// no @handle, a length cap, and no name the café knows other than the
// reviewer's. A small frozen English promise list rides along as a tripwire.
// Anything that needs judgement about what a reply says belongs to the owner.

import { nameWords } from "./names.js";

export interface TripwireResult {
  readonly hit: boolean;
  readonly terms: readonly string[];
}

// Stems and phrases, matched case-insensitively at a word start. A handful of
// other-language stems sit next to the English ones where they are spelt
// almost the same; this is not a translation table.
export const REVIEW_TRIPWIRE: readonly string[] = Object.freeze([
  // Illness, allergy, injury.
  "food poisoning",
  "poison",
  "sick",
  "vomit",
  "threw up",
  "diarrh",
  "allerg",
  "anaphyla",
  "epipen",
  "coeliac",
  "celiac",
  "injur",
  "hospital",
  "ambulance",
  "a&e",
  "glass in",
  // Refunds and legal trouble.
  "refund",
  "chargeback",
  "lawyer",
  "solicitor",
  "legal action",
  "suing",
  "small claims",
  "police",
  "trading standards",
  "environmental health",
  "health inspector",
]);

// NFKC so a fullwidth or ligature form reads as the plain letter, then format
// characters such as a zero-width space removed, which NFKC keeps.
export function readable(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `term` as a whole word: no letter or digit right before or after it.
export const wholeWord = (term: string, flags = "iu") =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, flags);

const startsWord = (term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}`, "iu");
const REVIEW_PATTERNS = REVIEW_TRIPWIRE.map((term) => [term, startsWord(term)] as const);

export function reviewTripwire(reviewText: string): TripwireResult {
  const text = readable(reviewText);
  const terms = REVIEW_PATTERNS.filter(([, p]) => p.test(text)).map(([term]) => term);
  return Object.freeze({ hit: terms.length > 0, terms: Object.freeze(terms) });
}

// A reply longer than this is not the short thank-you autopilot exists for.
export const MAX_AUTOPILOT_REPLY_CHARS = 280;

export type DraftRule = "empty" | "too_long" | "digit" | "link" | "email" | "phone" | "handle" | "other_name" | "promise";

export interface DraftCheckResult {
  readonly ok: boolean;
  readonly failures: readonly DraftRule[];
}

export const PROMISE_TRIPWIRE: readonly string[] = Object.freeze([
  "refund",
  "discount",
  "free",
  "on us",
  "on the house",
  "voucher",
  "coupon",
  "code",
  "gift card",
  "compensat",
  "money back",
  "guarantee",
  "make it up to you",
]);
const PROMISE_PATTERNS = PROMISE_TRIPWIRE.map(startsWord);

const STRUCTURAL: ReadonlyArray<readonly [DraftRule, RegExp]> = [
  // Seven or more digits with spacing or punctuation between them.
  ["phone", /(?:\p{Nd}[\s().+-]{0,2}){7,}/u],
  ["digit", /\p{Nd}/u],
  ["email", /[^\s@]+@[^\s@]+\.[^\s@]+/u],
  ["handle", /@[\p{L}\p{N}_]/u],
  ["link", /https?:\/\/|\bwww\.|[\p{L}\p{N}-]\.[a-z]{2,24}(?:\/|\b)(?![\p{L}])/iu],
];

export interface DraftContext {
  // The reviewer's name; the only person the reply may name.
  readonly reviewer: string;
  // Every name the café knows: reviewers and staff.
  readonly knownNames: readonly string[];
}

export function checkDraft(replyText: string, context: DraftContext): DraftCheckResult {
  const text = readable(replyText);
  const failures: DraftRule[] = [];
  if (text.trim().length === 0) failures.push("empty");
  if ([...text].length > MAX_AUTOPILOT_REPLY_CHARS) failures.push("too_long");
  for (const [rule, pattern] of STRUCTURAL) {
    if (pattern.test(text)) failures.push(rule);
  }
  // Any known name, whole or by one of its words ("Megan" or "Rees" of
  // "Megan Rees"), except the reviewer's own.
  const own = new Set([context.reviewer, ...nameWords(context.reviewer)].map((n) => n.trim().toLowerCase()));
  const others = context.knownNames.flatMap((n) => [n, ...nameWords(n)]).map((n) => n.trim()).filter((n) => n !== "" && !own.has(n.toLowerCase()));
  if (others.some((name) => wholeWord(name).test(text))) failures.push("other_name");
  if (PROMISE_PATTERNS.some((p) => p.test(text))) failures.push("promise");
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}
