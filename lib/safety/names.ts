// The only part of a reviewer's display name autopilot ever writes into a
// reply: a plain one-word first name. This is a shape check, not a list of
// real names: it keeps sentences, links, slogans in hyphens or CamelCase and
// decorated text out of the name slot, but a single ordinary word ("Scammers")
// has the shape of a name and passes. An owner who wants no reviewer text in
// autopilot's replies at all marks only replies that name nobody for reuse.
//
// Accepted: up to MAX_NAME_CHARS letters in any script, with at most one inner
// apostrophe or hyphen (Anne-Marie, O'Neil), at most two capitals per part
// (McDonald, DeShawn), nothing NFKC would change (fullwidth or lookalike
// forms), and no combining mark on a Latin, Greek or Cyrillic letter, whose
// real accented forms are single precomposed characters ("L̷e̷n̷a̷" is refused,
// "Zoë" is not). Other scripts may carry up to two marks per letter.

export const MAX_NAME_CHARS = 20;
const MAX_CAPITALS_PER_PART = 2;

const PART = String.raw`(?:\p{L}\p{M}{0,2})+`;
const NAME_WORD = new RegExp(`^${PART}(?:['’-]${PART})?$`, "u");
const MARKED_ALPHABETIC = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]\p{M}/u;

// Names review sites show when the reviewer gave none, as a first word or the
// whole display name. Not a first name, so a reply never says "Thanks Anon".
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(["anon", "anonymous", "guest", "customer", "user", "unknown", "a google user"]);

// The first word of a display name when it is a plain name, else undefined.
// "Megan R." gives "Megan"; "Ruth.", "Anon" and "" give undefined.
export function greetingName(displayName: string): string | undefined {
  const first = displayName.trim().split(/\s+/u)[0] ?? "";
  if (first.normalize("NFKC") !== first) return undefined;
  if ([...first].length > MAX_NAME_CHARS || !NAME_WORD.test(first) || MARKED_ALPHABETIC.test(first)) return undefined;
  if (first.split(/['’-]/u).some((part) => (part.match(/\p{Lu}/gu) ?? []).length > MAX_CAPITALS_PER_PART)) return undefined;
  if (PLACEHOLDER_NAMES.has(first.toLowerCase()) || PLACEHOLDER_NAMES.has(displayName.trim().toLowerCase())) return undefined;
  return first;
}

// Every word of a display name that could name its owner in a reply: the
// first name and any further plain name ("Megan Rees" gives Megan and Rees;
// an initial such as "R." is left out).
export function nameWords(displayName: string): readonly string[] {
  const words = displayName.trim().split(/\s+/u).map((w) => w.replace(/[.,]+$/u, ""));
  return words.map((w) => greetingName(w)).filter((w): w is string => w !== undefined && [...w].length > 1);
}
