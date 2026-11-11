import { describe, expect, it } from "vitest";

import { type AgentContext, createDemoGate, loadDemoContext, morningBrief } from "../../lib/agent/index.js";
import { InvoiceSchema } from "../../lib/tools/invoice.js";
import { MenuSchema } from "../../lib/tools/menu.js";
import { ShiftsSchema } from "../../lib/tools/days.js";

function base(): AgentContext {
  const bundle = createDemoGate();
  return loadDemoContext(bundle.gate, bundle.store);
}

const cleanInvoice = InvoiceSchema.parse({
  supplier: "S",
  invoiceId: "I",
  currency: "GBP",
  lines: [{ item: "Milk", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 100, quantity: 1 }],
});

const lowStaff = ShiftsSchema.parse({
  currency: "GBP",
  days: [{ date: "2026-11-09", dayOfWeek: "Monday", salesMinor: 100000, transactions: 120, shifts: [{ staff: "A", slot: "morning", costMinor: 20000 }] }],
});

// No till outage, so only the ratio fallback can fire.
const ratioShifts = ShiftsSchema.parse({
  currency: "GBP",
  days: [
    { date: "2026-11-03", dayOfWeek: "Tuesday", salesMinor: 100000, transactions: 120, shifts: [{ staff: "A", slot: "morning", costMinor: 20000 }, { staff: "B", slot: "evening", costMinor: 18000 }] },
    { date: "2026-11-04", dayOfWeek: "Wednesday", salesMinor: 100000, transactions: 120, shifts: [{ staff: "A", slot: "morning", costMinor: 13000 }, { staff: "B", slot: "evening", costMinor: 13000 }] },
  ],
});

const healthyMenu = MenuSchema.parse([{ sku: "x", name: "X", category: "food", priceMinor: 1000, foodCostMinor: 100, ingredients: ["bread"] }]);

const newChargeInvoice = InvoiceSchema.parse({
  supplier: "S",
  invoiceId: "I",
  currency: "GBP",
  lines: [{ item: "Delivery", agreedUnitPriceMinor: 0, invoicedUnitPriceMinor: 50, quantity: 10 }],
});

const blankSalesDay = ShiftsSchema.parse({
  currency: "GBP",
  days: [{ date: "2026-11-09", dayOfWeek: "Monday", salesMinor: 0, transactions: 0, shifts: [{ staff: "A", slot: "morning", costMinor: 20000 }] }],
});

