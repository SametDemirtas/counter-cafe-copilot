import { z } from "zod";

import { type Currency, CurrencySchema, addMoney, money, zero } from "../domain/money.js";
import { StockNameSchema } from "./menu.js";

// Where a line's stock goes on the menu, recorded with the invoice line rather
// than inferred from the supplier's wording: a recipe ingredient (a menu stock
// name), a paid option the till sells as a modifier, or nothing on the menu
// (a delivery surcharge). A line without it is unmapped, and its menu items are
// unknown rather than none.
export const LineSupplySchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("recipe"), stock: StockNameSchema }),
  z.object({ via: z.literal("option"), modifier: z.string().min(1) }),
  z.object({ via: z.literal("none") }),
]);
export type LineSupply = z.infer<typeof LineSupplySchema>;

export const InvoiceLineSchema = z.object({
  item: z.string(),
  agreedUnitPriceMinor: z.number().int().nonnegative().safe(),
  invoicedUnitPriceMinor: z.number().int().nonnegative().safe(),
  quantity: z.number().int().positive().safe(),
  supplies: LineSupplySchema.optional(),
});

// Variance is unit-agnostic, so currency only labels the money totals.
export const InvoiceSchema = z.object({
  supplier: z.string(),
  invoiceId: z.string(),
  currency: CurrencySchema,
  lines: z.array(InvoiceLineSchema).nonempty(),
});

export type Invoice = z.infer<typeof InvoiceSchema>;

export interface InvoiceLineVariance {
  readonly item: string;
  readonly agreedUnitPriceMinor: number;
  readonly invoicedUnitPriceMinor: number;
  readonly quantity: number;
  // Null when the line is unmapped.
  readonly supplies: LineSupply | null;
  // 0 when the agreed price is 0; `flagged` covers that case.
  readonly variancePct: number;
  readonly overchargeMinor: number;
  // Also true for a previously free item now charged, which no percentage can express.
  readonly flagged: boolean;
}

// A line more than this fraction over its agreed price is flagged.
export const INVOICE_FLAG_THRESHOLD = 0.05;

export interface InvoiceVarianceOptions {
  // Fraction over the agreed price before a line is flagged; small drift is ignored.
  readonly thresholdPct?: number;
}

export function invoiceVariance(
  invoice: Invoice,
  options: InvoiceVarianceOptions = {},
): InvoiceLineVariance[] {
  const threshold = options.thresholdPct ?? INVOICE_FLAG_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError(`thresholdPct must be a non-negative number, received ${threshold}`);
  }
  return invoice.lines
    .map((line) => {
      const diff = line.invoicedUnitPriceMinor - line.agreedUnitPriceMinor;
      const variancePct =
        line.agreedUnitPriceMinor === 0 ? 0 : diff / line.agreedUnitPriceMinor;
      const flagged =
        line.agreedUnitPriceMinor === 0
          ? line.invoicedUnitPriceMinor > 0
          : variancePct > threshold;
      return {
        item: line.item,
        agreedUnitPriceMinor: line.agreedUnitPriceMinor,
        invoicedUnitPriceMinor: line.invoicedUnitPriceMinor,
        quantity: line.quantity,
        supplies: line.supplies ?? null,
        variancePct,
        overchargeMinor: safeProduct(diff, line.quantity),
        flagged,
      };
    })
    // Flagged first, so a newly charged item (0% variance) isn't buried.
    .sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.variancePct - a.variancePct);
}

export interface InvoiceSummary {
  readonly currency: Currency;
  readonly lines: readonly InvoiceLineVariance[];
  // Both cover the flagged lines only. A flagged line is always charged above
  // its agreed price, so the total is what the invoice overbills.
  readonly flaggedCount: number;
  readonly totalOverchargeMinor: number;
}

// The one place the invoice's totals are added up, through Money so the sum
// keeps the safe-integer guarantee.
export function invoiceSummary(invoice: Invoice, options: InvoiceVarianceOptions = {}): InvoiceSummary {
  const lines = invoiceVariance(invoice, options);
  const flagged = lines.filter((l) => l.flagged);
  const total = flagged.reduce((sum, l) => addMoney(sum, money(l.overchargeMinor, invoice.currency)), zero(invoice.currency));
  return { currency: invoice.currency, lines, flaggedCount: flagged.length, totalOverchargeMinor: total.amountMinor };
}

function safeProduct(a: number, b: number): number {
  const product = a * b;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`Invoice line total ${a} x ${b} exceeds the safe integer range`);
  }
  return product;
}
