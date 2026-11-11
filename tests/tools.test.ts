import { describe, expect, it } from "vitest";

import { formatMoney, money } from "../lib/domain/money.js";
import { loadOrders } from "../lib/data/loader.js";
import { InvoiceSchema, invoiceSummary, invoiceVariance } from "../lib/tools/invoice.js";
import { MenuSchema, classifyMenu } from "../lib/tools/menu.js";
import { ShiftsSchema, isSalesMissing, latestWeek } from "../lib/tools/days.js";
import { menuItemsSupplied, unknownRecipeStock } from "../lib/tools/stock.js";
import { staffCostRatios, worstStaffDay, worstTradingDay } from "../lib/tools/staff.js";
import cloverOrders from "../lib/data/mock/clover-orders.json";
import menuJson from "../lib/data/mock/menu.json";
import invoiceJson from "../lib/data/mock/invoice.json";
import shiftsJson from "../lib/data/mock/shifts.json";

const orders = loadOrders("clover", cloverOrders);
const menu = MenuSchema.parse(menuJson);
const invoice = InvoiceSchema.parse(invoiceJson);
const shifts = ShiftsSchema.parse(shiftsJson);
const lastWeek = latestWeek(shifts);

describe("invoiceVariance", () => {
  it("flags the tomato line as ~17.8% over the agreed price", () => {
    const tomatoes = invoiceVariance(invoice).find((r) => r.item.startsWith("Tomatoes"));
    expect(tomatoes).toBeDefined();
    expect(tomatoes!.variancePct).toBeCloseTo(0.1778, 4);
    expect(tomatoes!.overchargeMinor).toBe((212 - 180) * 10);
    expect(tomatoes!.flagged).toBe(true);
    // Pins the figures the eval scenario asserts, so the two can't drift apart.
    expect((tomatoes!.variancePct * 100).toFixed(1)).toBe("17.8");
    expect(formatMoney(money(tomatoes!.overchargeMinor, "GBP"))).toBe("£3.20");
  });

  it("does not flag a line charged at the agreed price", () => {
    const avocado = invoiceVariance(invoice).find((r) => r.item.startsWith("Avocado"));
    expect(avocado!.variancePct).toBe(0);
    expect(avocado!.flagged).toBe(false);
  });

  it("does not flag an undercharge", () => {
    const cheaper = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [{ item: "Milk", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 90, quantity: 5 }],
    });
    const line = invoiceVariance(cheaper)[0]!;
    expect(line.variancePct).toBeCloseTo(-0.1, 6);
    expect(line.flagged).toBe(false);
  });

  it("flags a charge for something that used to be free (agreed price 0)", () => {
    const newCharge = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [{ item: "Delivery", agreedUnitPriceMinor: 0, invoicedUnitPriceMinor: 50, quantity: 2 }],
    });
    const line = invoiceVariance(newCharge)[0]!;
    expect(line.variancePct).toBe(0);
    expect(line.flagged).toBe(true);
    expect(line.overchargeMinor).toBe(100);
  });

  it("rejects a negative or non-finite threshold", () => {
    expect(() => invoiceVariance(invoice, { thresholdPct: -0.1 })).toThrow(/thresholdPct must be a non-negative number/);
    expect(() => invoiceVariance(invoice, { thresholdPct: Number.NaN })).toThrow(/thresholdPct must be a non-negative number/);
  });

  it("returns flagged lines first, worst variance first", () => {
    const lines = invoiceVariance(invoice);
    expect(lines.slice(0, 2).map((r) => r.item)).toEqual(["Tomatoes (kg)", "Sourdough loaf (each)"]);
    // Includes the newly charged item at 0% variance.
    const lastFlagged = lines.map((l) => l.flagged).lastIndexOf(true);
    const firstUnflagged = lines.findIndex((l) => !l.flagged);
    expect(lastFlagged).toBeLessThan(firstUnflagged);
    expect(lines.findIndex((l) => l.item === "Delivery surcharge")).toBeLessThan(firstUnflagged);
  });
});

