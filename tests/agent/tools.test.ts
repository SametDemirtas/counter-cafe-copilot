import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type HandlerRegistry } from "../../lib/safety/index.js";
import { ToolError, createDemoGate, defaultToolRegistry, loadDemoContext } from "../../lib/agent/index.js";

function setup(handlers?: HandlerRegistry) {
  let n = 0;
  const bundle = createDemoGate({
    ...(handlers ? { handlers } : {}),
    now: () => new Date("2026-11-10T08:00:00.000Z"),
    newId: () => `act-${++n}`,
    newToken: () => `tok-${n}`,
  });
  const ctx = loadDemoContext(bundle.gate, bundle.store);
  return { ...bundle, ctx, tools: defaultToolRegistry() };
}

// Domain figures live in tests/tools.test.ts; these check only what each wrapper adds.
describe("analysis tool wrappers", () => {
  it("classify_menu returns one classification per menu item plus each category's benchmarks", () => {
    const { tools, ctx } = setup();
    const result = tools.run("classify_menu", {}, ctx) as {
      items: Array<Record<string, unknown>>;
      categories: Array<{ category: string; averageContributionMarginMinor: number }>;
    };
    expect(result.items.map((r) => r["sku"])).toEqual(ctx.menu.map((m) => m.sku));
    for (const row of result.items) {
      // Price, food cost and margin travel with the label so the model can quote them without working them out.
      expect(Object.keys(row).sort()).toEqual([
        "category",
        "contributionMarginMinor",
        "dedicatedIngredients",
        "foodCostMinor",
        "grossMarginPct",
        "label",
        "name",
        "priceMinor",
        "sku",
        "unitsSold",
      ]);
    }
    expect(result.categories.map((c) => c.averageContributionMarginMinor)).toEqual([238, 218, 222, 175, 343]);
  });

  it("invoice_variance adds a flagged count, a money total and the currency", () => {
    const { tools, ctx } = setup();
    const result = tools.run("invoice_variance", {}, ctx) as {
      lines: Array<{ flagged: boolean }>;
      flaggedCount: number;
      totalOverchargeMinor: number;
      currency: string;
    };
    expect(result.lines).toHaveLength(ctx.invoice.lines.length);
    // Six lines over agreed price, totalling £12.00.
    expect(result.flaggedCount).toBe(6);
    expect(result.totalOverchargeMinor).toBe(1200);
    expect(result.currency).toBe("GBP");
  });

  it("staff_cost covers the latest week only, plus its worst day taken from the same list", () => {
    const { tools, ctx } = setup();
    const result = tools.run("staff_cost", {}, ctx) as {
      from: string;
      to: string;
      byDay: Array<{ date: string }>;
      worst: { date: string };
      worstTradingDay: { date: string };
    };
    expect(result.from).toBe("2026-11-02");
    expect(result.to).toBe("2026-11-08");
    expect(result.byDay.map((d) => d.date)).toEqual(ctx.shifts.days.slice(-7).map((d) => d.date));
    expect(result.byDay).toContainEqual(result.worst);
    expect(result.worstTradingDay.date).toBe("2026-11-03");
  });

  it("sales_by_day validates its range at the boundary and defaults to every day", () => {
    const { tools, ctx } = setup();
    const all = tools.run("sales_by_day", {}, ctx) as { from: string; to: string; days: unknown[] };
    expect([all.from, all.to, all.days.length]).toEqual(["2026-10-12", "2026-11-08", 28]);
    const week = tools.run("sales_by_day", { from: "2026-11-02", to: "2026-11-08" }, ctx) as { days: unknown[] };
    expect(week.days).toHaveLength(7);
    expect(() => tools.run("sales_by_day", { from: "last week" }, ctx)).toThrow(/Invalid date/);
    expect(() => tools.run("sales_by_day", { from: "2026-11-02", evil: true }, ctx)).toThrow(/Unrecognized key/);
  });

  it("list_reviews returns the reviews with ids, plus a count and average computed in the tool", () => {
    const { tools, ctx } = setup();
    const result = tools.run("list_reviews", {}, ctx) as {
      reviews: Array<{ id: string; author: string }>;
      count: number;
      averageRating: number | null;
    };
    expect(result.reviews.find((r) => r.author === "Sofyen")?.id).toBe("rev-1");
    expect(result.reviews.every((r) => typeof r.id === "string" && r.id.length > 0)).toBe(true);
    // 22 stars over 7 reviews = 3.14, rounded in the tool so the model never averages.
    expect(result.count).toBe(7);
    expect(result.averageRating).toBe(3.1);
  });
});

