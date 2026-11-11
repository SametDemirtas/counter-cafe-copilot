import { describe, expect, it } from "vitest";

import { lineItem, mergeAndSortLineItems, modifier } from "../lib/domain/order.js";
import { squareAdapter } from "../lib/data/providers/square.js";
import { InvoiceSchema, invoiceVariance } from "../lib/tools/invoice.js";
import { ShiftsSchema } from "../lib/tools/days.js";
import { MenuSchema, classifyMenu } from "../lib/tools/menu.js";
import { loadOrders } from "../lib/data/loader.js";
import { staffCostRatios } from "../lib/tools/staff.js";
import { summarizeReviews } from "../lib/tools/reviews.js";
import { type ActionSpec, InMemoryEffectSink, reviewReplyHandler } from "../lib/safety/index.js";
import { Agent, ToolRegistry, createDemoGate, loadDemoContext } from "../lib/agent/index.js";
import { ScriptedLlm } from "../lib/agent/testing.js";
import { DemoLlmClient } from "../lib/web/demo-llm.js";

describe("summarizeReviews", () => {
  it("rounds the average with the same rule grounding uses, so 1.45 shows as 1.5", () => {
    // 29 stars over 20 reviews is 1.45, which plain Math.round on x * 10 takes to 1.4.
    const reviews = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, author: "A", rating: i < 11 ? 1 : 2, text: "" }));
    expect(summarizeReviews(reviews).averageRating).toBe(1.5);
  });
});

describe("domain guards", () => {
  it("rejects a non-positive line quantity", () => {
    expect(() => lineItem({ sku: "x", name: "X", quantity: 0, unitPriceMinor: 100, currency: "GBP", modifiers: [] })).toThrow(RangeError);
  });

  it("refuses to merge lines whose summed quantity leaves the safe-integer range", () => {
    const big = () =>
      lineItem({ sku: "x", name: "X", quantity: Number.MAX_SAFE_INTEGER, unitPriceMinor: 1, currency: "GBP", modifiers: [] });
    expect(() => mergeAndSortLineItems([big(), big()])).toThrow(RangeError);
  });

  it("orders same-named modifiers by price, so modifier order never changes identity", () => {
    const item = lineItem({
      sku: "x",
      name: "X",
      quantity: 1,
      unitPriceMinor: 100,
      currency: "GBP",
      modifiers: [modifier("Shot", 50, "GBP"), modifier("Shot", 30, "GBP")],
    });
    expect(item.modifiers.map((m) => m.unitPrice.amountMinor)).toEqual([30, 50]);
  });
});

describe("Square guards", () => {
  const base = {
    id: "o",
    created_at: "2026-11-03T08:00:00.000Z",
    line_items: [{ uid: "u", name: "Latte", quantity: "1", catalog_object_id: "latte", base_price_money: { amount: 340, currency: "GBP" } }],
  };

  it("rejects mixed currencies in one order", () => {
    const mixed = structuredClone(base);
    mixed.line_items.push({ uid: "v", name: "Latte", quantity: "1", catalog_object_id: "latte", base_price_money: { amount: 340, currency: "EUR" } });
    expect(() => squareAdapter.toCanonical(mixed)).toThrow(/Mixed currencies/);
  });

  it("rejects a zero or non-numeric quantity", () => {
    for (const quantity of ["0", "abc", "1.5"]) {
      const bad = structuredClone(base);
      bad.line_items[0]!.quantity = quantity;
      expect(() => squareAdapter.toCanonical(bad)).toThrow(RangeError);
    }
  });
});

