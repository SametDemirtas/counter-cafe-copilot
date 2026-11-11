import { describe, expect, it } from "vitest";

import { type ActionSpec, type PolicyRule, PolicyRejection } from "../../lib/safety/index.js";
import { fixtureGate, reply } from "./catalog-fixture.js";

const price = (params: Partial<{ sku: string; currentPriceMinor: number; proposedPriceMinor: number; currency: string }>): ActionSpec =>
  ({
    kind: "price_change",
    params: { sku: "avocado_toast", currentPriceMinor: 780, proposedPriceMinor: 850, currency: "GBP", ...params },
  }) as ActionSpec;

function rejectedWith(spec: ActionSpec): { rule: PolicyRule; message: string } {
  const bundle = fixtureGate();
  let caught: unknown;
  try {
    bundle.gate.propose(spec);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PolicyRejection);
  // Refused before the store or the audit log is touched, like a duplicate proposal.
  expect(bundle.store.entries()).toHaveLength(0);
  expect(bundle.audit.entries()).toHaveLength(0);
  expect(bundle.sink.applied()).toHaveLength(0);
  const rejection = caught as PolicyRejection;
  return { rule: rejection.rule, message: rejection.message };
}

describe("approval policy, enforced by the gate for any caller", () => {
  it("accepts a sane price change and a sane reply", () => {
    const { gate, store } = fixtureGate();
    gate.propose(price({}));
    gate.propose(reply("five-star"));
    expect(store.entries().map((r) => r.status)).toEqual(["pending", "pending"]);
  });

  it("refuses a 1p price proposed straight to the gate", () => {
    expect(rejectedWith(price({ proposedPriceMinor: 1 }))).toEqual({
      rule: "below_food_cost",
      message: "Avocado Toast would sell at or below its food cost of £3.40",
    });
  });

  it("refuses a price at food cost, and one more than 50% away either way", () => {
    expect(rejectedWith(price({ proposedPriceMinor: 340 })).rule).toBe("below_food_cost");
    expect(rejectedWith(price({ proposedPriceMinor: 1171 }))).toEqual({
      rule: "max_change",
      message: "a change of more than 50% to Avocado Toast is outside what one proposal may do",
    });
    expect(rejectedWith(price({ proposedPriceMinor: 389 })).rule).toBe("max_change");
  });

  it("accepts the 50% boundaries exactly", () => {
    const { gate } = fixtureGate();
    expect(() => gate.propose(price({ proposedPriceMinor: 1170 }))).not.toThrow();
    const other = fixtureGate();
    expect(() => other.gate.propose(price({ proposedPriceMinor: 390 }))).not.toThrow();
  });

  it("refuses an unknown sku", () => {
    expect(rejectedWith(price({ sku: "unicorn" }))).toEqual({ rule: "unknown_sku", message: 'No menu item with sku "unicorn"' });
  });

  it("refuses a proposal made against a stale current price", () => {
    const { rule, message } = rejectedWith(price({ currentPriceMinor: 800 }));
    expect(rule).toBe("stale_price");
    expect(message).toMatch(/Avocado Toast is £7\.80 now/);
  });

  it("refuses the wrong currency", () => {
    expect(rejectedWith(price({ currency: "EUR" })).rule).toBe("wrong_currency");
  });

  it("refuses a price that is not a positive whole number of pence", () => {
    expect(rejectedWith(price({ proposedPriceMinor: Number.NaN })).rule).toBe("invalid_price");
    expect(rejectedWith(price({ proposedPriceMinor: 850.5 })).rule).toBe("invalid_price");
    expect(rejectedWith(price({ proposedPriceMinor: -850 })).rule).toBe("invalid_price");
  });

  it("refuses a change to the price the item already has", () => {
    expect(rejectedWith(price({ proposedPriceMinor: 780 }))).toEqual({
      rule: "no_change",
      message: "Avocado Toast is already at that price",
    });
  });

  it("names the open proposal's prices as typed figures and says how to change it", () => {
    const { gate } = fixtureGate();
    gate.propose(price({}));
    let caught: unknown;
    try {
      gate.propose(price({ proposedPriceMinor: 820 }));
    } catch (error) {
      caught = error;
    }
    const rejection = caught as PolicyRejection;
    expect(rejection.rule).toBe("already_open");
    expect(rejection.message).toMatch(/already waiting for approval: .*\. Reject it first if you want a different price\.$/);
    expect(rejection.figures).toEqual({ openCurrentPriceMinor: 780, openProposedPriceMinor: 850 });
  });

  it("has no rules for an unknown action kind, so it refuses it", () => {
    const { gate, store } = fixtureGate();
    const refund = { kind: "refund", params: { amountMinor: 500 } } as unknown as ActionSpec;
    expect(() => gate.propose(refund)).toThrow(/no approval policy for refund/);
    expect(store.entries()).toHaveLength(0);
  });

  it("refuses a reply to an unknown review, an empty reply and an overlong one", () => {
    expect(rejectedWith(reply("nope"))).toEqual({ rule: "unknown_review", message: 'No review with id "nope"' });
    expect(rejectedWith(reply("five-star", "   ")).rule).toBe("empty_reply");
    const notText = { kind: "review_reply", params: { reviewId: "five-star", replyText: 42 } } as unknown as ActionSpec;
    expect(rejectedWith(notText).rule).toBe("empty_reply");
    expect(rejectedWith(reply("five-star", "x".repeat(2001))).rule).toBe("reply_too_long");
    const { gate } = fixtureGate();
    expect(() => gate.propose(reply("five-star", "x".repeat(2000)))).not.toThrow();
  });
});
