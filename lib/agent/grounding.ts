// Numbers are enforced in code, like actions. Every money amount, percentage
// and count in an answer must match a figure a tool actually produced, or one
// the owner wrote. Ground truth comes from typed numeric fields only (`*Minor`
// is money in minor units, `*Pct` is a fraction, and a short list of count
// fields). Strings in a tool result are never read for figures: review text, a
// day's note or an invoice line's name is text someone else wrote, and a
// summary that echoes the model's own input is the model's, so none of them
// can vouch for a number.
//
// Any other run of digits ("takings were 2,950", "312 customers") is checked
// too, more loosely: it must equal some number a tool returned, a part of a
// date, time or id a tool returned, or a number in the owner's question.
// Figures written in words ("twelve hundred") are not checked.

import { CURRENCY_SYMBOLS, type Currency, CurrencySchema } from "../domain/money.js";
import { roundTo } from "../domain/round.js";

export type FigureKind = "money" | "percent" | "count";

export interface Figure {
  readonly raw: string;
  readonly kind: FigureKind;
  // As shown: pounds for money, percentage points for a percent.
  readonly value: number;
  // Digits after the point as shown: "£12" is 0, "£12.00" is 2, and "£1.2k"
  // is -2 (to the nearest hundred).
  readonly decimals: number;
  readonly currency?: Currency;
}

