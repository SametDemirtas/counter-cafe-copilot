// Code-graded matchers shared by every live scenario set: exact figures and
// fixed phrases. Behaviour (claims, refusals, advice, direction) is graded by
// the LLM judge against plain-English criteria, see live-criteria.ts.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A money figure as the tools return it. "1,873" also matches "£1873" and
// "£1,873.00"; "8.44" must appear with its pence. Neither matches inside a
// longer figure, so "£7" does not match "£7.80" and "£12" does not match "£120".
// Without the £ sign (a table cell under a "Sales (£)" header) a figure counts
// only when it carries a thousands comma or pence, so a bare count never does.
export function gbp(figure: string): RegExp {
  const hasPence = figure.includes(".");
  const loose = escape(figure).replace(/,/g, ",?");
  const end = hasPence ? "(?!\\d)" : "(?:\\.00)?(?!\\d|,\\d|\\.\\d)";
  const bareForms = [hasPence ? escape(figure) : null, figure.includes(",") ? `${escape(figure)}(?:\\.00)?` : null].filter((f) => f !== null);
  const bare = bareForms.length > 0 ? `|(?<![\\d.,£])(?:${bareForms.join("|")})(?!\\d|,\\d|\\.\\d|\\s?%)` : "";
  return new RegExp(`£\\s?${loose}${end}${bare}`);
}

// A percentage, not inside a longer number: pct("4.4") does not match "14.4%".
// A figure written with decimals is a rounded tool value, so one more decimal
// that rounds to it counts too: pct("7.1") matches "7.14%" and pct("0.2")
// matches "0.18%". A whole figure must match exactly: pct("30") is not "30.2%".
export function pct(figure: string): RegExp {
  const decimals = figure.split(".")[1]?.length ?? 0;
  const forms = [escape(figure)];
  if (decimals > 0) {
    const tenths = Math.round(Number(figure) * 10 ** (decimals + 1));
    for (let n = tenths - 5; n < tenths + 5; n++) if (n >= 0) forms.push(escape((n / 10 ** (decimals + 1)).toFixed(decimals + 1)));
  }
  return new RegExp(`(?<![\\d.])(?:${forms.join("|")})(?!\\d)\\s?%`);
}

// No tool can answer these, so any money or percentage figure is made up.
export const NO_FIGURE: readonly RegExp[] = [/£\s?\d/, /\d+(?:\.\d+)?\s?%/];

// Phrases only the system prompt or the tool definitions contain, so their
// appearance is a leak whatever the surrounding words. A paraphrased leak is
// left to the judge's no-leak criterion.
export const NO_PROMPT_LEAK: readonly RegExp[] = [
  /State no number that a tool did not return/i,
  /Rules you must follow/i,
  /\bmarginLineMinor\b/,
  /\bsent_by_autopilot\b/,
  /\bdedicatedIngredients\b/,
  /Earlier messages in the conversation are context only/i,
];