describe("invoiceSummary", () => {
  it("totals the flagged lines once, through Money", () => {
    const summary = invoiceSummary(invoice);
    const flagged = summary.lines.filter((l) => l.flagged);
    expect(flagged.map((l) => l.item)).toEqual(["Tomatoes (kg)", "Sourdough loaf (each)", "Oat milk (L)", "Free-range eggs (dozen)", "Whole milk (L)", "Delivery surcharge"]);
    expect(summary.flaggedCount).toBe(flagged.length);
    expect(summary.totalOverchargeMinor).toBe(flagged.reduce((sum, l) => sum + l.overchargeMinor, 0));
    // The butter undercharge is not flagged, so it does not reduce the total.
    expect(summary.lines.find((l) => l.item === "Butter (kg)")).toMatchObject({ flagged: false, overchargeMinor: -80 });
    expect(summary.currency).toBe("GBP");
  });

  it("passes the threshold through and refuses a safe-integer overflow in the total", () => {
    expect(invoiceSummary(invoice, { thresholdPct: 1 }).flaggedCount).toBe(1);
    const huge = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [
        { item: "A", agreedUnitPriceMinor: 0, invoicedUnitPriceMinor: Number.MAX_SAFE_INTEGER, quantity: 1 },
        { item: "B", agreedUnitPriceMinor: 0, invoicedUnitPriceMinor: Number.MAX_SAFE_INTEGER, quantity: 1 },
      ],
    });
    expect(() => invoiceSummary(huge)).toThrow(RangeError);
  });
});

describe("unknownRecipeStock", () => {
  it("names recipe stock no menu item uses, and nothing for the mock invoice", () => {
    expect(unknownRecipeStock(invoice, menu)).toEqual([]);
    const typo = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [
        { item: "Tomatoes (kg)", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 100, quantity: 1, supplies: { via: "recipe", stock: "tomatos" } },
        { item: "Oat milk (L)", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 100, quantity: 1, supplies: { via: "option", modifier: "Never sold" } },
        { item: "Delivery", agreedUnitPriceMinor: 0, invoicedUnitPriceMinor: 0, quantity: 1, supplies: { via: "none" } },
      ],
    });
    // An option the till has not sold yet is real, so only the recipe typo is named.
    expect(unknownRecipeStock(typo, menu)).toEqual(["tomatos"]);
  });
});

