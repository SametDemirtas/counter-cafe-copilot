import { describe, expect, it } from "vitest";

import { MAX_AUTOPILOT_REPLY_CHARS, PROMISE_TRIPWIRE, REVIEW_TRIPWIRE, checkDraft, reviewTripwire } from "../../lib/safety/index.js";

const ctx = { reviewer: "Jasmin", knownNames: ["Jasmin", "Priya", "Josh", "Anon"] };

describe("the review tripwire", () => {
  it.each([
    "Lovely coffee, but I got food poisoning from the wrap.",
    "My son had an allergic reaction to the flapjack.",
    "Spent the night in hospital after lunch.",
    "Found glass in my soup! Otherwise amazing x",
    "I want a refund or I'm calling my solicitor.",
    "Ich hatte eine Allergie danach.",
  ])("sends to the owner: %s", (text) => {
    expect(reviewTripwire(text).hit).toBe(true);
  });

  it.each([
    "Lovely spot, friendly staff, the flat white is the best around.",
    "Best cold brew in town, I come back every week.",
    "Service was slow and a table was sticky.",
    "Great courtesy from the team.",
    "",
  ])("does not fire on: %s", (text) => {
    expect(reviewTripwire(text)).toEqual({ hit: false, terms: [] });
  });

  it("reads a term through a zero-width character or fullwidth letters", () => {
    expect(reviewTripwire("I was si\u200bck after").terms).toEqual(["sick"]);
    expect(reviewTripwire("I want a ｒｅｆｕｎｄ").terms).toEqual(["refund"]);
  });

  it("matches a term only at the start of a word", () => {
    expect(reviewTripwire("A bit homesick, lovely tea though.").hit).toBe(false);
  });

  it("names the terms it matched", () => {
    expect(reviewTripwire("Sick after the wrap, I want a refund").terms).toEqual(["sick", "refund"]);
  });

  it("is a frozen, short list", () => {
    expect(Object.isFrozen(REVIEW_TRIPWIRE)).toBe(true);
    expect(Object.isFrozen(PROMISE_TRIPWIRE)).toBe(true);
    expect(REVIEW_TRIPWIRE.length).toBeLessThanOrEqual(30);
  });
});

describe("the draft checks", () => {
  it.each([
    ["digit", "See you at 9 tomorrow."],
    ["digit", "See you at ９ tomorrow."],
    ["digit", "See you at ٩ tomorrow."],
    ["phone", "Call 020 7946 0958."],
    ["link", "See https://example.com"],
    ["link", "Book at www.cafe.example"],
    ["link", "Find us at countercafe.co.uk now"],
    ["email", "Write to owner@cafe.example please."],
    ["handle", "Follow @countercafe for news."],
    ["handle", "Follow ＠countercafe for news."],
    ["promise", "Fr\u200bee coffee next time."],
    ["other_name", "Thanks Jasmin, ask Priya for a seat next time."],
    ["promise", "Your next coffee is on us."],
    ["promise", "Your voucher is waiting at the till."],
    ["empty", "   "],
  ] as const)("fails %s: %s", (rule, text) => {
    const result = checkDraft(text, ctx);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(rule);
  });

  it("caps the length", () => {
    expect(checkDraft("a".repeat(MAX_AUTOPILOT_REPLY_CHARS + 1), ctx).failures).toContain("too_long");
    expect(checkDraft("a".repeat(MAX_AUTOPILOT_REPLY_CHARS), ctx).ok).toBe(true);
    // Counted in characters, not UTF-16 units: an emoji is one.
    expect(checkDraft("\u{1F600}".repeat(MAX_AUTOPILOT_REPLY_CHARS), ctx).ok).toBe(true);
  });

  it.each([
    "Thank you, Jasmin!",
    "Danke, Jasmin, bis bald!",
    "Teşekkürler Jasmin, yine bekleriz.",
    "¡Gracias, Jasmin! Hasta pronto.",
    "Thanks for coming in. See you soon.",
  ])("passes a plain thank-you in any language: %s", (text) => {
    expect(checkDraft(text, ctx)).toEqual({ ok: true, failures: [] });
  });

  it("lets the reply name the reviewer but nobody else the café knows", () => {
    expect(checkDraft("Thanks, Josh!", { reviewer: "Josh", knownNames: ctx.knownNames }).ok).toBe(true);
    expect(checkDraft("Thanks, Josh!", ctx).failures).toEqual(["other_name"]);
    // Whole words only: "Anon" is a reviewer, "anonymous" is not a name.
    expect(checkDraft("Thanks for the anonymous note.", ctx).ok).toBe(true);
  });

  it("keeps the promise list an English tripwire: other languages rest on the owner having read the banked reply", () => {
    expect(checkDraft("Ihr Gutschein wartet.", ctx).ok).toBe(true);
  });

  it("catches another known person named by one part of their name", () => {
    const known = { reviewer: "Lena Park", knownNames: ["Lena Park", "Megan R.", "Tomas Rees"] };
    expect(checkDraft("Thanks Megan, see you!", known).failures).toEqual(["other_name"]);
    expect(checkDraft("Thanks Ms Rees, see you!", known).failures).toEqual(["other_name"]);
    expect(checkDraft("THANKS MEGAN!", known).failures).toEqual(["other_name"]);
    // The reviewer's own name, whole or in part, is fine.
    expect(checkDraft("Thanks Lena Park!", known).ok).toBe(true);
    expect(checkDraft("Thanks Lena!", known).ok).toBe(true);
  });
});