describe("a date outside the data", () => {
  it("sales_by_day refuses with the data's first and last day as typed fields", () => {
    const { tools, ctx } = setup();
    let caught: unknown;
    try {
      tools.run("sales_by_day", { from: "2026-10-01", to: "2026-10-01" }, ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolError);
    const days = ctx.shifts.days;
    expect((caught as ToolError).figures).toEqual({ dataFrom: days[0]!.date, dataTo: days[days.length - 1]!.date });
  });
});

describe("thresholds the model may quote", () => {
  it("travel as typed fractions that match the constants", async () => {
    const { INVOICE_FLAG_THRESHOLD } = await import("../../lib/tools/invoice.js");
    const { MARGIN_TOLERANCE } = await import("../../lib/tools/menu.js");
    const { MAX_PRICE_CHANGE } = await import("../../lib/safety/index.js");
    const { tools, ctx } = setup();
    expect((tools.run("invoice_variance", {}, ctx) as { flagThresholdPct: number }).flagThresholdPct).toBe(INVOICE_FLAG_THRESHOLD);
    expect((tools.run("classify_menu", {}, ctx) as { marginTolerancePct: number }).marginTolerancePct).toBe(MARGIN_TOLERANCE);
    const ok = tools.run("propose_price_change", { sku: "latte", proposedPriceMinor: 360 }, ctx) as { maxChangePct: number };
    expect(ok.maxChangePct).toBe(MAX_PRICE_CHANGE);
    try {
      tools.run("propose_price_change", { sku: "latte", proposedPriceMinor: 550 }, ctx);
      expect.unreachable();
    } catch (error) {
      expect((error as { figures: Record<string, number> }).figures.maxChangePct).toBe(MAX_PRICE_CHANGE);
    }
  });
});

describe("a price already waiting for approval", () => {
  it("refuses with the open proposal's prices as figures, so the answer may quote them", async () => {
    const { ungroundedFigures } = await import("../../lib/agent/grounding.js");
    const { tools, ctx } = setup();
    tools.run("propose_price_change", { sku: "latte", proposedPriceMinor: 360 }, ctx);
    let caught: unknown;
    try {
      tools.run("propose_price_change", { sku: "latte", proposedPriceMinor: 370 }, ctx);
    } catch (error) {
      caught = error;
    }
    const error = caught as { message: string; figures: Record<string, number> };
    expect(error.message).toMatch(/Reject it first if you want a different price\.$/);
    expect(error.figures.openProposedPriceMinor).toBe(360);
    const latte = ctx.menu.find((m) => m.sku === "latte")!;
    expect(error.figures.openCurrentPriceMinor).toBe(latte.priceMinor);
    const sources = { question: "make the latte 3.70", currency: ctx.currency, results: [error.figures] };
    expect(ungroundedFigures("A change to £3.60 is already waiting for your approval.", sources)).toEqual([]);
  });
});

describe("invoice lines name the menu items they supply", () => {
  it("traces each line's stock to the recipes that use it, and nothing for a surcharge or unused stock", () => {
    const { tools, ctx } = setup();
    const result = tools.run("invoice_variance", {}, ctx) as { lines: { item: string; affectsMenuItems: string[] | null; asOption: boolean }[] };
    const by = new Map(result.lines.map((l) => [l.item, l.affectsMenuItems]));
    // Only oat milk reaches the menu as an option rather than through a recipe.
    expect(result.lines.filter((l) => l.asOption).map((l) => l.item)).toEqual(["Oat milk (L)"]);
    expect(by.get("Tomatoes (kg)")).toEqual(["Avocado Toast", "Halloumi Wrap"]);
    expect(by.get("Sourdough loaf (each)")).toEqual(["Avocado Toast", "Ham & Cheese Toastie"]);
    // Oat milk is in no recipe but is sold as an option on the milk drinks.
    expect(by.get("Oat milk (L)")).toEqual(["Cortado", "Flat White", "Cappuccino", "Latte", "Mocha", "Iced Latte", "Chai Latte", "Matcha Latte", "Hot Chocolate"]);
    expect(by.get("Delivery surcharge")).toEqual([]);
    expect(by.get("Whole milk (L)")).toContain("Hot Chocolate");
    // Every recipe stock the invoice names is on the menu and every option is a till modifier, so a typo in the data shows up.
    const supplies = ctx.invoice.lines.map((l) => l.supplies);
    const used = new Set(ctx.menu.flatMap((m) => m.ingredients));
    expect(supplies.flatMap((s) => (s?.via === "recipe" && !used.has(s.stock) ? [s.stock] : []))).toEqual([]);
    const modifiers = new Set(ctx.orders.flatMap((o) => o.lineItems.flatMap((l) => l.modifiers.map((m) => m.name))));
    expect(supplies.flatMap((s) => (s?.via === "option" && !modifiers.has(s.modifier) ? [s.modifier] : []))).toEqual([]);
    // And every line except the surcharge reaches the menu one way or the other.
    expect(ctx.invoice.lines.filter((l) => l.supplies?.via === "none").map((l) => l.item)).toEqual(["Delivery surcharge"]);
    expect(ctx.invoice.lines.filter((l) => l.supplies === undefined)).toEqual([]);
  });

  it("reports an unmapped line's menu items as unknown, not as none", () => {
    const { tools, ctx } = setup();
    const [first, ...rest] = ctx.invoice.lines;
    const { supplies: _dropped, ...unmapped } = first!;
    const result = tools.run("invoice_variance", {}, { ...ctx, invoice: { ...ctx.invoice, lines: [unmapped, ...rest] } }) as {
      lines: { item: string; affectsMenuItems: string[] | null; asOption: boolean }[];
    };
    expect(result.lines[0]).toMatchObject({ item: first!.item, affectsMenuItems: null, asOption: false });
  });
});

describe("propose tools only ever create a proposal", () => {
  it("propose_price_change creates a pending proposal and executes nothing", () => {
    const { tools, ctx, store, sink } = setup();
    const out = tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 850 }, ctx) as {
      proposalId: string;
      status: string;
    };
    expect(out.status).toBe("pending_approval");
    expect(store.get(out.proposalId)?.status).toBe("pending");
    expect(sink.applied()).toHaveLength(0);
  });

  it("rejects a price change for an unknown sku", () => {
    const { tools, ctx } = setup();
    expect(() => tools.run("propose_price_change", { sku: "unicorn", proposedPriceMinor: 100 }, ctx)).toThrow(
      /No menu item with sku "unicorn"/,
    );
  });

  it("propose_review_reply creates a pending review_reply proposal and executes nothing", () => {
    const { tools, ctx, store, sink } = setup();
    const out = tools.run("propose_review_reply", { reviewId: "rev-1", replyText: "Thanks for the feedback!" }, ctx) as {
      proposalId: string;
      status: string;
    };
    expect(out.status).toBe("pending_approval");
    const record = store.get(out.proposalId);
    expect(record?.status).toBe("pending");
    expect(record?.proposal.spec.kind).toBe("review_reply");
    expect(sink.applied()).toHaveLength(0);
  });

  it("rejects a reply to an unknown review", () => {
    const { tools, ctx } = setup();
    expect(() => tools.run("propose_review_reply", { reviewId: "nope", replyText: "hi" }, ctx)).toThrow(
      /No review with id "nope"/,
    );
  });

  it("rejects a non-positive proposed price", () => {
    const { tools, ctx } = setup();
    expect(() => tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 0 }, ctx)).toThrow(
      /must be greater than 0/,
    );
    expect(() => tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: -5 }, ctx)).toThrow(
      /must be greater than 0/,
    );
  });

  it("caps the proposed price at 1,000,000 minor units at the schema", () => {
    const { tools, ctx, store } = setup();
    expect(() => tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 1_000_001 }, ctx)).toThrow(
      /less than or equal to 1000000/,
    );
    expect(store.entries()).toHaveLength(0);
  });

  it("refuses a price below food cost or more than 50% away, and accepts the boundaries", () => {
    const { tools, ctx, store } = setup();
    // Avocado Toast: price 780p, food cost 340p, so 390p..1170p is the 50% band.
    // Exactly at food cost is a zero margin, so it is refused too.
    expect(() => tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 340 }, ctx)).toThrow(
      /at or below its food cost/,
    );
    expect(() => tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 339 }, ctx)).toThrow(
      /below its food cost of £3\.40/,
    );
    expect(() => tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 1171 }, ctx)).toThrow(
      /more than 50%/,
    );
    expect(() => tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 389 }, ctx)).toThrow(
      /more than 50%/,
    );
    expect(store.entries()).toHaveLength(0);
    tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 1170 }, ctx);
    tools.run("propose_price_change", { sku: "latte", proposedPriceMinor: 170 }, ctx);
    expect(store.entries()).toHaveLength(2);
  });

  it("caps a review reply at 2000 characters", () => {
    const { tools, ctx, store } = setup();
    expect(() => tools.run("propose_review_reply", { reviewId: "rev-1", replyText: "x".repeat(2001) }, ctx)).toThrow(
      /at most 2000 character/,
    );
    expect(store.entries()).toHaveLength(0);
    tools.run("propose_review_reply", { reviewId: "rev-1", replyText: "x".repeat(2000) }, ctx);
    expect(store.entries()).toHaveLength(1);
  });

  it("validates model input: missing and extra fields are rejected", () => {
    const { tools, ctx } = setup();
    // Issue codes and paths, not zod's wording.
    const issues = (input: unknown): readonly z.ZodIssue[] => {
      try {
        tools.run("propose_price_change", input, ctx);
      } catch (error) {
        if (error instanceof z.ZodError) return error.issues;
      }
      return [];
    };
    expect(issues({ sku: "avocado_toast" })).toContainEqual(
      expect.objectContaining({ code: "invalid_type", path: ["proposedPriceMinor"] }),
    );
    expect(issues({ sku: "avocado_toast", proposedPriceMinor: 100, evil: true })).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["evil"] }),
    );
  });

  it("rejects a no-op price change and a whitespace-only reply", () => {
    const { tools, ctx } = setup();
    expect(() => tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 780 }, ctx)).toThrow(
      /already at that price/,
    );
    expect(() => tools.run("propose_review_reply", { reviewId: "rev-1", replyText: "   " }, ctx)).toThrow(
      /at least 1 character/,
    );
  });

  it("throws for an unknown tool name", () => {
    const { tools, ctx } = setup();
    expect(() => tools.run("drop_database", {}, ctx)).toThrow(/Unknown tool "drop_database"/);
  });
});

