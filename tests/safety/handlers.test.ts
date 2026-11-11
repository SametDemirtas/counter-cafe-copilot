import { describe, expect, it } from "vitest";

import {
  type ActionSpec,
  InMemoryEffectSink,
  defaultHandlers,
  priceChangeHandler,
  priceChangeHandlerFor,
  reviewReplyHandler,
} from "../../lib/safety/index.js";

const priceSpec: ActionSpec = {
  kind: "price_change",
  params: { sku: "latte", currentPriceMinor: 340, proposedPriceMinor: 360, currency: "GBP" },
};
const reviewSpec: ActionSpec = {
  kind: "review_reply",
  params: { reviewId: "r-9", replyText: "Thank you!" },
};

describe("handlers", () => {
  it("priceChangeHandler applies one change and describes it", () => {
    const sink = new InMemoryEffectSink();
    const description = priceChangeHandler.execute("act-1", priceSpec, sink);
    expect(description).toBe("Set latte price to £3.60");
    expect(sink.applied()).toEqual([
      { kind: "price_change", actionId: "act-1", description: "Set latte price to £3.60" },
    ]);
  });

  it("writes the new price back to the price list and names the item by its display name", () => {
    const prices = new Map([["latte", 340]]);
    const list = { name: (sku: string) => (sku === "latte" ? "Latte" : undefined), setPrice: (sku: string, p: number) => void prices.set(sku, p) };
    const sink = new InMemoryEffectSink();
    expect(priceChangeHandlerFor(list).execute("act-1", priceSpec, sink)).toBe("Set Latte price to £3.60");
    expect(prices.get("latte")).toBe(360);
    expect(defaultHandlers(list).get("price_change").execute("act-2", priceSpec, sink)).toBe("Set Latte price to £3.60");
  });

  it("reviewReplyHandler applies one change and describes it", () => {
    const sink = new InMemoryEffectSink();
    const description = reviewReplyHandler.execute("act-2", reviewSpec, sink);
    expect(description).toBe("Posted reply to review r-9");
    expect(sink.applied()).toEqual([
      { kind: "review_reply", actionId: "act-2", description: "Posted reply to review r-9" },
    ]);
  });

  it("a handler rejects a spec of the wrong kind", () => {
    const sink = new InMemoryEffectSink();
    expect(() => priceChangeHandler.execute("act-3", reviewSpec, sink)).toThrow(/received a review_reply spec/);
    expect(sink.applied()).toHaveLength(0);
  });

  it("the sink applies an action at most once, even if a retry runs the handler again", () => {
    const sink = new InMemoryEffectSink();
    priceChangeHandler.execute("act-4", priceSpec, sink);
    priceChangeHandler.execute("act-4", priceSpec, sink);
    expect(sink.applied()).toHaveLength(1);
  });
});

describe("HandlerRegistry", () => {
  it("resolves the registered handlers", () => {
    const registry = defaultHandlers();
    expect(registry.get("price_change")).toBe(priceChangeHandler);
    expect(registry.get("review_reply")).toBe(reviewReplyHandler);
  });

  it("throws for an unregistered kind", () => {
    expect(() => defaultHandlers().get("teleport" as never)).toThrow(/No handler registered for action kind "teleport"/);
  });
});
