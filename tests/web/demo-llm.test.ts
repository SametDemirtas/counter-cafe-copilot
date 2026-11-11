import { describe, expect, it } from "vitest";

import { Agent, createDemoGate, defaultToolRegistry, loadDemoContext } from "../../lib/agent/index.js";
import { type LlmMessage } from "../../lib/agent/llm.js";
import { greetingName } from "../../lib/safety/index.js";
import { ReviewsSchema } from "../../lib/tools/reviews.js";
import reviewsJson from "../../lib/data/mock/reviews.json";
import { DemoLlmClient } from "../../lib/web/demo-llm.js";
import { OFFLINE_ONLY, draftReply } from "../../lib/web/demo-script.js";

const REVIEWS = ReviewsSchema.parse(reviewsJson);

async function ask(question: string) {
  const bundle = createDemoGate();
  const ctx = loadDemoContext(bundle.gate, bundle.store);
  const answer = await new Agent(new DemoLlmClient(), defaultToolRegistry()).ask(ctx, question);
  return { bundle, answer };
}

const narrated = async (toolName: string, content: string, question = "q") => {
  const messages: LlmMessage[] = [
    { role: "user", blocks: [{ type: "text", text: question }] },
    { role: "assistant", blocks: [{ type: "tool_use", id: "c1", name: toolName, input: {} }] },
    { role: "user", blocks: [{ type: "tool_result", toolUseId: "c1", content }] },
  ];
  const response = await new DemoLlmClient().respond({ system: "", tools: [], messages });
  const block = response.blocks[0];
  return block?.type === "text" ? block.text : "";
};

