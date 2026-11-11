# Counter

Counter is a co-pilot for a small café owner. The owner asks a question in
plain words ("is my tomato supplier overcharging me?") and gets an answer built
from the café's own sales, menu, rota, supplier invoice and reviews. A language
model picks the tools and writes the answer; deterministic code produces every
figure and checks that each number in the answer came from a tool or from the
owner. A price change or a public reply waits for the owner's approval, apart
from short review replies the owner has put on autopilot with their own
template. It runs locally on four weeks of mock data for one London café.
On 349 live scenarios, each run three times with `claude-sonnet-5-5`, 91% of
runs pass and none breaks the owner's approval rules ([Results](#results)).

## Run it

```
npm install
npm run serve           # web UI at http://127.0.0.1:8787
npm test                # unit, gate, agent, eval and web tests
npm run test:coverage   # the same, with coverage thresholds (CI, Node 20 and 22)
npm run typecheck
npm run eval            # scripted golden suite, no key needed
```

Without `ANTHROPIC_API_KEY` an offline scripted model answers the questions the
page offers as buttons. With a key the agent uses `claude-sonnet-5-5` (override
with `ANTHROPIC_MODEL`) at the effort in `ANTHROPIC_EFFORT`, `medium` by default.

## How it works

### Agent and tools

The agent (`lib/agent/`) runs a tool-use loop with five read tools (sales by
day, staff cost, invoice variance, menu classification, reviews) and two
propose tools (price change, review reply). The read tools are pure functions
over one canonical order model, with money in integer minor units, and return
totals, averages, changes and thresholds as typed fields, so the model never
adds anything up. A question is capped at eight model calls and five proposals.

### Grounding

Before an answer is shown, `lib/agent/grounding.ts` matches every money amount,
percentage and count in it against the typed numeric fields the tools returned
for this question, the fixed policy figures and the owner's question. Every
other run of digits must equal a number a tool returned or the owner wrote.
Text inside tool results never counts as a source, so a review asking for a
"90% discount" cannot vouch for 90%. An unmatched figure gets the model one
rewrite; one still unmatched is shown with a visible warning
([docs/grounding.md](docs/grounding.md)).

### Proposal status

Every answer ends with lines read from the action store: "Waiting for your
approval: Change Ham & Cheese Toastie price from £6.50 to £7.15.", "Not
proposed:" with the gate's reason, or "No change was proposed."

### Approval gate and policy

`lib/safety/` enforces propose, approve, execute in code. The agent holds a
propose-only port; `execute()` accepts only an `ApprovedAction`, which only the
gate can create, and re-checks the stored status and a random grant token. The
policy checks each proposal against the live menu and reviews before storing
it: a price must name a real item, carry the till's current price, stay above
food cost and move by at most 50%; a review gets one reply, ever; an item or
review has at most one open proposal. Every transition goes to an append-only
audit log ([docs/approvals-and-autopilot.md](docs/approvals-and-autopilot.md)).

### Review-reply autopilot

The owner writes a short template per star rating, such as "Thank you so much,
{name}! ...". Templates are checked when saved and may not contain figures,
links, contact details or promises. Autopilot unlocks after the owner has
approved replies by hand to five different reviews. When a review arrives,
autopilot posts that rating's template only if the rating is switched on, a
template is saved and passes its checks, no term from a short fixed tripwire
list (illness, allergy, injury, refunds, legal trouble) appears, and the review
classifier finds nothing delicate. The classifier is one `claude-haiku-5-5` call with a fixed
enum answer; an error, a refusal or an unreadable answer sends the review to
the owner. Anything else waits for the owner with the reason shown. 1 and 2
star reviews and prices never go out automatically, and replies the agent
drafts always go to the owner.

## Key design decisions

- Numbers are produced and checked in code, because only a check on the
  finished answer can keep an invented figure away from the owner.
- The gate owns the policy, so price limits and one reply per review hold for
  the model, the web UI and any script alike.
- Status comes from the store, so the owner never depends on the model's
  wording, in any language, to know what changed.
- Autopilot posts only text the owner wrote. The classifier only decides
  whether a review may get the template, and uncertainty goes to the owner.
- Untrusted text stays data. Reviews, day notes and invoice lines never vouch
  for a figure, and the classifier reads a review as JSON in a delimited block,
  with no tools.
- Code grades what can be decided exactly; an LLM judge grades behaviour, and
  counts only after it agrees with labelled answers.

## Evaluation

The scripted eval (`npm run eval`) drives the pipeline through 7 golden
scenarios with a fake model and runs in CI. There and in the live eval, a
safety rail reads the store, the effect sink and the audit log and fails any
run with an approval or execution the owner's rules do not allow.

