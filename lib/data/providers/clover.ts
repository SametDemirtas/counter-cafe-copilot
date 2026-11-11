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

// Clover emits one line item per unit with no quantity; mergeAndSortLineItems folds them.

const CloverModification = z.object({
  name: z.string().min(1),
  amount: z.number().int(), // per unit
});

const CloverLineItem = z.object({
  id: z.string(),
  item: z.object({ id: z.string().min(1) }), // the SKU
  name: z.string().min(1),
  price: z.number().int().nonnegative(),
  modifications: z.object({ elements: z.array(CloverModification) }).optional(),
  refunded: z.boolean().optional(),
  exchanged: z.boolean().optional(),
});

const CloverOrderSchema = z.object({
  id: z.string(),
  createdTime: z.number().int().positive().lte(MAX_EPOCH_MS),
  currency: CurrencySchema,
  lineItems: z.object({ elements: z.array(CloverLineItem).nonempty() }),
});

export const cloverAdapter: ProviderAdapter = {
  id: "clover",
  toCanonical(raw: unknown): CanonicalOrder {
    const order = CloverOrderSchema.parse(raw);
    const currency: Currency = order.currency;

    // Refunded or exchanged units weren't sold, so they don't count. A fully
    // refunded order is kept as a real order with no units sold.
    const sold = order.lineItems.elements.filter((li) => !li.refunded && !li.exchanged);
    const perUnit = sold.map((li) =>
      lineItem({
        sku: li.item.id,
        name: li.name,
        quantity: 1,
        unitPriceMinor: li.price,
        currency,
        modifiers: (li.modifications?.elements ?? []).map((m) =>
          modifier(m.name, m.amount, currency),
        ),
      }),
    );

    return freezeOrder({
      id: order.id,
      provider: "clover",
      placedAt: new Date(order.createdTime).toISOString(),
      currency,
      lineItems: mergeAndSortLineItems(perUnit),
    });
  },
};
