import { describe, expect, it } from "vitest";
import { z } from "zod";

import { cloverAdapter } from "../lib/data/providers/clover.js";
import { squareAdapter } from "../lib/data/providers/square.js";
import { loadOrders } from "../lib/data/loader.js";
import { type CanonicalOrder, unitsSoldBySku } from "../lib/domain/order.js";

// Asserts on zod's issue codes and paths, never its message wording.
function zodIssues(fn: () => unknown): readonly z.ZodIssue[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof z.ZodError) return error.issues;
    throw error;
  }
  throw new Error("expected a ZodError");
}

// Plain integer pence: the till total an order should reconcile to.
function orderTotalMinor(order: CanonicalOrder): number {
  return order.lineItems.reduce(
    (sum, l) => sum + (l.unitPrice.amountMinor + l.modifiers.reduce((m, mod) => m + mod.unitPrice.amountMinor, 0)) * l.quantity,
    0,
  );
}
import { ShiftsSchema } from "../lib/tools/days.js";
import cloverOrders from "../lib/data/mock/clover-orders.json";
import shiftsJson from "../lib/data/mock/shifts.json";

const createdAtIso = "2026-11-03T08:00:00.000Z";
const createdTime = Date.parse(createdAtIso);

// One sale (two flat whites with oat milk) in each provider's own shape.
const cloverRaw = {
  id: "ORD-CLV-0001",
  createdTime,
  currency: "GBP",
  lineItems: {
    elements: [
      { id: "a", item: { id: "flat_white" }, name: "Flat White", price: 320, modifications: { elements: [{ name: "Oat milk", amount: 40 }] } },
      { id: "b", item: { id: "flat_white" }, name: "Flat White", price: 320, modifications: { elements: [{ name: "Oat milk", amount: 40 }] } },
    ],
  },
};

const squareRaw = {
  id: "ORD-SQ-0001",
  created_at: createdAtIso,
  line_items: [
    {
      uid: "x",
      name: "Flat White",
      quantity: "2",
      catalog_object_id: "flat_white",
      base_price_money: { amount: 320, currency: "GBP" },
      modifiers: [{ name: "Oat milk", base_price_money: { amount: 40, currency: "GBP" } }],
    },
  ],
};

describe("provider conformance", () => {
  it("maps Clover and Square shapes of the same sale to an identical canonical order", () => {
    const fromClover = cloverAdapter.toCanonical(cloverRaw);
    const fromSquare = squareAdapter.toCanonical(squareRaw);

    expect(fromClover.lineItems).toEqual(fromSquare.lineItems);
    expect(fromClover.placedAt).toBe(fromSquare.placedAt);
    expect(fromClover.currency).toBe(fromSquare.currency);
  });

  it("collapses Clover's per-unit line items into one line with a quantity", () => {
    const order = cloverAdapter.toCanonical(cloverRaw);
    expect(order.lineItems).toHaveLength(1);
    expect(order.lineItems[0]).toMatchObject({ sku: "flat_white", quantity: 2 });
  });

  it("merges a Square order that splits the same product across two line entries", () => {
    const split = {
      id: "ORD-SQ-0002",
      created_at: createdAtIso,
      line_items: [
        { uid: "l1", name: "Flat White", quantity: "1", catalog_object_id: "flat_white", base_price_money: { amount: 320, currency: "GBP" }, modifiers: [{ name: "Oat milk", base_price_money: { amount: 40, currency: "GBP" } }] },
        { uid: "l2", name: "Flat White", quantity: "1", catalog_object_id: "flat_white", base_price_money: { amount: 320, currency: "GBP" }, modifiers: [{ name: "Oat milk", base_price_money: { amount: 40, currency: "GBP" } }] },
      ],
    };
    expect(squareAdapter.toCanonical(split).lineItems).toEqual(cloverAdapter.toCanonical(cloverRaw).lineItems);
  });

  it("produces identical, sorted line items for a multi-SKU order from either provider", () => {
    const clover = cloverAdapter.toCanonical({
      id: "ORD-CLV-0003",
      createdTime,
      currency: "GBP",
      lineItems: {
        elements: [
          { id: "a", item: { id: "flat_white" }, name: "Flat White", price: 320, modifications: { elements: [{ name: "Oat milk", amount: 40 }] } },
          { id: "b", item: { id: "flat_white" }, name: "Flat White", price: 320, modifications: { elements: [{ name: "Oat milk", amount: 40 }] } },
          { id: "c", item: { id: "americano" }, name: "Americano", price: 280 },
        ],
      },
    });
    const square = squareAdapter.toCanonical({
      id: "ORD-SQ-0003",
      created_at: createdAtIso,
      line_items: [
        { uid: "a", name: "Americano", quantity: "1", catalog_object_id: "americano", base_price_money: { amount: 280, currency: "GBP" } },
        { uid: "b", name: "Flat White", quantity: "2", catalog_object_id: "flat_white", base_price_money: { amount: 320, currency: "GBP" }, modifiers: [{ name: "Oat milk", base_price_money: { amount: 40, currency: "GBP" } }] },
      ],
    });
    expect(clover.lineItems).toEqual(square.lineItems);
    expect(clover.lineItems.map((l) => l.sku)).toEqual(["americano", "flat_white"]);
  });

  it("computes the same order total from either provider: (320 + 40) * 2 = 720", () => {
    expect(orderTotalMinor(cloverAdapter.toCanonical(cloverRaw))).toBe(720);
    expect(orderTotalMinor(squareAdapter.toCanonical(squareRaw))).toBe(720);
  });

  it("freezes the returned order so it cannot be mutated downstream", () => {
    const order = cloverAdapter.toCanonical(cloverRaw);
    expect(Object.isFrozen(order)).toBe(true);
    expect(Object.isFrozen(order.lineItems)).toBe(true);
    expect(Object.isFrozen(order.lineItems[0])).toBe(true);
    expect(Object.isFrozen(order.lineItems[0]!.unitPrice)).toBe(true);
    expect(Object.isFrozen(order.lineItems[0]!.modifiers)).toBe(true);
    expect(Object.isFrozen(order.lineItems[0]!.modifiers[0])).toBe(true);
  });
});