describe("propose tools report what the gate did", () => {
  // The owner answers five different reviews by hand, writes a 5 star template
  // and turns autopilot on for 5 stars.
  function withAutopilot() {
    const env = setup();
    for (const reviewId of ["rev-1", "rev-4", "rev-5", "rev-6", "rev-7"]) {
      const out = env.tools.run("propose_review_reply", { reviewId, replyText: "Thank you." }, env.ctx) as { proposalId: string };
      env.gate.execute(env.gate.approve(out.proposalId, "owner"));
    }
    env.gate.setReplyTemplate(5, "Thank you so much, {name}!", "owner");
    env.gate.setAutopilot({ enabled: true, ratings: [5] }, "owner");
    return env;
  }

  it("says pending_approval for every draft, even to a rating autopilot covers", () => {
    const { tools, ctx } = withAutopilot();
    const draft = tools.run("propose_review_reply", { reviewId: "rev-2", replyText: "Thank you!" }, ctx);
    expect(draft).toMatchObject({ status: "pending_approval", replyText: "Thank you!", ownerReplyUsed: false });
    const price = tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 850 }, ctx) as { status: string };
    expect(price.status).toBe("pending_approval");
  });

  it("refuses a draft to a new review autopilot already answered with the owner's template", () => {
    const { tools, ctx, gate } = withAutopilot();
    const arrival = gate.onReviewArrived({ author: "Priya", rating: 5, text: "" });
    expect(arrival.decision.action).toBe("post");
    expect(() => tools.run("propose_review_reply", { reviewId: arrival.review.id, replyText: "Thanks!" }, ctx)).toThrow(/already has a reply/);
  });

  it("passes the gate's policy rejection through as the tool error", () => {
    const { tools, ctx } = setup();
    let caught: unknown;
    try {
      tools.run("propose_price_change", { sku: "avocado_toast", proposedPriceMinor: 78 }, ctx);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe("Avocado Toast would sell at or below its food cost of £3.40");
  });

  it("passes a refused review reply through as a ToolError carrying the gate's reason", () => {
    const { tools, ctx } = setup();
    tools.run("propose_review_reply", { reviewId: "rev-2", replyText: "Thanks so much!" }, ctx);
    const refusal = (reviewId: string): unknown => {
      try {
        tools.run("propose_review_reply", { reviewId, replyText: "Thanks again!" }, ctx);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const duplicate = refusal("rev-2");
    expect(duplicate).toBeInstanceOf(ToolError);
    expect((duplicate as Error).message).toMatch(/^A proposal for this is already waiting for approval: Reply to Jasmin's review/);
    const unknown = refusal("rev-999");
    expect(unknown).toBeInstanceOf(ToolError);
    expect((unknown as Error).message).toBe('No review with id "rev-999"');
  });
});