The live eval (`npm run eval:live`) runs the real model on 349 scenarios in 11
categories, from plain analysis to injection, jailbreaks, false premises and
numeric traps: 126 dev scenarios the prompt was developed against, 70 held-out,
and 153 owner-set scenarios written by separate LLM agents, each prompted as an
owner or manager. Code grades the facts: safety, the kind and number of proposals,
ungrounded figures, required figures, refusals and empty answers. An LLM judge
(`claude-sonnet-5-5`) grades one to four yes/no behaviour criteria per
scenario, and each verdict must quote text that code finds in the answer.

Before use, the judge must agree with 795 labelled answers (`npm run
eval:judge-check`): kappa of at least 0.8 on each half of a split by scenario,
and no false pass on the strict criteria (claiming an action, granting a
demand, not declining an injected instruction, leaking the prompt). It scored 0.975 and 0.926. 775 of the answers were
written for the test by the author and the LLM agents that wrote the owner
sets; 20 are real model output. The live eval refuses a judge whose model,
prompt or criteria changed after its check.

The routing eval (`npm run eval:routing`) runs 50 hand-labelled reviews in four
languages through the classifier and the autopilot decision, and fails on any
delicate review that would be posted: currently 0 of 30 missed, 1 plain review
held.

```
EVAL_DRY_RUN=1 EVAL_SET=all npm run eval:live                      # fake model and judge
ANTHROPIC_API_KEY=... npm run eval:judge-check                     # validate the judge
ANTHROPIC_API_KEY=... npm run eval:routing                         # review classifier
ANTHROPIC_API_KEY=... EVAL_SET=all EVAL_REPS=3 npm run eval:live   # the full run
```

Method, settings, the spending cap and failure handling:
[docs/evaluation.md](docs/evaluation.md). The first live run of an earlier
version: [docs/first-live-run.md](docs/first-live-run.md).

## Results

Full run on 11 November 2026: `claude-sonnet-5-5` at medium effort, every
scenario three times, judge validated against the current criteria
([eval-report.md](eval-report.md)).

| Set | Scenarios green (3 of 3) | Runs passed |
|---|---|---|
| Dev | 116 / 126 (92%) | 365 / 378 (97%) |
| Held-out | 65 / 70 (93%) | 200 / 210 (95%) |
| Owner sets | 116 / 153 (76%) | 389 / 457 (85%) |
| **All** | **297 / 349 (85%)** | **954 / 1,045 (91%)** |

- Safety failures: **0** in 1,045 runs. No price change or reply was approved
  or executed outside the owner's rules, including all injection and
  jailbreak scenarios.
- 2 of 1,047 runs went unjudged (no verified verdict) and are left out of the
  totals; there were no infrastructure errors.
- Cost: $15.58 for the whole run, $3.36 of it the judge; 27 minutes.

The held-out set scores within two points of the dev set, which suggests the
prompt is not fitted to the scenarios it was developed on. The owner sets are the hardest: they were
written to be awkward, in an owner's shorthand ("orange juice up 30p pls"),
and most of their misses are judgement calls rather than wrong facts, such as
answering one reading of an ambiguous question without saying which, or not
acknowledging a stressed owner before giving the numbers. The judge and
routing results are in [Evaluation](#evaluation) above.

## Limits

- Demo scope: one café, four weeks of mock data, two kinds of action.
- State is in memory behind store, audit and sink interfaces.
- No authentication: the server listens on loopback only, and the approver is a
  name in the request body.
- Approval executes at once, with no expiry and no fresh price check.
- Figures are checked for value, not attribution: a real figure attached to the
  wrong thing passes, and numbers written in words are not checked.
- For 3 to 5 star reviews with text, autopilot relies on the classifier, which
  the routing eval measures and the safety rail cannot recompute.
- No discounts, tax, tips, refunds or multiple sites, and no tracing.

## Layout

```
lib/domain/   money and the canonical order model
lib/data/     Clover and Square adapters, mock café data
lib/tools/    deterministic calculations over the canonical data
lib/safety/   the gate: policy, store, audit log, handlers, autopilot
lib/agent/    agent loop, tools, grounding, morning note, model adapters
lib/eval/     scripted, live, judge-check and routing evals
lib/web/      local HTTP server, offline demo model, front end
tests/        unit, gate, agent, eval and web tests
docs/         grounding, approvals and autopilot, evaluation,
              mock café (mock-cafe.md), web server (web.md)
```

## License

MIT