describe("morningBrief", () => {
  it("leads with the till outage as a data issue, then ranks the menu, Tuesday's staffing and the invoice by money a week", () => {
    const brief = morningBrief(base());
    // Staff cost on a day with no sales is a data problem, shown before any money finding.
    expect(brief.headline).toBe("Data issue: Sunday booked £429.26 of staff cost with no recorded sales. Check the till and the rota.");
    expect(brief.more).toEqual([
      // 73p under food's average on each of 540 sold over the record's four weeks: £98.55 a week.
      "Ham & Cheese Toastie sells well but earns £2.70 an item after food cost, below the £3.43 average for food. Raising the price would help.",
      // Tuesday's cost above 33% of its sales, once a week.
      "Tuesday staff cost is 39% of sales, the highest share of any trading day. A shift there is the clearest saving.",
      // The invoice, taken as one week's delivery: the whole invoice first, then its biggest line.
      "Your latest invoice is £12.00 over the agreed prices across six lines. The biggest is tomatoes: 17.8% above your agreed price, £3.20 over. Worth a word with the supplier.",
    ]);
    // A shown finding's suggestion travels with the brief even when it is not the headline.
    expect(brief.suggestedAction).toMatchObject({
      kind: "price_change",
      params: { sku: "ham_cheese_toastie", currentPriceMinor: 650, proposedPriceMinor: 715 },
    });
  });

  it("keeps the outage in its own lane and ranks the heavy day on its own money", () => {
    // Monday: £200.00 of staff with no sales. Tuesday: £380 on £1,000, £50.00 above the line.
    const shifts = ShiftsSchema.parse({ currency: "GBP", days: [{ ...blankSalesDay.days[0], date: "2026-11-02" }, ...ratioShifts.days] });
    const invoice = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [{ item: "Milk", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 200, quantity: 100 }],
    });
    const brief = morningBrief({ ...base(), invoice, shifts, menu: healthyMenu });
    expect(brief.headline).toMatch(/^Data issue: Monday booked £200\.00 of staff cost/);
    expect(brief.more).toEqual([expect.stringMatching(/^Milk is 100% above/), expect.stringMatching(/^Tuesday staff cost is 38% of sales/)]);
  });

  it("ranks a heavy staff day by its cost above 33% of sales", () => {
    // Tuesday: £380 of staff on £1,000 of sales is £50 a week over the line, less than the toastie's £98.55.
    const brief = morningBrief({ ...base(), invoice: cleanInvoice, shifts: ratioShifts });
    expect(brief.headline).toContain("Ham & Cheese Toastie");
    expect(brief.more).toEqual(["Tuesday staff cost is 38% of sales, the highest share of any trading day. A shift there is the clearest saving."]);

    const alone = morningBrief({ ...base(), invoice: cleanInvoice, shifts: ratioShifts, menu: healthyMenu });
    expect(alone.headline).toBe("Tuesday staff cost is 38% of sales, the highest share of any trading day. A shift there is the clearest saving.");
    expect(alone.suggestedAction).toBeUndefined();
  });

  it("ranks the menu item on a week of its shortfall, not on the whole order history", () => {
    // £200.00 on one invoice beats the toastie's £98.55 a week, though its
    // shortfall over all four weeks of orders is £394.20.
    const invoice = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [{ item: "Milk", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 200, quantity: 200 }],
    });
    const brief = morningBrief({ ...base(), invoice, shifts: lowStaff });
    expect(brief.headline).toMatch(/^Milk is 100% above your agreed price, £200\.00 over/);
    expect(brief.more).toEqual([expect.stringMatching(/^Ham & Cheese Toastie sells well/)]);
  });

  it("spreads the menu shortfall over every week the record covers, closed days included", () => {
    // Orders run Tuesday 13 October to Saturday 7 November, 26 days, but the
    // record runs Monday 12 October to Sunday 8 November: four weeks. The
    // toastie is £98.55 a week, so a £100.00 overcharge outranks it.
    const invoice = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [{ item: "Milk", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 200, quantity: 100 }],
    });
    const brief = morningBrief({ ...base(), invoice });
    expect(brief.more).toEqual([
      expect.stringMatching(/^Milk is 100% above your agreed price, £100\.00 over/),
      expect.stringMatching(/^Ham & Cheese Toastie sells well/),
      expect.stringMatching(/^Tuesday staff cost/),
    ]);
  });

  it("puts a data issue above any overcharge, however large", () => {
    // £2,000.00 overbilled against £200.00 of staff on a day with no sales.
    const invoice = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [{ item: "Milk", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 200, quantity: 2000 }],
    });
    const brief = morningBrief({ ...base(), invoice, shifts: blankSalesDay, menu: healthyMenu });
    expect(brief.headline).toMatch(/^Data issue: Monday booked £200\.00 of staff cost/);
    expect(brief.more).toEqual([expect.stringMatching(/^Milk is 100% above your agreed price, £2,000\.00 over/)]);
  });

  it("keeps overcharge, staffing, menu order when the money a week is equal", () => {
    // £50.00 overbilled against Tuesday's £50.00 above 33% of its sales.
    const invoice = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [{ item: "Milk", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 200, quantity: 50 }],
    });
    const brief = morningBrief({ ...base(), invoice, shifts: ratioShifts, menu: healthyMenu });
    expect(brief.headline).toMatch(/^Milk is 100% above your agreed price, £50\.00 over/);
    expect(brief.more).toEqual([expect.stringMatching(/^Tuesday staff cost is 38% of sales/)]);
  });

  it("surfaces a newly-charged item even though its percentage is zero", () => {
    const brief = morningBrief({ ...base(), invoice: newChargeInvoice, shifts: lowStaff, menu: healthyMenu });
    expect(brief.headline).toBe("Delivery is being charged for the first time, £5.00 on this invoice. Worth a word with the supplier.");
  });

  it("flags a day with staff cost but no recorded sales as the worst", () => {
    const brief = morningBrief({ ...base(), invoice: cleanInvoice, shifts: blankSalesDay, menu: healthyMenu });
    expect(brief.headline).toContain("Monday");
    expect(brief.headline).toMatch(/no recorded sales/i);
  });

  it("suggests a price rise for the popular item furthest below its category's margin when invoice and staff are fine", () => {
    const brief = morningBrief({ ...base(), invoice: cleanInvoice, shifts: lowStaff });
    // The toastie earns 270p against food's 343p, the widest gap of any price_up item.
    expect(brief.headline).toBe(
      "Ham & Cheese Toastie sells well but earns £2.70 an item after food cost, below the £3.43 average for food. Raising the price would help.",
    );
    expect(brief.suggestedAction).toMatchObject({
      kind: "price_change",
      params: { sku: "ham_cheese_toastie", currentPriceMinor: 650, proposedPriceMinor: 715, currency: "GBP" },
    });
  });

  it("ranks overcharges on money, not percent", () => {
    const invoice = InvoiceSchema.parse({
      supplier: "S",
      invoiceId: "I",
      currency: "GBP",
      lines: [
        // 50% over but only 50p in total.
        { item: "Basil", agreedUnitPriceMinor: 100, invoicedUnitPriceMinor: 150, quantity: 1 },
        // 10% over but £10.00 in total.
        { item: "Coffee beans", agreedUnitPriceMinor: 1000, invoicedUnitPriceMinor: 1100, quantity: 10 },
      ],
    });
    const brief = morningBrief({ ...base(), invoice, shifts: lowStaff, menu: healthyMenu });
    expect(brief.headline).toBe(
      "Your latest invoice is £10.50 over the agreed prices across two lines. The biggest is coffee beans: 10% above your agreed price, £10.00 over. Worth a word with the supplier.",
    );
  });

  it("fires the staff-ratio headline at exactly 33% of sales and not just below", () => {
    const oneDay = (costMinor: number) =>
      ShiftsSchema.parse({
        currency: "GBP",
        days: [{ date: "2026-11-03", dayOfWeek: "Tuesday", salesMinor: 100000, transactions: 120, shifts: [{ staff: "A", slot: "morning", costMinor }] }],
      });
    const atBoundary = morningBrief({ ...base(), invoice: cleanInvoice, shifts: oneDay(33000), menu: healthyMenu });
    expect(atBoundary.headline).toBe("Tuesday staff cost is 33% of sales, the highest share of any trading day. A shift there is the clearest saving.");

    const justBelow = morningBrief({ ...base(), invoice: cleanInvoice, shifts: oneDay(32999), menu: healthyMenu });
    expect(justBelow.headline).toMatch(/nothing urgent/i);
  });

  it("says nothing is urgent when everything is healthy", () => {
    const brief = morningBrief({ ...base(), invoice: cleanInvoice, shifts: lowStaff, menu: healthyMenu });
    expect(brief.headline).toMatch(/nothing urgent/i);
    expect(brief.more).toEqual([]);
    expect(brief.suggestedAction).toBeUndefined();
  });
});