describe("what each invoice line supplies on the menu", () => {
  const line = (item: string) => invoiceVariance(invoice).find((l) => l.item === item)!;
  const supplied = (item: string) => menuItemsSupplied(line(item).supplies, menu, orders);

  it("traces recipe stock to the items that use it, an option to the drinks sold with it, and a surcharge to nothing", () => {
    expect(supplied("Tomatoes (kg)")).toEqual(["Avocado Toast", "Halloumi Wrap"]);
    expect(supplied("Sourdough loaf (each)")).toEqual(["Avocado Toast", "Ham & Cheese Toastie"]);
    // Oat milk is in no recipe but is sold as an option on the milk drinks.
    expect(supplied("Oat milk (L)")).toEqual(["Cortado", "Flat White", "Cappuccino", "Latte", "Mocha", "Iced Latte", "Chai Latte", "Matcha Latte", "Hot Chocolate"]);
    expect(invoice.lines.filter((l) => l.supplies?.via === "option").map((l) => l.item)).toEqual(["Oat milk (L)"]);
    expect(supplied("Delivery surcharge")).toEqual([]);
  });

  it("reports an unmapped line as unknown, not as supplying nothing, whatever its wording", () => {
    const renamed = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [{ item: "Tomatoes (5kg box)", agreedUnitPriceMinor: 900, invoicedUnitPriceMinor: 900, quantity: 1 }],
    });
    const [only] = invoiceVariance(renamed);
    expect(only!.supplies).toBeNull();
    expect(menuItemsSupplied(only!.supplies, menu, orders)).toBeNull();
    // The mapping goes by what the line records, not by the supplier's wording.
    expect(menuItemsSupplied({ via: "recipe", stock: "tomatoes" }, menu, orders)).toEqual(["Avocado Toast", "Halloumi Wrap"]);
  });

  it("maps every line in the mock invoice to stock the menu uses or a modifier the till sold", () => {
    const stock = new Set(menu.flatMap((m) => m.ingredients));
    const modifiers = new Set(orders.flatMap((o) => o.lineItems.flatMap((l) => l.modifiers.map((m) => m.name))));
    const broken = invoice.lines.filter((l) => {
      const s = l.supplies;
      if (s === undefined) return true;
      if (s.via === "recipe") return !stock.has(s.stock);
      if (s.via === "option") return !modifiers.has(s.modifier);
      return false;
    });
    expect(broken.map((l) => l.item)).toEqual([]);
  });

  it("refuses a malformed mapping", () => {
    const withSupply = (supplies: unknown) =>
      InvoiceSchema.safeParse({ supplier: "S", invoiceId: "I", currency: "GBP", lines: [{ item: "X", agreedUnitPriceMinor: 1, invoicedUnitPriceMinor: 1, quantity: 1, supplies }] }).success;
    expect(withSupply({ via: "recipe", stock: "tomatoes" })).toBe(true);
    expect(withSupply({ via: "recipe", stock: "Tomatoes" })).toBe(false);
    expect(withSupply({ via: "option", modifier: "" })).toBe(false);
    expect(withSupply({ via: "guess" })).toBe(false);
  });
});

