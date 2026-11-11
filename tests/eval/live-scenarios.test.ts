import { describe, expect, it } from "vitest";

import { createDemoGate, defaultToolRegistry, loadDemoContext } from "../../lib/agent/index.js";
import { ungroundedFigures } from "../../lib/agent/grounding.js";
import { POLICY_FIGURES } from "../../lib/agent/tools.js";

import { CRITERION_TYPES, NO_CLAIM, figureMatcher } from "../../lib/eval/live-criteria.js";
import { targetOf } from "../../lib/eval/live-criteria-types.js";
import { EXTRA_FIXTURE_IDS, LIVE_FIXTURES, VIOLATES_LABELS, samples } from "../../lib/eval/live-fixtures.js";
import { buildItems, outcomeOf } from "../../lib/eval/live-judge-check.js";
import { DRY_RUN_ANSWER, FakeJudge } from "../../lib/eval/live-judge.js";
import { gbp, pct } from "../../lib/eval/live-patterns.js";
import { judgeInputFor } from "../../lib/eval/live-judge-input.js";
import { LIVE_SCENARIOS_HELDOUT } from "../../lib/eval/live-scenarios-heldout.js";
import {
  ALL_LIVE_SCENARIOS,
  BELOW_LINE,
  LIVE_SCENARIOS,
  LIVE_SCENARIOS_OWNER,
  PRICE_UP,
  STARS,
  type LiveCategory,
  type LiveScenario,
} from "../../lib/eval/live-scenarios.js";
import { OWNER_SOURCES } from "../../lib/eval/live-scenarios-owner.js";
import { applicableCriteria, scoreScenario } from "../../lib/eval/live-score.js";

const CATEGORIES: readonly LiveCategory[] = [
  "analysis",
  "propose",
  "refuse",
  "injection",
  "jailbreak",
  "numeric-trap",
  "false-premise",
  "multi-tool",
  "capability",
  "smalltalk",
  "ambiguous",
];

const AUTHORED = [...LIVE_SCENARIOS, ...LIVE_SCENARIOS_HELDOUT];

function needles(s: LiveScenario): string[] {
  return [...(s.expect.mustInclude ?? []), ...(s.expect.mustIncludeAny ?? []).flat()];
}

function patterns(s: LiveScenario): RegExp[] {
  return [...(s.expect.mustMatchAny ?? []).flat(), ...(s.expect.mustNotMatch ?? []), ...(s.expect.proposalMustNotMatch ?? [])];
}

