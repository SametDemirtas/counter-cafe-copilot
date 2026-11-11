import { type Currency, type Money, money } from "./money.js";

export type ProviderId = "clover" | "square";

export interface CanonicalModifier {
  readonly name: string;
  // Per unit of the parent item.
  readonly unitPrice: Money;
}

export interface CanonicalLineItem {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  // Excludes modifiers.
  readonly unitPrice: Money;
  // Kept sorted so line identity doesn't depend on provider ordering.
  readonly modifiers: readonly CanonicalModifier[];
}

export interface CanonicalOrder {
  readonly id: string;
  readonly provider: ProviderId;
  readonly placedAt: string; // ISO-8601
  readonly currency: Currency;
  readonly lineItems: readonly CanonicalLineItem[];
}

export function modifier(name: string, amountMinor: number, currency: Currency): CanonicalModifier {
  return { name, unitPrice: money(amountMinor, currency) };
}

function compareModifiers(a: CanonicalModifier, b: CanonicalModifier): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.unitPrice.amountMinor - b.unitPrice.amountMinor;
}

function sortModifiers(modifiers: readonly CanonicalModifier[]): CanonicalModifier[] {
  return [...modifiers].sort(compareModifiers);
}

export function lineItem(args: {
  sku: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  currency: Currency;
  modifiers: readonly CanonicalModifier[];
}): CanonicalLineItem {
  if (!Number.isSafeInteger(args.quantity) || args.quantity <= 0) {
    throw new RangeError(`Line quantity must be a positive safe integer, received ${args.quantity}`);
  }
  return {
    sku: args.sku,
    name: args.name,
    quantity: args.quantity,
    unitPrice: money(args.unitPriceMinor, args.currency),
    modifiers: sortModifiers(args.modifiers),
  };
}

// JSON.stringify so a delimiter inside a modifier name can't cause key collisions.
function lineKey(item: CanonicalLineItem): string {
  const mods = sortModifiers(item.modifiers).map((m) => [m.name, m.unitPrice.amountMinor]);
  return JSON.stringify([item.sku, item.unitPrice.amountMinor, mods]);
}

// Lines differing only in display name merge; the first name seen wins.
export function mergeAndSortLineItems(
  items: readonly CanonicalLineItem[],
): CanonicalLineItem[] {
  const merged = new Map<string, CanonicalLineItem>();
  for (const item of items) {
    const key = lineKey(item);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      continue;
    }
    const quantity = existing.quantity + item.quantity;
    if (!Number.isSafeInteger(quantity)) {
      throw new RangeError(`Merged quantity out of safe-integer range for sku ${item.sku}`);
    }
    merged.set(key, { ...existing, quantity });
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item);
}

export function freezeOrder(order: CanonicalOrder): CanonicalOrder {
  for (const item of order.lineItems) {
    for (const mod of item.modifiers) {
      Object.freeze(mod.unitPrice);
      Object.freeze(mod);
    }
    Object.freeze(item.modifiers);
    Object.freeze(item.unitPrice);
    Object.freeze(item);
  }
  Object.freeze(order.lineItems);
  return Object.freeze(order);
}

export function unitsSoldBySku(orders: readonly CanonicalOrder[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const order of orders) {
    for (const item of order.lineItems) {
      counts.set(item.sku, (counts.get(item.sku) ?? 0) + item.quantity);
    }
  }
  return counts;
}