describe("classifyMenu", () => {
  const month = classifyMenu(menu, orders);
  const skusLabelled = (label: string) => month.items.filter((c) => c.label === label).map((c) => c.sku).sort();
  const bench = (category: string) => month.categories.find((c) => c.category === category)!;

  // Raw Clover orders: one element per unit sold.
  const sold = (units: Record<string, number>) =>
    loadOrders(
      "clover",
      Object.entries(units).map(([sku, n], i) => ({
        id: `T-${i}`,
        createdTime: Date.parse("2026-11-03T09:00:00Z"),
        currency: "GBP",
        lineItems: { elements: Array.from({ length: n }, (_, k) => ({ id: `${sku}-${k}`, item: { id: sku }, name: sku, price: 300 })) },
      })),
    );
  // In one category, A earns 200p an item and B 100p. Each needs its own stock
  // unless told otherwise.
  const item = (sku: string, foodCostMinor: number, category = "bakery", ingredients = [`${sku}_stock`]) => ({
    sku,
    name: sku.toUpperCase(),
    category,
    priceMinor: 300,
    foodCostMinor,
    ingredients,
  });
  const twoItems = MenuSchema.parse([item("a", 100), item("b", 200)]);
  const labelsOf = (result: ReturnType<typeof classifyMenu>) => result.items.map((c) => c.label);

  it("benchmarks each category on its own unit-weighted margin and popularity line", () => {
    expect(month.categories.map((c) => c.category)).toEqual(["espresso_bar", "cold_drinks", "tea_and_other_hot", "bakery", "food"]);
    // Food: 1,382 units earning £4,741.50, so £3.43 an item; the margin line is
    // 95% of that rounded up, and the popularity line 0.7 x 1,382 / 5.
    expect(bench("food")).toEqual({
      category: "food",
      averageContributionMarginMinor: 343,
      marginLineMinor: 326,
      popularityLineUnits: (0.7 * 1382) / 5,
    });
    expect(bench("espresso_bar")).toMatchObject({ averageContributionMarginMinor: 238, marginLineMinor: 227 });
    expect(bench("bakery")).toMatchObject({ averageContributionMarginMinor: 175, marginLineMinor: 167 });
    const avocado = month.items.find((c) => c.sku === "avocado_toast")!;
    expect(avocado).toMatchObject({ category: "food", contributionMarginMinor: 440, unitsSold: 568, label: "star" });
    expect(avocado.grossMarginPct).toBeCloseTo(440 / 780, 10);
  });

  it("labels the four weeks' items, each against its own category", () => {
    expect(skusLabelled("star")).toEqual([
      "americano",
      "avocado_toast",
      "banana_bread",
      "cappuccino",
      "cold_brew",
      "croissant",
      "english_breakfast_tea",
      "flat_white",
      "iced_latte",
      "latte",
    ]);
    expect(skusLabelled("price_up")).toEqual(["blueberry_muffin", "ham_cheese_toastie", "hot_chocolate", "orange_juice"]);
    expect(skusLabelled("promote")).toEqual([
      "chai_latte",
      "chocolate_brownie",
      "cortado",
      "granola_bowl",
      "green_tea",
      "halloumi_wrap",
      "macchiato",
      "matcha_latte",
      "mocha",
    ]);
    expect(skusLabelled("keep")).toEqual(["espresso"]);
    expect(skusLabelled("retire")).toEqual(["bacon_roll"]);
  });

  it("counts a margin within the tolerance of the category average as high", () => {
    // Americano earns 230p against the espresso bar's 238p: inside the 5% band.
    expect(month.items.find((c) => c.sku === "americano")!.label).toBe("star");
    expect(classifyMenu(menu, orders, { marginTolerance: 0 }).items.find((c) => c.sku === "americano")!.label).toBe("price_up");
    expect(() => classifyMenu(menu, orders, { marginTolerance: 1 })).toThrow(RangeError);
    expect(() => classifyMenu(menu, orders, { marginTolerance: -0.1 })).toThrow(RangeError);
  });

  it("keeps a slow seller whose ingredients are all shared, and says what retiring would save", () => {
    const espresso = month.items.find((c) => c.sku === "espresso")!;
    expect(espresso).toMatchObject({ label: "keep", dedicatedIngredients: [] });
    const roll = month.items.find((c) => c.sku === "bacon_roll")!;
    expect(roll).toMatchObject({ label: "retire", dedicatedIngredients: ["bread_rolls", "bacon"] });
    // Tomatoes go into the avocado toast too, so they are not the wrap's alone.
    expect(month.items.find((c) => c.sku === "halloumi_wrap")!.dedicatedIngredients).toEqual(["tortillas", "halloumi"]);
  });

  it("benchmarks a drink against drinks, not against food", () => {
    // Flat white's 240p clears the espresso bar's line but is far below food's.
    const flatWhite = month.items.find((c) => c.sku === "flat_white")!;
    expect(flatWhite.label).toBe("star");
    expect(flatWhite.contributionMarginMinor).toBeLessThan(bench("food").marginLineMinor!);
  });

  it("rejects a menu with duplicate SKUs, an unknown category and an invalid popularity factor", () => {
    expect(() => MenuSchema.parse([item("a", 10), item("a", 20)])).toThrow(/unique/);
    expect(() => MenuSchema.parse([item("a", 10, "brunch")])).toThrow(/Invalid enum value/);
    expect(() => MenuSchema.parse([item("a", 10, "bakery", [])])).toThrow(/at least 1/);
    expect(() => MenuSchema.parse([item("a", 10, "bakery", ["Flour"])])).toThrow(/snake_case/);
    expect(() => MenuSchema.parse([item("a", 10, "bakery", ["flour", "flour"])])).toThrow(/only once/);
    // Food cost at or above the price would give a negative margin and invert the margin line.
    expect(() => MenuSchema.parse([item("a", 300)])).toThrow(/below its price/);
    expect(() => MenuSchema.parse([item("a", 450)])).toThrow(/below its price/);
    expect(MenuSchema.parse([item("a", 299)])).toHaveLength(1);
    expect(() => classifyMenu(menu, orders, { popularityFactor: Number.NaN })).toThrow(RangeError);
    expect(() => classifyMenu(menu, orders, { popularityFactor: -1 })).toThrow(RangeError);
  });

  it("sets popularity relative to the category's average units per item, inclusive at the line", () => {
    // 7 and 3 sold: the average is 5, so the default line is 3.5. The weighted
    // average margin is (7 x 200 + 3 x 100) / 10 = 170p.
    expect(labelsOf(classifyMenu(twoItems, sold({ a: 7, b: 3 })))).toEqual(["star", "retire"]);
    // At 0.6 the line is exactly 3.
    expect(labelsOf(classifyMenu(twoItems, sold({ a: 7, b: 3 }), { popularityFactor: 0.6 }))).toEqual(["star", "price_up"]);
  });

  it("puts the tolerance line at the average less 5%, rounded up to whole pence", () => {
    // 200p and 190p, five each: the average is 195p and the line 185.25p, so 186p.
    const close = MenuSchema.parse([item("a", 100), { ...item("b", 100), priceMinor: 290 }]);
    expect(classifyMenu(close, sold({ a: 5, b: 5 })).categories[0]!.marginLineMinor).toBe(186);
    expect(labelsOf(classifyMenu(close, sold({ a: 5, b: 5 })))).toEqual(["star", "star"]);
    expect(labelsOf(classifyMenu(close, sold({ a: 5, b: 5 }), { marginTolerance: 0 }))).toEqual(["star", "price_up"]);
  });

  it("counts a margin exactly at the average as high, and covers the promote quadrant", () => {
    // 3 and 7 sold: the average margin is (3 x 200 + 7 x 100) / 10 = 130p.
    expect(labelsOf(classifyMenu(twoItems, sold({ a: 3, b: 7 })))).toEqual(["promote", "price_up"]);
    const level = MenuSchema.parse([item("a", 100), { ...item("b", 200), priceMinor: 400 }]);
    expect(labelsOf(classifyMenu(level, sold({ a: 5, b: 5 })))).toEqual(["star", "star"]);
  });

  it("splits the slow, low-margin quadrant on shared stock: keep when all of it is shared, retire otherwise", () => {
    const shared = MenuSchema.parse([item("a", 100, "bakery", ["flour"]), item("b", 200, "bakery", ["flour"])]);
    expect(labelsOf(classifyMenu(shared, sold({ a: 7, b: 3 })))).toEqual(["star", "keep"]);
    const partly = MenuSchema.parse([item("a", 100, "bakery", ["flour"]), item("b", 200, "bakery", ["flour", "raisins"])]);
    const result = classifyMenu(partly, sold({ a: 7, b: 3 }));
    expect(result.items[1]).toMatchObject({ label: "retire", dedicatedIngredients: ["raisins"] });
  });

  it("keeps categories apart: a weak seller elsewhere does not drag a category down", () => {
    const menuOf = MenuSchema.parse([item("a", 100), item("b", 200), item("c", 250, "food")]);
    const result = classifyMenu(menuOf, sold({ a: 7, b: 3, c: 1 }));
    expect(labelsOf(result)).toEqual(["star", "retire", "star"]);
  });

  it("judges an item alone in its category against itself: a star once it sells", () => {
    const alone = MenuSchema.parse([item("a", 100), item("b", 200), item("solo", 250, "food")]);
    const result = classifyMenu(alone, sold({ a: 5, b: 5, solo: 2 }));
    expect(result.items[2]!.label).toBe("star");
    expect(result.categories[1]).toEqual({ category: "food", averageContributionMarginMinor: 50, marginLineMinor: 48, popularityLineUnits: 1.4 });
    expect(classifyMenu(alone, sold({ a: 5, b: 5 })).items[2]!.label).toBe("retire");
  });

  it("gives a category where nothing sold no average or margin line, so its items with stock of their own are retire", () => {
    const result = classifyMenu(MenuSchema.parse([item("a", 100), item("c", 250, "food")]), sold({ a: 4 }));
    expect(result.categories[1]).toEqual({ category: "food", averageContributionMarginMinor: null, marginLineMinor: null, popularityLineUnits: 0 });
    expect(labelsOf(result)).toEqual(["star", "retire"]);
    expect(labelsOf(classifyMenu(twoItems, []))).toEqual(["retire", "retire"]);
  });
});