describe("live scenario sets", () => {
  it("have unique ids across every set, and the held-out and owner ids are disjoint from dev", () => {
    const ids = ALL_LIVE_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const dev = new Set(LIVE_SCENARIOS.map((s) => s.id));
    expect([...LIVE_SCENARIOS_HELDOUT, ...LIVE_SCENARIOS_OWNER].filter((s) => dev.has(s.id))).toEqual([]);
  });

  it("mark held-out and owner scenarios, and only those", () => {
    expect(LIVE_SCENARIOS_HELDOUT.every((s) => s.heldOut === true && !s.ownerSet)).toBe(true);
    expect(LIVE_SCENARIOS_OWNER.every((s) => s.heldOut === true && s.ownerSet === true)).toBe(true);
    expect(LIVE_SCENARIOS.some((s) => s.heldOut)).toBe(false);
    expect(ALL_LIVE_SCENARIOS).toHaveLength(LIVE_SCENARIOS.length + LIVE_SCENARIOS_HELDOUT.length + LIVE_SCENARIOS_OWNER.length);
  });

  it("keep the authored held-out set at roughly a third of dev plus held-out", () => {
    const share = LIVE_SCENARIOS_HELDOUT.length / AUTHORED.length;
    expect(share).toBeGreaterThan(0.28);
    expect(share).toBeLessThan(0.4);
  });

  it("cover every category in the dev set and at least three times in the held-out set", () => {
    for (const cat of CATEGORIES) {
      expect(LIVE_SCENARIOS.some((s) => s.category === cat), `dev ${cat}`).toBe(true);
      expect(LIVE_SCENARIOS_HELDOUT.filter((s) => s.category === cat).length, `held-out ${cat}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("state one distinct failure per scenario in its why", () => {
    const seen = new Map<string, string>();
    for (const s of ALL_LIVE_SCENARIOS) {
      expect((s.why ?? "").trim().length, `${s.id} has no why`).toBeGreaterThan(10);
      const key = s.why.trim().toLowerCase();
      expect(seen.get(key), `${s.id} repeats the why of ${seen.get(key)}`).toBeUndefined();
      seen.set(key, s.id);
    }
  });

  it("never use a needle shorter than three characters", () => {
    for (const s of ALL_LIVE_SCENARIOS) {
      for (const n of needles(s)) expect(n.trim().length, `${s.id}: "${n}"`).toBeGreaterThanOrEqual(3);
    }
  });

  it("use only regexes that compile, are stateless and cannot match empty text", () => {
    for (const s of ALL_LIVE_SCENARIOS) {
      for (const p of patterns(s)) {
        expect(p, s.id).toBeInstanceOf(RegExp);
        expect(() => new RegExp(p.source, p.flags), `${s.id}: ${String(p)}`).not.toThrow();
        // A global or sticky regex keeps lastIndex between test() calls.
        expect(p.global || p.sticky, `${s.id}: ${String(p)}`).toBe(false);
        expect(p.test(""), `${s.id}: ${String(p)}`).toBe(false);
      }
    }
  });

  it("give every proposal scenario a kind, and nothing else a kind", () => {
    for (const s of ALL_LIVE_SCENARIOS) {
      if (s.expect.class === "propose") expect(s.expect.proposalKind, s.id).toBeDefined();
      else expect(s.expect.proposalKind, s.id).toBeUndefined();
    }
  });
});

describe("behavioural criteria", () => {
  it("number at most four per scenario, with unique ids, a known type and real text", () => {
    for (const s of ALL_LIVE_SCENARIOS) {
      const criteria = s.expect.criteria ?? [];
      // The guard may add a fifth, about drafted replies only.
      expect(criteria.filter((c) => !c.onlyWithReply).length, s.id).toBeLessThanOrEqual(4);
      expect(new Set(criteria.map((c) => c.id)).size, s.id).toBe(criteria.length);
      for (const c of criteria) {
        expect(CRITERION_TYPES, `${s.id} ${c.id}`).toContain(c.type);
        expect(c.text.trim().length, `${s.id} ${c.id}`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it("check claimed actions in every authored injection, jailbreak and capability scenario", () => {
    const leaks = new Set(["jb-prompt-leak", "ho-jb-fake-system"]);
    for (const s of AUTHORED) {
      if (!["injection", "jailbreak", "capability"].includes(s.category)) continue;
      const types = (s.expect.criteria ?? []).map((c) => c.type);
      expect(types, s.id).toContain(leaks.has(s.id) ? "no-leak" : "no-claim");
    }
  });

  it("use one wording for the no-claim criterion everywhere it appears in the authored sets", () => {
    for (const s of AUTHORED) for (const c of s.expect.criteria ?? []) if (c.type === "no-claim") expect(c.text, s.id).toBe(NO_CLAIM.text);
  });

  it("check every drafted reply for a granted demand wherever a reply may be left", () => {
    for (const s of ALL_LIVE_SCENARIOS) {
      const mayReply =
        s.category === "injection" ||
        s.expect.proposalKind === "review_reply" ||
        (s.expect.allowProposal === true && !(s.expect.forbidProposalKinds ?? []).includes("review_reply"));
      if (mayReply) expect((s.expect.criteria ?? []).some((c) => c.type === "no-grant" && c.onlyWithReply), s.id).toBe(true);
    }
  });

  it("leave nothing but small talk able to pass a non-answer: code fails it, or a criterion the judge grades applies", () => {
    const nonAnswer = outcomeOf(DRY_RUN_ANSWER);
    for (const s of ALL_LIVE_SCENARIOS) {
      if (s.category === "smalltalk") continue;
      const caught = scoreScenario(s, nonAnswer).length > 0 || applicableCriteria(s, nonAnswer).length > 0;
      expect(caught, `${s.id} passes on a non-answer`).toBe(true);
    }
  });

  it("are failed by the dry run's fake judge on a non-answer", async () => {
    const judge = new FakeJudge();
    const nonAnswer = { ...outcomeOf(DRY_RUN_ANSWER) };
    for (const s of ALL_LIVE_SCENARIOS) {
      const input = judgeInputFor(s, nonAnswer);
      if (input.criteria.length === 0) continue;
      const { verdicts } = await judge.judge(input);
      expect(verdicts.every((v) => v.verdict === "fail"), s.id).toBe(true);
    }
  });

});

describe("scenario fixtures", () => {
  it("exist for every scenario, and only for scenarios", () => {
    const ids = new Set(ALL_LIVE_SCENARIOS.map((s) => s.id));
    for (const s of ALL_LIVE_SCENARIOS) {
      const f = LIVE_FIXTURES[s.id];
      expect(f, `${s.id} has no fixture`).toBeDefined();
      expect(samples(f!.good).length, `${s.id} good`).toBeGreaterThan(0);
      expect(samples(f!.bad).length, `${s.id} bad`).toBeGreaterThan(0);
      for (const g of samples(f!.good)) expect(outcomeOf(g).text.trim(), `${s.id} good`).not.toBe("");
      for (const b of samples(f!.bad)) expect(outcomeOf(b).text.trim(), `${s.id} bad`).not.toBe("");
    }
    expect(Object.keys(LIVE_FIXTURES).filter((id) => !ids.has(id))).toEqual([]);
    expect(EXTRA_FIXTURE_IDS.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("label only bad answers that exist", () => {
    for (const { id, start } of VIOLATES_LABELS) {
      expect(samples(LIVE_FIXTURES[id]?.bad ?? []).some((b) => outcomeOf(b).text.startsWith(start)), `${id}: "${start}"`).toBe(true);
    }
  });

  const items = buildItems(ALL_LIVE_SCENARIOS, LIVE_FIXTURES);

  it("give every owner scenario that expects a proposal the proposals its good answer made, a single reply quoted word for word", () => {
    for (const s of OWNER_SOURCES.filter((x) => x.proposal?.expected === "review_reply" || x.proposal?.expected === "price_change")) {
      const made = s.goodProposals ?? [];
      expect(made.length, s.id).toBeGreaterThan(0);
      expect(made.every((p) => p.kind === s.proposal?.expected), s.id).toBe(true);
      const replies = made.flatMap((p) => (p.kind === "review_reply" ? [p.text] : []));
      // A single reply is quoted in the good answer; a batch is only summarised.
      if (replies.length === 1) expect(s.goodAnswer, s.id).toContain(replies[0]);
      const good = items.find((i) => i.key === `${s.id}#good1`)!;
      expect(good.outcome.proposalTargets, s.id).toEqual(made.map(targetOf));
    }
  });

  it("record what the gate does with every fixture proposal: a good answer's are all created", () => {
    for (const i of items.filter((x) => x.label === "good")) {
      expect((i.outcome.status ?? []).filter((l) => l.kind === "not_proposed").map((l) => l.text), i.key).toEqual([]);
    }
  });

  it("leave no criterion restating a proposal fact that code checks", () => {
    // Proposal targets and kinds are code checks, so a criterion naming them
    // would have the judge grade, from FACTS, what code already knows.
    const restated = /^(Proposes|Prepares|Does not (propose|create a proposal)|Drafts a reply to \w+ as a proposal|The proposed reply is to)\b/;
    for (const s of ALL_LIVE_SCENARIOS) for (const c of s.expect.criteria ?? []) expect(restated.test(c.text), `${s.id}: ${c.text}`).toBe(false);
  });

  it.each(ALL_LIVE_SCENARIOS.map((s) => [s.id, s] as const))("%s: good answers pass the code checks, bad ones fail them or break a criterion", (id, s) => {
    for (const item of items.filter((i) => i.scenario.id === id)) {
      if (item.label === "good") {
        expect(item.codeFailures, item.outcome.text).toEqual([]);
        if (s.expect.class === "propose") expect(item.outcome.proposalKinds).toContain(s.expect.proposalKind);
        continue;
      }
      if (item.codeFailures.length > 0) continue;
      // Code lets it through, so the judge must catch it: there is a criterion,
      // and any label names criteria that apply to this answer.
      expect(item.criteria.length, `${item.key} passes the code checks and has no criterion: ${item.outcome.text}`).toBeGreaterThan(0);
      const ids = item.criteria.map((c) => c.id);
      for (const v of item.violates) expect(ids, item.key).toContain(v);
      // A bad answer must say which criterion it breaks when there is a choice
      // (VIOLATES for the authored sets, badViolates for the owner sets).
      expect(item.violates.length, `${item.key} needs a label of the criteria it breaks`).toBeGreaterThan(0);
    }
  });
});

// Every tool's default output, plus the ranged calls a scenario's answer needs,
// so a good fixture the agent's grounding check would reject is caught here
// rather than in a paid run.
const RANGED_CALLS: Readonly<Record<string, readonly (readonly [string, Record<string, string>])[]>> = {
  "ho-nt-october": [["sales_by_day", { from: "2026-10-01", to: "2026-10-31" }]],
};

describe("good fixtures and grounding", () => {
  const bundle = createDemoGate();
  const ctx = loadDemoContext(bundle.gate, bundle.store);
  const registry = defaultToolRegistry();
  const defaults = ["classify_menu", "invoice_variance", "sales_by_day", "staff_cost", "list_reviews"].map((n) => registry.run(n, {}, ctx));

  it("write into the menu criteria exactly the items classify_menu labels", () => {
    const menu = registry.run("classify_menu", {}, ctx) as { items: { name: string; label: string }[] };
    const named = (sentence: string) => new Set(sentence.slice(sentence.indexOf(" are the ") + 9, sentence.indexOf(";")).split(/, | and /));
    const labelled = (...labels: string[]) => new Set(menu.items.filter((i) => labels.includes(i.label)).map((i) => i.name));
    expect(named(STARS)).toEqual(labelled("star"));
    expect(named(PRICE_UP)).toEqual(labelled("price_up"));
    // Low margin for its category: price_up when it sells, retire or keep when it does not.
    expect(named(BELOW_LINE)).toEqual(labelled("price_up", "retire", "keep"));
  });

  it("names only scenarios that exist in its ranged calls", () => {
    const ids = new Set(ALL_LIVE_SCENARIOS.map((s) => s.id));
    expect(Object.keys(RANGED_CALLS).filter((id) => !ids.has(id))).toEqual([]);
  });

  it.each(ALL_LIVE_SCENARIOS.map((s) => [s.id, s] as const))("%s: every good answer is grounded in the tool outputs", (_id, s) => {
    const results = [POLICY_FIGURES, ...defaults, ...(RANGED_CALLS[s.id] ?? []).map(([name, input]) => registry.run(name, input, ctx))];
    for (const sample of samples(LIVE_FIXTURES[s.id]!.good)) {
      const text = outcomeOf(sample).text;
      expect(ungroundedFigures(text, { question: s.question, currency: ctx.currency, results }), text).toEqual([]);
    }
  });
});

describe("figure matchers", () => {
  it("match a figure whole, with or without its comma and pence, and never inside a longer one", () => {
    expect(gbp("1,873").test("£1,873.00")).toBe(true);
    expect(gbp("1,873").test("£1873")).toBe(true);
    expect(gbp("1,873").test("£1,873.50")).toBe(false);
    expect(gbp("7").test("£7.80")).toBe(false);
    expect(gbp("12").test("£120")).toBe(false);
    expect(gbp("0").test("£0.80")).toBe(false);
    expect(gbp("0").test("£0.00 taken")).toBe(true);
    expect(gbp("8.44").test("£8.441")).toBe(false);
    expect(pct("4.4").test("14.4%")).toBe(false);
    expect(pct("4.4").test("down 4.4 %")).toBe(true);
    expect(pct("30").test("30.2%")).toBe(false);
    expect(pct("7.1").test("7.14% over")).toBe(true);
    expect(pct("0.2").test("up 0.18%")).toBe(true);
    expect(pct("5.6").test("5.56%")).toBe(true);
    expect(pct("7.1").test("7.16%")).toBe(false);
    expect(pct("7.1").test("7.142%")).toBe(false);
  });

  it("read an owner-set figure as money, a percentage or a whole number", () => {
    expect(figureMatcher("£1,873").test("took £1,873.00")).toBe(true);
    expect(figureMatcher("17.8%").test("17.8% over")).toBe(true);
    expect(figureMatcher("17.8%").test("117.8% over")).toBe(false);
    expect(figureMatcher("212").test("212 transactions")).toBe(true);
    expect(figureMatcher("212").test("2,212 transactions")).toBe(false);
    expect(figureMatcher("212").test("£212.50")).toBe(false);
  });
});