const day = (date: string, salesMinor: number, staff = true) => ({
  date,
  dayOfWeek: new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
  salesMinor,
  transactions: salesMinor === 0 ? 0 : 100,
  shifts: staff ? [{ staff: "A", slot: "morning", costMinor: 10000 }] : [],
});
const record = (...days: ReturnType<typeof day>[]) => ShiftsSchema.parse({ currency: "GBP", days });

describe("morningBrief sales line", () => {
  it("opens with the latest recorded day against the same weekday a week earlier", () => {
    // Saturday 7 November against the Halloween Saturday, then the Sunday till outage.
    // The Saturday before has the manager's Halloween note, quoted as written.
    expect(morningBrief(base()).sales).toBe(
      'Saturday\'s sales were £1,873.00, down 4% on the Saturday before (£1,960.00). The manager\'s note for Saturday 31 October: "Halloween. Fancy dress all afternoon, busiest Saturday in weeks." Sunday\'s sales were not recorded.',
    );
  });

  it("quotes a note only from the day compared against", () => {
    const noted = { ...day("2026-11-10", 112000), note: "Quiet, rain all day." };
    expect(morningBrief({ ...base(), shifts: record(day("2026-11-03", 100000), noted) }).sales).toBe(
      "Tuesday's sales were £1,120.00, up 12% on the Tuesday before (£1,000.00).",
    );
    const before = { ...day("2026-11-03", 100000), note: "Street market outside." };
    expect(morningBrief({ ...base(), shifts: record(before, day("2026-11-10", 112000)) }).sales).toBe(
      'Tuesday\'s sales were £1,120.00, up 12% on the Tuesday before (£1,000.00). The manager\'s note for Tuesday 3 November: "Street market outside."',
    );
  });

  it("says up when the day beat the week before", () => {
    const brief = morningBrief({ ...base(), shifts: record(day("2026-11-03", 100000), day("2026-11-10", 112000)) });
    expect(brief.sales).toBe("Tuesday's sales were £1,120.00, up 12% on the Tuesday before (£1,000.00).");
  });

  it("calls a change under half a percent level rather than up 0%", () => {
    const brief = morningBrief({ ...base(), shifts: record(day("2026-11-03", 100000), day("2026-11-10", 100400)) });
    expect(brief.sales).toBe("Tuesday's sales were £1,004.00, about level with the Tuesday before (£1,000.00).");
  });

  it("gives the figure alone when there is no same weekday a week earlier", () => {
    const brief = morningBrief({ ...base(), shifts: record(day("2026-11-09", 0, false), day("2026-11-10", 90000)) });
    expect(brief.sales).toBe("Tuesday's sales were £900.00.");
  });

  it("leaves the sales line out when no day has recorded sales", () => {
    const brief = morningBrief({ ...base(), shifts: record(day("2026-11-09", 0, false), day("2026-11-10", 0)) });
    expect(brief).not.toHaveProperty("sales");
    expect(brief.more).toContainEqual(expect.stringContaining("tomatoes"));
  });
});