describe("provider edge cases", () => {
  it("does not count a refunded or exchanged Clover unit as sold", () => {
    for (const flag of ["refunded", "exchanged"]) {
      const raw = structuredClone(cloverRaw) as unknown as { lineItems: { elements: Array<Record<string, unknown>> } };
      raw.lineItems.elements[1]![flag] = true;
      const order = cloverAdapter.toCanonical(raw);
      expect(order.lineItems).toHaveLength(1);
      expect(order.lineItems[0]).toMatchObject({ sku: "flat_white", quantity: 1 });
    }
  });

  it("keeps a fully refunded Clover order as an order with no line items", () => {
    const raw = structuredClone(cloverRaw) as unknown as { lineItems: { elements: Array<Record<string, unknown>> } };
    for (const element of raw.lineItems.elements) element["refunded"] = true;
    const order = cloverAdapter.toCanonical(raw);
    expect(order.id).toBe("ORD-CLV-0001");
    expect(order.lineItems).toEqual([]);
    expect(orderTotalMinor(order)).toBe(0);
  });

  it("rejects a negative base price on either provider", () => {
    const clover = structuredClone(cloverRaw) as unknown as { lineItems: { elements: Array<{ price: number }> } };
    clover.lineItems.elements[0]!.price = -320;
    expect(() => cloverAdapter.toCanonical(clover)).toThrow(/greater than or equal to 0/);
    const square = structuredClone(squareRaw) as unknown as { line_items: Array<{ base_price_money: { amount: number } }> };
    square.line_items[0]!.base_price_money.amount = -320;
    expect(() => squareAdapter.toCanonical(square)).toThrow(/greater than or equal to 0/);
  });

  it("rejects a Square modifier applied more than once rather than pricing it once", () => {
    const square = structuredClone(squareRaw) as unknown as { line_items: Array<{ modifiers: Array<Record<string, unknown>> }> };
    square.line_items[0]!.modifiers[0]!["quantity"] = "2";
    expect(() => squareAdapter.toCanonical(square)).toThrow(/quantity other than 1 are not supported/);
  });

  it("rejects a Square timestamp outside the supported range, as Clover does", () => {
    expect(() => squareAdapter.toCanonical({ ...squareRaw, created_at: "9999-01-01T00:00:00.000Z" })).toThrow(
      /outside the supported date range/,
    );
  });
});