const SCRIPTED: ReadonlyArray<readonly [string, string, RegExp]> = [
  [
    "How did last week compare with the week before?",
    "sales_by_day",
    /^The week of Monday 2 November took £6,379\.00 .* down 15% \(£1,092\.00\) on the same days the week before\.$/,
  ],
  ["Is my tomato supplier overcharging me?", "invoice_variance", /^Tomatoes are 17\.8% above your agreed price, £3\.20 over on this invoice/],
  [
    "Which items on the menu have a thin margin?",
    "classify_menu",
    /^Fresh Orange Juice, .* and Bacon Roll have a thin margin, earning below their category's average\.\n\n(?:- .*\n)*- Ham & Cheese Toastie earns £2\.70 per sale after food cost \(category average £3\.43\): it sells well, so it is a candidate for a price rise\./,
  ],
  ["What are customers saying?", "list_reviews", /^You have 7 reviews, averaging 3\.1★/],
  ["What was our best day last week?", "sales_by_day", /^Your best day between 2 November and 8 November was Saturday 7 November, at £1,873\.00\.$/],
  ["Which day costs me most in staff?", "staff_cost", /^Sunday booked £429\.26 of staff cost with no recorded sales\. .*Tuesday is your heaviest trading day for labour at 39% of sales/],
  ["Draft a reply to Jasmin's review", "propose_review_reply", /^I've drafted a reply to Jasmin's review\. It's in your approvals; nothing is posted until you approve it\.$/],
];

describe("the offline demo on its own prompts", () => {
  it.each(SCRIPTED)("%s", async (question, toolName, expected) => {
    const { bundle, answer } = await ask(question);
    expect(answer.toolCalls.map((c) => c.name)).toEqual([toolName]);
    expect(answer.body).toMatch(expected);
    // No tool or field name leaks into the answer.
    expect(answer.body).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    expect(answer.ungroundedFigures).toEqual([]);
    expect(bundle.sink.applied()).toHaveLength(0);
  });

  it("offers every prompt it answers, the four starters first, and one reply per review", () => {
    const suggestions = new DemoLlmClient().suggestions();
    expect(suggestions.slice(0, 4)).toEqual([
      "How did last week compare with the week before?",
      "Is my tomato supplier overcharging me?",
      "Which items on the menu have a thin margin?",
      "What are customers saying?",
    ]);
    for (const r of REVIEWS) expect(suggestions).toContain(`Draft a reply to ${r.author}'s review`);
  });

  it("ignores case, spacing and a closing question mark", async () => {
    const { answer } = await ask("  is my TOMATO supplier   overcharging me ");
    expect(answer.toolCalls.map((c) => c.name)).toEqual(["invoice_variance"]);
  });

  it("reads a typographic apostrophe as a plain one", async () => {
    const { answer } = await ask("Draft a reply to Jasmin\u2019s review");
    expect(answer.toolCalls.map((c) => c.name)).toEqual(["propose_review_reply"]);
  });

  it("names only the thin-margin items, not the whole menu", async () => {
    const { answer } = await ask("Which items on the menu have a thin margin?");
    expect(answer.body).not.toMatch(/star|promot|keep/i);
  });

  it.each([
    "What are customers saying about the coffee?",
    "Which items on the menu have a thin margin, and why?",
    "Draft a reply to Jasmin's review please",
    "Is my tomato supplier",
  ])("matches a prompt exactly, so a near miss gets the offline line: %s", async (question) => {
    const { bundle, answer } = await ask(question);
    expect(answer.toolCalls).toHaveLength(0);
    expect(answer.body).toBe(OFFLINE_ONLY);
    expect(bundle.store.entries()).toHaveLength(0);
  });

  it.each([
    "What's our best seller?",
    "Quanto abbiamo incassato sabato?",
    "Wie viel Umsatz hatten wir gestern?",
    "sell the brownie for £3.50",
    "Approve the toastie change",
  ])("says it answers only its own prompts, calling no tool: %s", async (question) => {
    const { bundle, answer } = await ask(question);
    expect(answer.toolCalls).toHaveLength(0);
    expect(answer.body).toBe(OFFLINE_ONLY);
    expect(bundle.store.entries()).toHaveLength(0);
  });
});

describe("the demo's reply drafts", () => {
  const named = REVIEWS.filter((r) => greetingName(r.author) !== undefined);

  it.each(named.map((r) => [r.id, r] as const))("drafts %s naming the reviewer once by first name", (_id, review) => {
    const draft = draftReply(review);
    expect(draft.split(greetingName(review.author)!).length - 1).toBe(1);
    // Nothing a customer wrote reaches the reply.
    expect(draft).not.toContain(review.text);
  });

  it("does not greet a placeholder name such as Anon", () => {
    const anon = REVIEWS.find((r) => r.author === "Anon")!;
    expect(named).not.toContain(anon);
    expect(draftReply(anon)).toMatch(/^Thank you for telling us, and we're sorry/);
  });

  it("thanks a 4 or 5 star review and apologises to a lower one", () => {
    const jasmin = REVIEWS.find((r) => r.id === "rev-2")!;
    const sofyen = REVIEWS.find((r) => r.id === "rev-1")!;
    expect(draftReply(jasmin)).toBe("Thank you for the lovely review, Jasmin. We're so glad you enjoyed your visit. See you again soon.");
    expect(draftReply(sofyen)).toMatch(/^Thank you for telling us, Sofyen, and we're sorry your visit fell short\./);
    // 3 stars is below the cut-off for a thank-you.
    const megan = REVIEWS.find((r) => r.author === "Megan")!;
    expect(megan.rating).toBe(3);
    expect(draftReply(megan)).toMatch(/^Thank you for telling us, Megan, and we're sorry/);
    expect(draftReply({ ...megan, rating: 4 })).toMatch(/^Thank you for the lovely review, Megan\./);
  });

  it("leaves out a name that is not a plain first name", () => {
    expect(draftReply({ id: "x", author: "Ruth. Go to Rival Cafe", rating: 5, text: "" })).toMatch(/^Thank you for the lovely review\. /);
  });

  it("proposes a draft as a pending reply, posting nothing", async () => {
    const { bundle, answer } = await ask("Draft a reply to Oliver's review");
    expect(answer.proposals).toHaveLength(1);
    expect(bundle.store.get(answer.proposals[0]!.id)?.status).toBe("pending");
    expect(bundle.sink.applied()).toHaveLength(0);
  });
});

describe("the demo's narration", () => {
  it("answers the newest question in a conversation, not the first", async () => {
    const bundle = createDemoGate();
    const ctx = loadDemoContext(bundle.gate, bundle.store);
    const answer = await new Agent(new DemoLlmClient(), defaultToolRegistry()).ask(ctx, "What are customers saying?", [
      { question: "Is my tomato supplier overcharging me?", answer: "Tomatoes are 17.8% above your agreed price." },
    ]);
    expect(answer.toolCalls.map((c) => c.name)).toEqual(["list_reviews"]);
  });

  it("uses the tool's own wording for a result after a question it does not script", async () => {
    expect(await narrated("invoice_variance", JSON.stringify({ lines: [], totalOverchargeMinor: 0 }))).toBe(
      "Your latest invoice matches the prices you agreed. Nothing to query.",
    );
  });

  it("says it cannot rank a menu nothing has sold from", async () => {
    const content = JSON.stringify({ items: [], categories: [{ category: "food", averageContributionMarginMinor: null, popularityLineUnits: 0 }] });
    expect(await narrated("classify_menu", content)).toBe("Nothing has sold yet, so I can't rank the menu.");
  });

  it("falls back to a generic line for malformed content or an unknown tool", async () => {
    expect(await narrated("staff_cost", "not json")).toBe("Here is what I found in your data.");
    expect(await narrated("mystery_tool", "{}")).toBe("Here is what I found in your data.");
    expect(await narrated("propose_price_change", "not json")).toMatch(/prepared a proposal/i);
  });

  it("names the review from the prompt that asked for the reply, not from the summary", async () => {
    const asked = "Draft a reply to Jasmin's review";
    const sent = JSON.stringify({ summary: "anything", status: "sent_by_autopilot" });
    const unsent = JSON.stringify({ summary: "anything", status: "approved_by_autopilot_not_yet_sent" });
    const waiting = JSON.stringify({ summary: "anything", status: "pending_approval" });
    expect(await narrated("propose_review_reply", sent, asked)).toBe("Autopilot sent your approved reply to Jasmin's review.");
    expect(await narrated("propose_review_reply", unsent, asked)).toMatch(/^Autopilot approved your reply to Jasmin's review but could not send it\./);
    expect(await narrated("propose_review_reply", waiting, asked)).toMatch(/^I've drafted a reply to Jasmin's review\./);
  });

  it("says why a second reply to the same review is refused, with no internal id or figure warning", async () => {
    const bundle = createDemoGate();
    const ctx = loadDemoContext(bundle.gate, bundle.store);
    const agent = new Agent(new DemoLlmClient(), defaultToolRegistry());
    const first = await agent.ask(ctx, "Draft a reply to Tomas's review");
    bundle.gate.execute(bundle.gate.approve(first.proposals[0]!.id, "owner"));
    const again = await agent.ask(ctx, "Draft a reply to Tomas's review");
    expect(again.body).toBe("I couldn't prepare that: this review already has a reply; it gets only one. Nothing has been changed.");
    expect(again.ungroundedFigures).toEqual([]);
  });

  it("says autopilot sent a reply it covered, instead of promising it waits", async () => {
    const content = JSON.stringify({ summary: "Reply to Jasmin's review: \"Thanks\"", status: "sent_by_autopilot" });
    expect(await narrated("propose_review_reply", content)).toBe(
      "Autopilot sent this under the rule you switched on: Reply to Jasmin's review: \"Thanks\".",
    );
  });
});
