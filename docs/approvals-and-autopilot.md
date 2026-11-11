# Approvals and autopilot

## The gate

`lib/safety/` enforces propose, then approve, then execute, in the execution
path.

- The agent can only produce a `ProposedAction`, through a propose-only port.
  The full gate stays on the server side, in `lib/web/server.ts`.
- `execute()` accepts only an `ApprovedAction`, branded with a module-private
  symbol only the gate can mint, so passing a proposal to `execute()` is a type
  error. The brand guards against mistakes; the runtime check is the grant
  token. Each approval stores a random token, and `execute()` compares it with
  the stored one in constant time and re-checks the stored status.
- Execution is idempotent: a second call with the same grant returns the stored
  result. It reads the spec from the store, never from the object passed in.
- The spec is cloned and frozen when proposed, so what the owner approves is
  what runs.
- The audit entry is written before the store changes, so if the log refuses an
  entry the action stays pending. The log is append-only.
- `reject()` turns down a pending action or withdraws an approved one that never
  ran. Nothing can be undone once executed.

Approver names may not be the audit log's own actor names (`agent`, `system`,
`autopilot`). Names are compared on their letters alone, lower-cased, so
"Auto-pilot" and "a.g.e.n.t" are refused too. A name with control or zero-width
characters, a name NFKC would change, or a name with anything other than
Latin-script letters, spaces, apostrophes, hyphens and dots is refused, so a
Cyrillic lookalike cannot pass (`lib/safety/actors.ts`).

## The policy

`ApprovalPolicy` (`lib/safety/policy.ts`) checks every proposal before it is
stored. It reads the live menu and reviews through a narrow `ActionCatalog`
interface and past proposals through a read-only `ProposalHistory`. A refusal
is a `PolicyRejection` with a rule id and leaves no record.

| Rule id | Refused when |
| --- | --- |
| `unknown_sku` | the item is not on the menu |
| `wrong_currency` | the price is not in the café's currency |
| `invalid_price` | the price is not a positive whole number of minor units |
| `stale_price` | the "from" price is not what the till charges now |
| `no_change` | the new price equals the current one |
| `below_food_cost` | the new price is at or below the item's food cost |
| `max_change` | the price moves by more than 50% |
| `unknown_review` | the review does not exist |
| `empty_reply` | the reply is blank |
| `reply_too_long` | the reply is over 2,000 characters |
| `already_replied` | the review already has an approved or posted reply |
| `already_open` | the item or review already has an open proposal |

Proposal summaries use the owner's names for things, read from the same
catalog: "Change Ham & Cheese Toastie price from £6.50 to £7.15", "Reply to
Megan's review".

The prompt, the tools and the policy all state the same limits, but only the
policy enforces them, so a script holding the gate directly cannot propose a 1p
price any more than the model can.

## Review-reply autopilot

Review tools that auto-reply usually gate it on structured fields such as the
star rating, and send anything negative to a person. Counter does the same and
adds one rule: the text that goes out is always text the owner wrote.

### Templates

The owner writes one short reply template per star rating, for example "Thank
you so much, {name}! We're glad you enjoyed your visit." `{name}` is filled with
the reviewer's first name when it has the shape of a plain first name. A
template is checked when it is saved and refused if it contains figures, links,
contact details or promises such as a refund, a discount or something free.

### Unlock and settings

Autopilot unlocks once the owner has approved replies by hand to five different
reviews. The count is read from the store each time: replies a human approved
and that were posted, one per review, so approving five replies to the same
review does not count as five. After unlocking, the owner may switch autopilot
on for 3, 4 or 5 star reviews. Ratings 1 and 2 are refused as settings and
again at decision time. Price changes are never eligible. Only the owner's side
of the server can change the settings; the agent has no tool for it.

### The decision

When a review arrives, `decideAutopilot` (`lib/safety/autopilot-decision.ts`)
returns `post` or `owner` with a reason. It is a pure function of recorded
facts: the settings, the review's star rating and whether it has text, whether
a template is saved for that rating, and the classifier's outcome. It reads no
review text, holds no word list and calls no model, so the evals can recompute
it from an audit entry. Anything missing, malformed or unexpected returns
`owner`.

A rating with no text never reaches a model. A review with text is posted only
if the classifier clears it.

### The classifier

`lib/agent/review-classifier.ts` makes one call to `claude-haiku-5-5` with
structured output. The answer must be exactly `{ delicate, reasons, language }`,
with reasons from a fixed enum: `illness_or_allergy`, `hygiene`,
`staff_conduct`, `refund_or_money`, `legal_or_safety`, `stars_text_mismatch`,
`sarcasm` and `other`. A short complaint inside praise counts as delicate.

The review is untrusted. It goes in as JSON inside a `<review_data>` block with
`<` escaped, the call has no tools, and only the validated enum is acted on.
A refusal, running out of tokens, JSON that does not parse, a label outside the
enum, a timeout (15 seconds), an API error or a missing key all produce an
error outcome, and the review goes to the owner.

Reviews are classified ahead of time, when the server starts, so the decision
never waits on the network. A review that has not been classified yet, or whose
text or rating changed since, goes to the owner.

A short frozen tripwire list (illness, allergy, injury, refunds, legal trouble;
`lib/safety/autopilot-checks.ts`) runs next to the classifier. It can only send
a review to the owner, never clear one.

Without an API key the demo uses a table of hand-labelled verdicts for its
seven mock reviews, keyed by review id and a hash of the text. Any other review,
or one of these with changed text, goes to the owner.

### What the owner sees

A review autopilot holds while it is switched on is recorded with the facts it
was decided from, and the approvals card shows the reason ("The review reads as
delicate (hygiene).", "Autopilot is not on for 3 star reviews."). A post records
the same facts, including the classifier's model and a hash of its prompt and
settings. If a post fails to send, the reply waits for the owner, who can send
or withdraw it; a retry is recorded as the owner's own approval.

Replies the agent drafts in a conversation are never posted by autopilot. They
go to the owner's approval queue like any other proposal.
