import { z } from "zod";

import {
  type CanonicalOrder,
  freezeOrder,
  lineItem,
  mergeAndSortLineItems,
  modifier,
} from "../../domain/order.js";
import { type Currency, CurrencySchema } from "../../domain/money.js";
import { MAX_EPOCH_MS, type ProviderAdapter } from "./types.js";

// Square can split one product across several lines; mergeAndSortLineItems folds them.

// No real café line has more units than this; treat larger as malformed.
const MAX_QUANTITY = 100000;

const SquareMoney = z.object({ amount: z.number().int(), currency: CurrencySchema });

// Amount may be negative (discount). A modifier with quantity other than 1 is
// rejected rather than silently priced once.
const SquareModifier = z
  .object({
    name: z.string().min(1),
    base_price_money: SquareMoney,
    quantity: z.string().optional(),
  })
  .refine((m) => m.quantity === undefined || m.quantity === "1", {
    message: "Square modifiers with a quantity other than 1 are not supported",
  });

const SquareBasePrice = z.object({ amount: z.number().int().nonnegative(), currency: CurrencySchema });

const SquareLineItem = z.object({
  uid: z.string(),
  name: z.string().min(1),
  quantity: z.string(),
  // Required: falling back to uid would split one SKU's sales across lines.
  catalog_object_id: z.string().min(1),
  base_price_money: SquareBasePrice,
  modifiers: z.array(SquareModifier).optional(),
});

const SquareOrderSchema = z.object({
  id: z.string(),
  created_at: z
    .string()
    .datetime()
    .refine((s) => {
      const ms = Date.parse(s);
      return ms > 0 && ms <= MAX_EPOCH_MS;
    }, "created_at is outside the supported date range"),
  line_items: z.array(SquareLineItem).nonempty(),
});

function parseQuantity(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`Square quantity must be a whole-number string, received "${value}"`);
  }
  const quantity = Number.parseInt(value, 10);
  if (quantity <= 0 || quantity > MAX_QUANTITY) {
    throw new RangeError(`Square quantity out of range, received "${value}"`);
  }
  return quantity;
}

function assertCurrency(found: Currency, expected: Currency): void {
  if (found !== expected) {
    throw new Error(`Mixed currencies in one Square order: ${expected} and ${found}`);
  }
}

export const squareAdapter: ProviderAdapter = {
  id: "square",
  toCanonical(raw: unknown): CanonicalOrder {
    const order = SquareOrderSchema.parse(raw);
    const currency: Currency = order.line_items[0].base_price_money.currency;

    const items = order.line_items.map((li) => {
      assertCurrency(li.base_price_money.currency, currency);
      return lineItem({
        sku: li.catalog_object_id,
        name: li.name,
        quantity: parseQuantity(li.quantity),
        unitPriceMinor: li.base_price_money.amount,
        currency,
        modifiers: (li.modifiers ?? []).map((m) => {
          assertCurrency(m.base_price_money.currency, currency);
          return modifier(m.name, m.base_price_money.amount, currency);
        }),
      });
    });

    return freezeOrder({
      id: order.id,
      provider: "square",
      placedAt: new Date(order.created_at).toISOString(),
      currency,
      lineItems: mergeAndSortLineItems(items),
    });
  },
};