describe("input validation at the boundary", () => {
  it("rejects a Clover order whose money is not an integer", () => {
    const bad = structuredClone(cloverRaw) as unknown as { lineItems: { elements: Array<{ price: unknown }> } };
    bad.lineItems.elements[0]!.price = 3.2;
    expect(zodIssues(() => cloverAdapter.toCanonical(bad))).toContainEqual(
      expect.objectContaining({ code: "invalid_type", expected: "integer", path: ["lineItems", "elements", 0, "price"] }),
    );
  });

  it("rejects a Clover timestamp outside a plausible epoch-ms range", () => {
    const bad = structuredClone(cloverRaw) as unknown as { createdTime: number };
    bad.createdTime = 1e21;
    expect(() => cloverAdapter.toCanonical(bad)).toThrow(/less than or equal to 4102444800000/);
  });

  it("rejects a Square quantity that is not a whole-number string", () => {
    const bad = structuredClone(squareRaw) as unknown as { line_items: Array<{ quantity: string }> };
    bad.line_items[0]!.quantity = "2.5";
    expect(() => squareAdapter.toCanonical(bad)).toThrow(/whole-number string, received "2\.5"/);
  });

  it("rejects a Square line with no catalog_object_id, rather than under-counting it", () => {
    const bad = structuredClone(squareRaw) as unknown as { line_items: Array<Record<string, unknown>> };
    delete bad.line_items[0]!["catalog_object_id"];
    expect(() => squareAdapter.toCanonical(bad)).toThrow(/"catalog_object_id"/);
  });

  it("rejects an unknown provider", () => {
    expect(() => loadOrders("lightspeed", [])).toThrow('Unknown provider "lightspeed"');
  });

  it("does not resolve an inherited object key such as toString to an adapter", () => {
    expect(() => loadOrders("toString", [])).toThrow('Unknown provider "toString"');
    expect(() => loadOrders("constructor", [])).toThrow('Unknown provider "constructor"');
  });

  it("rejects a Square quantity above the per-line maximum", () => {
    const bad = structuredClone(squareRaw) as unknown as { line_items: Array<{ quantity: string }> };
    bad.line_items[0]!.quantity = "100001";
    expect(() => squareAdapter.toCanonical(bad)).toThrow(/Square quantity out of range, received "100001"/);
  });

  it("rejects an empty SKU from either provider", () => {
    const badSquare = structuredClone(squareRaw) as unknown as { line_items: Array<{ catalog_object_id: string }> };
    badSquare.line_items[0]!.catalog_object_id = "";
    expect(() => squareAdapter.toCanonical(badSquare)).toThrow(/at least 1 character/);

    const badClover = structuredClone(cloverRaw) as unknown as { lineItems: { elements: Array<{ item: { id: string } }> } };
    badClover.lineItems.elements[0]!.item.id = "";
    expect(() => cloverAdapter.toCanonical(badClover)).toThrow(/at least 1 character/);
  });
});

describe("modifier canonicalization", () => {
  it("sorts modifiers so two providers listing them in different order are identical", () => {
    const clover = cloverAdapter.toCanonical({
      id: "ORD-CLV-M1",
      createdTime,
      currency: "GBP",
      lineItems: {
        elements: [
          { id: "a", item: { id: "flat_white" }, name: "Flat White", price: 320, modifications: { elements: [{ name: "Oat milk", amount: 40 }, { name: "Extra shot", amount: 50 }] } },
        ],
      },
    });
    const square = squareAdapter.toCanonical({
      id: "ORD-SQ-M1",
      created_at: createdAtIso,
      line_items: [
        { uid: "a", name: "Flat White", quantity: "1", catalog_object_id: "flat_white", base_price_money: { amount: 320, currency: "GBP" }, modifiers: [{ name: "Extra shot", base_price_money: { amount: 50, currency: "GBP" } }, { name: "Oat milk", base_price_money: { amount: 40, currency: "GBP" } }] },
      ],
    });
    expect(clover.lineItems).toEqual(square.lineItems);
    expect(clover.lineItems[0]!.modifiers.map((m) => m.name)).toEqual(["Extra shot", "Oat milk"]);
  });

  it("does not merge lines whose modifier names would collide under naive concatenation", () => {
    const order = cloverAdapter.toCanonical({
      id: "ORD-CLV-M2",
      createdTime,
      currency: "GBP",
      lineItems: {
        elements: [
          { id: "a", item: { id: "flat_white" }, name: "Flat White", price: 320, modifications: { elements: [{ name: "A", amount: 1 }, { name: "B", amount: 2 }] } },
          { id: "b", item: { id: "flat_white" }, name: "Flat White", price: 320, modifications: { elements: [{ name: "A:1|B", amount: 2 }] } },
        ],
      },
    });
    expect(order.lineItems).toHaveLength(2);
  });
});

describe("mock sales fixture", () => {
  it("loads every Clover mock order and totals units sold per sku", () => {
    const orders = loadOrders("clover", cloverOrders);
    expect(orders).toHaveLength(cloverOrders.length);
    const units = unitsSoldBySku(orders);
    expect(units.get("flat_white")).toBe(965);
    expect(units.get("americano")).toBe(486);
    expect(units.get("avocado_toast")).toBe(568);
  });

  it("reconciles with the daily record: one order per transaction, totals equal to the till to the penny", () => {
    const orders = loadOrders("clover", cloverOrders);
    const byDay = new Map<string, { count: number; totalMinor: number }>();
    for (const order of orders) {
      // Opening hours fall well inside the UTC day, so the UTC date is the London date.
      const date = order.placedAt.slice(0, 10);
      const day = byDay.get(date) ?? { count: 0, totalMinor: 0 };
      byDay.set(date, { count: day.count + 1, totalMinor: day.totalMinor + orderTotalMinor(order) });
    }
    for (const day of ShiftsSchema.parse(shiftsJson).days) {
      const got = byDay.get(day.date) ?? { count: 0, totalMinor: 0 };
      expect({ date: day.date, ...got }).toEqual({ date: day.date, count: day.transactions, totalMinor: day.salesMinor });
      byDay.delete(day.date);
    }
    // No order falls on a date outside the record.
    expect([...byDay.keys()]).toEqual([]);
  });
});
