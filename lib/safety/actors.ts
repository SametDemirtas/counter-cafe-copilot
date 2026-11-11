// Names the audit log uses for non-humans. A human using one would muddy who decided.

export const AGENT_ACTOR = "agent";
export const SYSTEM_ACTOR = "system";
export const AUTOPILOT_ACTOR = "autopilot";

const RESERVED_ACTORS = new Set([AGENT_ACTOR, SYSTEM_ACTOR, AUTOPILOT_ACTOR]);

// Control, format (zero-width joiners, bidi marks), separators other than a
// plain space, and unassigned or private-use code points.
const NON_PRINTING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/u;

// Letters only, lower case, so "Auto-pilot", "agent." and "a.g.e.n.t" all read
// as the reserved name they spell.
function lettersOf(name: string): string {
  return name.normalize("NFKC").replace(/[^\p{L}]/gu, "").toLowerCase();
}

// Approver names are Latin-script letters (accents included), spaces,
// apostrophes, hyphens and dots. Cyrillic and Greek have letters that look like
// Latin ones and NFKC leaves them alone, so a name such as "аутопилот" or
// "аgеnt" could pass for a reserved name in the audit log. Confusable tables
// for every script would be a larger job than this demo's local approver needs.
const NAME = /^[\p{Script=Latin} '’.-]+$/u;
const HAS_LETTER = /\p{L}/u;

export function isValidApprover(approver: unknown): approver is string {
  if (typeof approver !== "string") return false;
  const name = approver.trim();
  if (name.length === 0 || NON_PRINTING.test(name)) return false;
  // A name that changes under NFKC was written with lookalike forms.
  if (name.normalize("NFKC") !== name) return false;
  if (!NAME.test(name) || !HAS_LETTER.test(name)) return false;
  return !RESERVED_ACTORS.has(lettersOf(name));
}

export function humanApprover(approver: string): string {
  if (!isValidApprover(approver)) throw new Error(`"${String(approver)}" is not a valid approver`);
  return approver.trim();
}