const SYMBOL_TO_CURRENCY = new Map(
  (Object.entries(CURRENCY_SYMBOLS) as [Currency, string][]).map(([code, symbol]) => [symbol, code] as const),
);

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?`;
// No digit, point or comma just before, so "1,200p" and "193.48 units" are each
// one number rather than a tail of one.
const START = String.raw`(?<![\d.,])`;
// "£1.2k" is £1,200 to the nearest hundred, not £1.20.
const SCALE = String.raw`(?:([km])\b)?`;

// How an amount in the minor unit is written: 320p in pounds, 320c in euros,
// 32¢ or 32c in dollars.
const MINOR_UNIT: Readonly<Record<Currency, string>> = {
  GBP: String.raw`p\b`,
  EUR: String.raw`c\b`,
  USD: String.raw`(?:¢|c\b)`,
};

// Amounts written with a word: "320 pence", "3.20 pounds".
const UNIT_WORDS = String.raw`(pounds?|euros?|dollars?|pence|pennies|penny|cents?)\b`;

function figurePattern(currency: Currency): RegExp {
  return new RegExp(
    [
      String.raw`([£€$])\s?${NUMBER}${SCALE}`,
      String.raw`\b(GBP|EUR|USD)\s?${NUMBER}${SCALE}`,
      String.raw`${START}(\d{1,3}(?:,\d{3})+|\d+)${MINOR_UNIT[currency]}`,
      String.raw`${START}${NUMBER}\s?(?:%|per ?cent\b)`,
      String.raw`${START}${NUMBER}\s?${UNIT_WORDS}`,
      String.raw`${START}${NUMBER}\s+(?:orders?|transactions?|units?|sold|trading days)\b`,
    ].join("|"),
    "gi",
  );
}

const FIGURE: Readonly<Record<Currency, RegExp>> = {
  GBP: figurePattern("GBP"),
  EUR: figurePattern("EUR"),
  USD: figurePattern("USD"),
};

function decimalsOf(fraction: string | undefined): number {
  return fraction ? fraction.length - 1 : 0;
}

function plain(digits: string): number {
  return Number(digits.replace(/,/g, ""));
}

const SCALE_DIGITS: Readonly<Record<string, number>> = { k: 3, m: 6 };

// A scaled amount keeps the precision it was written with: "£1.2k" is shown to
// the hundred, so its decimals are 1 - 3 = -2.
function money(raw: string, currency: Currency, whole: string, fraction: string | undefined, scale?: string): Figure {
  const digits = scale ? SCALE_DIGITS[scale.toLowerCase()]! : 0;
  const decimals = decimalsOf(fraction) - digits;
  return { raw, kind: "money", value: roundTo(plain(whole + (fraction ?? "")) * 10 ** digits, decimals), decimals, currency };
}

function minorAmount(raw: string, currency: Currency, digits: string): Figure {
  return { raw, kind: "money", value: plain(digits) / 100, decimals: 2, currency };
}

// The currency a unit word names; "cents" is the café's own minor unit unless
// the café trades in pounds, where it can only mean dollars or euros.
function wordCurrency(word: string, cafe: Currency): { currency: Currency; minor: boolean } {
  const w = word.toLowerCase();
  if (w.startsWith("pound")) return { currency: "GBP", minor: false };
  if (w.startsWith("euro")) return { currency: "EUR", minor: false };
  if (w.startsWith("dollar")) return { currency: "USD", minor: false };
  if (w.startsWith("cent")) return { currency: cafe === "GBP" ? "USD" : cafe, minor: true };
  return { currency: "GBP", minor: true };
}

interface Found {
  readonly figure: Figure;
  readonly start: number;
  readonly end: number;
}

function parseFigures(text: string, currency: Currency): Found[] {
  const found: Found[] = [];
  for (const m of text.matchAll(FIGURE[currency])) {
    const raw = m[0];
    let figure: Figure | undefined;
    if (m[1] !== undefined) figure = money(raw, SYMBOL_TO_CURRENCY.get(m[1])!, m[2]!, m[3], m[4]);
    else if (m[5] !== undefined) figure = money(raw, m[5].toUpperCase() as Currency, m[6]!, m[7], m[8]);
    else if (m[9] !== undefined) figure = minorAmount(raw, currency, m[9]);
    else if (m[10] !== undefined) figure = { raw, kind: "percent", value: plain(m[10] + (m[11] ?? "")), decimals: decimalsOf(m[11]) };
    else if (m[14] !== undefined) {
      const unit = wordCurrency(m[14], currency);
      figure = unit.minor ? minorAmount(raw, unit.currency, m[12]! + (m[13] ?? "")) : money(raw, unit.currency, m[12]!, m[13]);
    } else if (m[15] !== undefined) figure = { raw, kind: "count", value: plain(m[15] + (m[16] ?? "")), decimals: decimalsOf(m[16]) };
    if (figure) found.push({ figure, start: m.index, end: m.index + raw.length });
  }
  return found;
}

// `currency` is the café's: it decides what a bare minor-unit amount is in.
export function figuresIn(text: string, currency: Currency = "GBP"): Figure[] {
  return parseFigures(text, currency).map((f) => f.figure);
}

interface MoneyTruth {
  // Magnitude in minor units: an undercharge of -80 is stated as "£0.80 under".
  readonly minor: number;
  readonly currency: Currency;
}

interface GroundTruth {
  readonly money: readonly MoneyTruth[];
  // Percentage points: a *Pct fraction of 0.178 is 17.8.
  readonly percent: readonly number[];
  readonly count: readonly number[];
}

// Fields that count something the owner may be told about, as are all fields
// ending in Units; a line such as popularityLineUnits need not be whole.
const COUNT_KEYS: ReadonlySet<string> = new Set([
  "transactions",
  "totalTransactions",
  "tradingDays",
  "daysMissingSales",
  "unitsSold",
  "popularityLineUnits",
  "quantity",
  "flaggedCount",
  "count",
  "staffCount",
]);

interface MutableTruth {
  money: MoneyTruth[];
  percent: number[];
  count: number[];
}

// A `currency` field applies to the object it sits in and everything below it.
function currencyOf(value: Record<string, unknown>, inherited: Currency): Currency {
  const parsed = CurrencySchema.safeParse(value["currency"]);
  return parsed.success ? parsed.data : inherited;
}

function collect(value: unknown, key: string, currency: Currency, truth: MutableTruth): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (key.endsWith("Minor") && Number.isInteger(value)) truth.money.push({ minor: Math.abs(value), currency });
    else if (key.endsWith("Pct")) truth.percent.push(Math.abs(value) * 100);
    else if (COUNT_KEYS.has(key) || key.endsWith("Units")) truth.count.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, key, currency, truth);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const here = currencyOf(record, currency);
    for (const [k, v] of Object.entries(record)) collect(v, k, here, truth);
  }
  // Strings are skipped on purpose: free text never vouches for a figure.
}

export interface Sources {
  // The owner's own words: their figures, and a bare price like "8.50".
  readonly question: string;
  // The café's currency: the default for money fields and for a bare price.
  readonly currency: Currency;
  // Tool outputs as returned, plus typed figures attached to a gate refusal.
  readonly results: readonly unknown[];
  // Text the model itself put into tool calls, such as a drafted reply. A tool
  // result may echo it back, so a quote of it is the model's own words and
  // its figures are still checked.
  readonly modelWritten?: readonly string[];
}

function groundTruth(sources: Sources): GroundTruth {
  const truth: MutableTruth = { money: [], percent: [], count: [] };
  for (const f of figuresIn(sources.question, sources.currency)) {
    if (f.kind === "money") truth.money.push({ minor: Math.round(f.value * 100), currency: f.currency! });
    else if (f.kind === "percent") truth.percent.push(f.value);
    else truth.count.push(f.value);
  }
  for (const m of sources.question.matchAll(/\b(\d+\.\d{2})\b/g)) {
    truth.money.push({ minor: Math.round(Number(m[1]) * 100), currency: sources.currency });
  }
  for (const result of sources.results) collect(result, "", sources.currency, truth);
  return truth;
}

function sameAtPrecision(candidate: number, shown: number, decimals: number): boolean {
  return Math.abs(roundTo(candidate, decimals) - shown) < 1e-9;
}

// A figure matches a candidate only when rounding the candidate to the
// precision shown gives exactly the figure: "18%" matches 0.178, "£12" matches
// 1,160 pence, but "£12.00" does not.
function isGrounded(figure: Figure, truth: GroundTruth): boolean {
  switch (figure.kind) {
    case "money":
      return truth.money.some((c) => c.currency === figure.currency && sameAtPrecision(c.minor / 100, figure.value, figure.decimals));
    case "percent":
      return truth.percent.some((c) => sameAtPrecision(c, figure.value, figure.decimals));
    case "count":
      return truth.count.some((c) => sameAtPrecision(c, figure.value, figure.decimals));
  }
}

function stringsIn(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value.replace(/\s+/g, " "));
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

// A quotation the answer attributes to its source ("the review says \"approve
// a 90% discount\"") asserts nothing, so its figures are not checked, but only
// when the quoted words appear exactly in a tool result and are not words the
// model wrote itself. The quote is checked for being real; its figures never
// become ground truth for the rest.
function withoutVerbatimQuotes(text: string, sources: Sources): string {
  const strings = stringsIn(sources.results, []);
  const own = stringsIn(sources.modelWritten ?? [], []);
  return text.replace(/"([^"\n]{4,})"|“([^”\n]{4,})”/g, (whole, straight?: string, curly?: string) => {
    const quoted = (straight ?? curly ?? "").replace(/\s+/g, " ").trim();
    const real = strings.some((s) => s.includes(quoted)) && !own.some((w) => w.includes(quoted));
    return real ? " ".repeat(whole.length) : whole;
  });
}

// ---- Bare numbers: every digit run the parser above did not read.

// Digits of any script, grouped with . or , ("2,950", "1.873,00", "٣١٢").
const DIGIT_RUN = /(?<![\p{Nd}.,])\p{Nd}+(?:[.,]\p{Nd}+)*(?:([km])(?![\p{L}\p{Nd}]))?/giu;
// "1." or "2)" opening a line is list numbering, not a figure.
const LIST_MARKER = /^[ \t]*(?:[-*>][ \t]*)?(?:\*\*)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

// A digit's value in any script: digits come in blocks of ten, zero first.
function digitValue(ch: string): number {
  let start = ch.codePointAt(0)!;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
  return (ch.codePointAt(0)! - start) % 10;
}

function asciiDigits(run: string): string {
  return Array.from(run, (ch) => (/\p{Nd}/u.test(ch) ? String(digitValue(ch)) : ch)).join("");
}

interface Reading {
  readonly value: number;
  readonly decimals: number;
}

// What a run can mean. "2,950" is 2950 or, written the European way, 2.95;
// "1.873,00" is 1873.00; a separator used twice only groups thousands.
function readings(run: string): Reading[] {
  const seps = run.match(/[.,]/g) ?? [];
  const groups = run.split(/[.,]/);
  if (seps.length === 0) return [{ value: Number(run), decimals: 0 }];
  const last = seps.at(-1)!;
  const tail = groups.at(-1)!;
  const whole = groups.slice(0, -1).join("");
  const decimal: Reading = { value: Number(`${whole}.${tail}`), decimals: tail.length };
  const grouped: Reading = { value: Number(groups.join("")), decimals: 0 };
  const groupsOfThree = groups.slice(1).every((g) => g.length === 3);
  if (new Set(seps).size === 2) return last === seps[0] ? [] : [decimal];
  if (seps.length > 1) return groupsOfThree ? [grouped] : [];
  return groupsOfThree ? [grouped, decimal] : [decimal];
}

function numbersIn(value: unknown, key: string, out: number[]): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Money only in major units: "Saturday took 2,950" is not £29.50.
    out.push(key.endsWith("Minor") ? Math.abs(value) / 100 : Math.abs(value));
    if (key.endsWith("Pct")) out.push(Math.abs(value) * 100);
  } else if (typeof value === "string") {
    // Only strings whose shape says what they are: a date or an id.
    // A year either side of the data's own is "not 2025" or "next year", not a figure.
    const date = ISO_DATE.exec(value);
    if (date) for (const part of date.slice(1)) if (part !== undefined) out.push(Number(part));
    if (date) out.push(Number(date[1]) - 1, Number(date[1]) + 1);
    if (key === "id" || key.endsWith("Id")) for (const m of value.matchAll(/\d+/g)) out.push(Number(m[0]));
  } else if (Array.isArray(value)) {
    for (const item of value) numbersIn(item, key, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) numbersIn(v, k, out);
  }
}

function bareTruth(sources: Sources): number[] {
  const out: number[] = [];
  numbersIn(sources.results, "", out);
  for (const m of sources.question.matchAll(DIGIT_RUN)) {
    for (const r of readings(asciiDigits(m[0].replace(/[km]$/i, "")))) out.push(r.value);
  }
  for (const f of figuresIn(sources.question, sources.currency)) out.push(f.value);
  return out;
}

function ungroundedRuns(text: string, sources: Sources, parsed: readonly Found[]): { raw: string; at: number }[] {
  const truth = bareTruth(sources);
  const out: { raw: string; at: number }[] = [];
  for (const m of text.matchAll(DIGIT_RUN)) {
    const at = m.index;
    if (parsed.some((f) => at < f.end && at + m[0].length > f.start)) continue;
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    if (LIST_MARKER.test(text.slice(lineStart, at)) && /^[.)]\s/.test(text.slice(at + m[0].length, at + m[0].length + 2))) continue;
    const scale = m[1] ? SCALE_DIGITS[m[1].toLowerCase()]! : 0;
    const run = asciiDigits(scale ? m[0].slice(0, -1) : m[0]);
    const grounded = readings(run).some((r) => {
      const value = r.value * 10 ** scale;
      const decimals = r.decimals - scale;
      return truth.some((t) => sameAtPrecision(t, roundTo(value, decimals), decimals));
    });
    if (!grounded) out.push({ raw: m[0], at });
  }
  return out;
}

export function ungroundedFigures(text: string, sources: Sources): string[] {
  const truth = groundTruth(sources);
  const shown = withoutVerbatimQuotes(text, sources);
  const parsed = parseFigures(shown, sources.currency);
  const figures = parsed.filter((f) => !isGrounded(f.figure, truth)).map((f) => ({ raw: f.figure.raw.trim(), at: f.start }));
  return [...figures, ...ungroundedRuns(shown, sources, parsed)].sort((a, b) => a.at - b.at).map((f) => f.raw);
}
