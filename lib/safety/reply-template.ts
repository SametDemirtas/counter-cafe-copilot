// The owner's reply templates: one per star rating autopilot may cover, written
// by the owner, and the only text autopilot ever posts. A template may hold one
// slot, {name}, for the reviewer's first name. It goes in only when the
// reviewer's display name passes greetingName; otherwise the slot is dropped
// together with the comma and space before it, so "Thank you, {name}!" becomes
// "Thank you!". That is why the slot has to follow a word.
//
// A template is checked when the owner saves it, in both forms (with the
// longest name allowed, and with no name), by the same draft checks autopilot
// runs before it posts. A template that fails is never stored.

import { MAX_AUTOPILOT_REPLY_CHARS, type DraftRule, checkDraft } from "./autopilot-checks.js";
import { MAX_NAME_CHARS, greetingName } from "./names.js";

export const NAME_SLOT = "{name}";

// The slot as the owner may place it: after a non-space character, with an
// optional comma and one space before it, and no letter or digit straight after.
const PLACED_SLOT = /(?<=\S),? \{name\}(?![\p{L}\p{N}_])/u;

// "slot": the {name} slot is misplaced, repeated, or there are other braces.
export type TemplateRule = DraftRule | "slot";

export interface TemplateCheck {
  readonly ok: boolean;
  readonly failures: readonly TemplateRule[];
}

export interface RenderedReply {
  readonly text: string;
  // Whether the reviewer's first name went in.
  readonly named: boolean;
}

const slotCount = (text: string) => text.split(NAME_SLOT).length - 1;

function slotProblem(text: string): boolean {
  const count = slotCount(text);
  if (count > 1) return true;
  if (/[{}]/u.test(text.replace(NAME_SLOT, ""))) return true;
  return count === 1 && !PLACED_SLOT.test(text);
}

// The template as it goes to `reviewer`. Assumes a template that passed
// checkTemplate; the posted text is checked again by checkDraft anyway.
export function renderTemplate(template: string, reviewer: string): RenderedReply {
  if (!template.includes(NAME_SLOT)) return Object.freeze({ text: template, named: false });
  const name = greetingName(reviewer);
  if (name === undefined) return Object.freeze({ text: template.replace(PLACED_SLOT, () => ""), named: false });
  return Object.freeze({ text: template.replace(NAME_SLOT, () => name), named: true });
}

// The longest first name greetingName lets through, for the length check.
const LONGEST_NAME = "N".repeat(MAX_NAME_CHARS);

export function checkTemplate(template: string, knownNames: readonly string[]): TemplateCheck {
  const failures = new Set<TemplateRule>();
  if (slotProblem(template)) failures.add("slot");
  const plain = template.includes(NAME_SLOT) ? template.replace(PLACED_SLOT, () => "").replace(NAME_SLOT, () => "") : template;
  for (const rule of checkDraft(plain, { reviewer: "", knownNames }).failures) failures.add(rule);
  if ([...template.replace(NAME_SLOT, () => LONGEST_NAME)].length > MAX_AUTOPILOT_REPLY_CHARS) failures.add("too_long");
  const list = Object.freeze([...failures]);
  return Object.freeze({ ok: list.length === 0, failures: list });
}

const RULE_WORDS: Record<TemplateRule, string> = {
  slot: `use {name} at most once, after a word, as in "Thank you, {name}!", and no other braces`,
  empty: "write some text",
  too_long: `keep it under ${MAX_AUTOPILOT_REPLY_CHARS} characters, counting a ${MAX_NAME_CHARS} letter name`,
  digit: "no digits",
  link: "no links or web addresses",
  email: "no email addresses",
  phone: "no phone numbers",
  handle: "no @handles",
  other_name: "no names of staff or other customers",
  promise: "no offers or promises such as refunds, discounts or anything free",
};

// The failures in words the owner can act on.
export function templateFailureText(failures: readonly TemplateRule[]): string {
  return failures.map((f) => RULE_WORDS[f]).join("; ");
}