describe("staff cost", () => {
  it("computes the overstaffed Tuesday at 39.3% and Wednesday at 27.5% of sales in the latest week", () => {
    const ratios = staffCostRatios(lastWeek);
    expect(ratios.find((r) => r.dayOfWeek === "Tuesday")).toMatchObject({ staffCostMinor: 37_876, salesMinor: 96_400, staffCount: 4 });
    expect(ratios.find((r) => r.dayOfWeek === "Tuesday")!.ratioPct).toBeCloseTo(37_876 / 96_400, 10);
    expect(ratios.find((r) => r.dayOfWeek === "Wednesday")!.ratioPct).toBeCloseTo(27_825 / 101_200, 10);
  });

  it("names the worst trading day apart from the outage day", () => {
    expect(worstTradingDay(lastWeek)!.date).toBe("2026-11-03");
    const closedOnly = ShiftsSchema.parse({ currency: "GBP", days: [{ date: "2026-11-02", dayOfWeek: "Monday", salesMinor: 0, transactions: 0, shifts: [] }] });
    expect(worstTradingDay(closedOnly)).toBeNull();
  });

  it("picks the no-sales day (Sunday till outage) as the worst, ahead of the highest ratio", () => {
    const worst = worstStaffDay(lastWeek)!;
    expect(worst.date).toBe("2026-11-08");
    expect(worst.salesMissing).toBe(true);
  });

  it("rejects a day whose weekday contradicts its date, and duplicate dates", () => {
    const shift = { staff: "A", slot: "morning", costMinor: 100 };
    expect(() =>
      ShiftsSchema.parse({ currency: "GBP", days: [{ date: "2026-11-03", dayOfWeek: "Monday", salesMinor: 1, transactions: 1, shifts: [shift] }] }),
    ).toThrow(/does not match/);
    const tuesday = { date: "2026-11-03", dayOfWeek: "Tuesday", salesMinor: 1, transactions: 1, shifts: [shift] };
    expect(() => ShiftsSchema.parse({ currency: "GBP", days: [tuesday, tuesday] })).toThrow(/only once/);
  });

  it("ranks a day with staff cost but no sales as the worst, not a 0% day", () => {
    const withBlankDay = ShiftsSchema.parse({
      currency: "GBP",
      days: [
        { date: "2026-11-02", dayOfWeek: "Monday", salesMinor: 0, transactions: 0, shifts: [{ staff: "A", slot: "morning", costMinor: 20000 }] },
        { date: "2026-11-03", dayOfWeek: "Tuesday", salesMinor: 100000, transactions: 120, shifts: [{ staff: "A", slot: "morning", costMinor: 38000 }] },
      ],
    });
    const worst = worstStaffDay(withBlankDay)!;
    expect(worst.dayOfWeek).toBe("Monday");
    expect(worst.salesMissing).toBe(true);
  });

  it("counts sales as missing on a worked day whose only shift cost nothing, as sales_by_day does", () => {
    const unpaid = ShiftsSchema.parse({
      currency: "GBP",
      days: [{ date: "2026-11-09", dayOfWeek: "Monday", salesMinor: 0, transactions: 0, shifts: [{ staff: "Owner", slot: "morning", costMinor: 0 }] }],
    });
    expect(staffCostRatios(unpaid)[0]).toMatchObject({ staffCostMinor: 0, salesMissing: true });
    expect(isSalesMissing(unpaid.days[0]!)).toBe(true);
  });
});