describe("arithmetic overflow guards", () => {
  it("invoice: a line total outside the safe-integer range throws instead of losing precision", () => {
    const invoice = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [{ item: "X", agreedUnitPriceMinor: 0, invoicedUnitPriceMinor: 9e15, quantity: 2 }],
    });
    expect(() => invoiceVariance(invoice)).toThrow(RangeError);
  });

  it("menu: a total contribution margin outside the safe-integer range throws", () => {
    const menu = MenuSchema.parse([{ sku: "gold", name: "Gold", category: "food", priceMinor: 4e15, foodCostMinor: 0, ingredients: ["gold_leaf"] }]);
    const unit = { item: { id: "gold" }, name: "Gold", price: 4e15 };
    const orders = loadOrders("clover", [
      { id: "O", createdTime: 1, currency: "GBP", lineItems: { elements: [1, 2, 3].map((n) => ({ id: `u${n}`, ...unit })) } },
    ]);
    expect(() => classifyMenu(menu, orders)).toThrow(RangeError);
  });

  it("staff: a day's summed shift cost outside the safe-integer range throws", () => {
    const shifts = ShiftsSchema.parse({
      currency: "GBP",
      days: [
        {
          date: "2026-11-03",
          dayOfWeek: "Tuesday",
          salesMinor: 1,
          transactions: 1,
          shifts: [
            { staff: "A", slot: "morning", costMinor: 9e15 },
            { staff: "B", slot: "evening", costMinor: 9e15 },
          ],
        },
      ],
    });
    expect(() => staffCostRatios(shifts)).toThrow(RangeError);
  });
});

describe("safety edge cases", () => {
  it("reviewReplyHandler refuses a price spec and applies nothing", () => {
    const sink = new InMemoryEffectSink();
    const spec: ActionSpec = { kind: "price_change", params: { sku: "x", currentPriceMinor: 1, proposedPriceMinor: 2, currency: "GBP" } };
    expect(() => reviewReplyHandler.execute("a", spec, sink)).toThrow(/received a price_change spec/);
    expect(sink.applied()).toHaveLength(0);
  });

  it("the agent's store view returns undefined for an unknown id", () => {
    const bundle = createDemoGate();
    expect(loadDemoContext(bundle.gate, bundle.store).store.get("nope")).toBeUndefined();
  });
});

describe("agent loop edge cases", () => {
  const ctx = () => {
    const bundle = createDemoGate();
    return loadDemoContext(bundle.gate, bundle.store);
  };

  it("feeds a non-Error throw back to the model as an error result", async () => {
    const boom = new ToolRegistry([
      {
        name: "boom",
        description: "throws a string",
        jsonSchema: { type: "object" },
        run: () => {
          throw "kaboom";
        },
      },
    ]);
    const llm = new ScriptedLlm([
      { stop: "tool_use", blocks: [{ type: "tool_use", id: "t1", name: "boom", input: {} }] },
      { stop: "end", blocks: [{ type: "text", text: "That failed." }] },
    ]);
    const answer = await new Agent(llm, boom).ask(ctx(), "q");
    // `body` is the model's own answer; `text` adds the status lines under it.
    expect(answer.body).toBe("That failed.");
  });

  it("finishes rather than sending an empty turn when every tool call had no id", async () => {
    const llm = new ScriptedLlm([{ stop: "tool_use", blocks: [{ type: "tool_use", id: "", name: "invoice_variance", input: {} }] }]);
    const answer = await new Agent(llm, new ToolRegistry([])).ask(ctx(), "q");
    expect(answer.toolCalls).toHaveLength(0);
    expect(answer.body).toBe("I don't have an answer for that.");
  });
});

describe("demo narration fallbacks", () => {
  const narrateOf = async (toolName: string, content: string) => {
    const response = await new DemoLlmClient().respond({
      system: "",
      tools: [],
      messages: [
        { role: "user", blocks: [{ type: "text", text: "q" }] },
        { role: "assistant", blocks: [{ type: "tool_use", id: "c1", name: toolName, input: {} }] },
        { role: "user", blocks: [{ type: "tool_result", toolUseId: "c1", content }] },
      ],
    });
    const block = response.blocks[0];
    return block?.type === "text" ? block.text : "";
  };

  it("falls back to a generic line when a tool result has an unexpected shape", async () => {
    expect(await narrateOf("invoice_variance", "not json")).toBe("Here is what I found in your data.");
  });

  it("says so when there are no reviews", async () => {
    const empty = JSON.stringify({ reviews: [], count: 0, averageRating: null });
    expect(await narrateOf("list_reviews", empty)).toBe("You have no customer reviews yet.");
  });
});
