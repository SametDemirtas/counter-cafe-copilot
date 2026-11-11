import { type CanonicalOrder } from "../domain/order.js";
import { type Invoice, type LineSupply } from "./invoice.js";
import { type MenuItem } from "./menu.js";

// Recipe stock an invoice line names that no menu item uses. Checked when the
// data loads, so a misspelt "tomatos" fails there instead of reading as a line
// that supplies nothing on the menu. An option is not checked this way: an
// option the till has not sold yet is real.
export function unknownRecipeStock(invoice: Invoice, menu: readonly MenuItem[]): string[] {
  const used = new Set(menu.flatMap((m) => m.ingredients));
  return invoice.lines.flatMap((l) => (l.supplies?.via === "recipe" && !used.has(l.supplies.stock) ? [l.supplies.stock] : []));
}

function skusSoldWith(modifierName: string, orders: readonly CanonicalOrder[]): Set<string> {
  const skus = new Set<string>();
  for (const order of orders) {
    for (const line of order.lineItems) {
      if (line.modifiers.some((m) => m.name === modifierName)) skus.add(line.sku);
    }
  }
  return skus;
}

// The display names of the menu items an invoice line supplies, in menu order:
// those whose recipe uses its stock, or those the till has sold with it as an
// option. Empty when the line supplies nothing on the menu; null when the line
// is unmapped, so an unknown line is never reported as supplying nothing.
export function menuItemsSupplied(
  supplies: LineSupply | null,
  menu: readonly MenuItem[],
  orders: readonly CanonicalOrder[],
): string[] | null {
  if (supplies === null) return null;
  switch (supplies.via) {
    case "none":
      return [];
    case "recipe":
      return menu.filter((m) => m.ingredients.includes(supplies.stock)).map((m) => m.name);
    case "option": {
      const skus = skusSoldWith(supplies.modifier, orders);
      return menu.filter((m) => skus.has(m.sku)).map((m) => m.name);
    }
  }
}
