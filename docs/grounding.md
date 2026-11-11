# Grounding

Every figure in an answer must trace to a tool result or to the owner's own
words. The check runs in code on every answer (`lib/agent/grounding.ts`, called
from `lib/agent/agent.ts`), after the model has finished and before the owner
sees anything.

## Sources

A figure may match one of three sources:

1. Typed numeric fields in the tool results returned for this question. `*Minor`
   fields are money in minor units, `*Pct` fields are fractions shown as
   percentages, and counts are every field ending in `Units` plus a fixed list
   (`transactions`, `totalTransactions`, `tradingDays`, `daysMissingSales`,
   `unitsSold`, `quantity`, `flaggedCount`, `count`, `staffCount`).
2. The fixed policy figures in `lib/agent/policy-figures.ts`: the price-change
   limit, the invoice flag threshold, the menu's margin tolerance, the autopilot
   unlock count and the star ratings autopilot may and may not cover. The system
   prompt states them from the same constants, so the prompt and the check
   cannot disagree with the code that enforces them.
3. The owner's question, including a bare price such as "8.50".

Strings in a tool result are never read for figures. Review text, a manager's
day note, an invoice line's name and a proposal summary are text someone else
wrote, so none of them can vouch for a number.

When the gate refuses a proposal, the refusal carries the item's real price,
food cost and change limit (or the prices of the proposal already open for that
item) as typed figures, so the model may repeat those. The price the model asked
for is its own input and is not among them.

## What is parsed

- Money: `£`, `€` or `$` amounts, currency codes (`GBP 12`), a bare minor-unit
  amount in the café's currency (`320p`), and amounts with a unit word ("320
  pence", "3.20 pounds"). "£1.2k" is read as £1,200 to the nearest hundred.
- Percentages: "17.8%" and "17.8 per cent".
- Counts: a number followed by "orders", "transactions", "units", "sold" or
  "trading days".

Money carries its currency. A money field counts in the currency of the nearest
`currency` field above it in the result, or the café's currency, and an amount
in any other currency does not match.

A figure matches only if rounding the source value to the precision shown gives
exactly that figure: "18%" matches 0.178 and "£12" matches 1,160 pence, but
"£12.00" does not.

## Bare digits

Every other run of digits is checked too, in any script and grouped with `.` or
`,`, so "takings were 2,950" or "312 customers" cannot pass for want of a
currency sign or unit word. Such a run must equal one of:

- any numeric field a tool returned (a `*Minor` field in major units only, so
  2,950 pence never vouches for "2,950"; a `*Pct` field also as a percentage);
- a part of a date or an id a tool returned, or the year either side of the
  data's own year;
- a number in the owner's question.

"2,950" may be read either way, as 2950 or as 2.95. List numbering at the start
of a line is skipped. This floor is looser than the figure check, since small
numbers nearly always match something. A unit test runs every good live fixture
through it against the tools' real output and expects no flags.

## Quotes

A quotation that appears word for word in a tool result, such as a customer's
sentence from a review, is not checked, since it reports what someone wrote. Its
figures never become ground truth for the rest of the answer. A quotation of the
model's own words, such as a drafted reply echoed back by the propose tool, is
checked like the rest of the answer.

## Correction

An unmatched figure gets the model one correction. The draft is removed from the
conversation and replaced by a system note, never shown to the owner, that
quotes the draft and names the unmatched figures, so the model writes the whole
answer again. The rewrite is checked in full. If a figure is still unmatched,
the answer is shown with a visible warning naming it, and both evals fail the
run.

## Status lines

The lines under every answer are rendered from the action store, one per
proposal created in this answer, one per propose call the gate refused ("Not
proposed:" and the gate's reason), or "No change was proposed." They are
appended to the answer text and shown separately in the UI.

The evals also record a cheap English wording check (`lib/agent/claims.ts`, used
by `lib/eval/claim-metric.ts`) that counts answers saying a proposal was made
when none was. It is a metric only and never fails a run; the judge's no-claim
criterion, which sees the status lines, decides.

## What it does not catch

- A real figure attached to the wrong thing passes: quoting the tomato
  overcharge as the delivery surcharge would match.
- With every tool's output available, a wrong figure can match an unrelated
  one, and a small bare number usually matches something.
- Figures written in words, such as "twelve hundred" or "a third", are not
  checked.
- `propose_price_change` echoes the proposed price and the change, so a price
  the model chose is grounded once proposed. The prompt tells the model to ask
  the owner for an exact price, and the gate's limits and the owner's approval
  still apply.
