import { z } from "zod";

import { type CanonicalOrder, unitsSoldBySku } from "../domain/order.js";
import { roundTo } from "../domain/round.js";

// Items are ranked against their own category: a drink cannot match a lunch
// plate's margin in pence, and should not have to.
export const MenuCategorySchema = z.enum(["espresso_bar", "cold_drinks", "tea_and_other_hot", "bakery", "food"]);
export type MenuCategory = z.infer<typeof MenuCategorySchema>;

export const MENU_CATEGORY_NAMES: Record<MenuCategory, string> = {
  espresso_bar: "espresso bar drinks",
  cold_drinks: "cold drinks",
  tea_and_other_hot: "tea and other hot drinks",
  bakery: "bakery",
  food: "food",
};

// A stock name the menu's recipes and the invoice's lines share, e.g. "coffee_beans".
export const StockNameSchema = z.string().regex(/^[a-z][a-z_]*$/, "a stock name is snake_case");

export const MenuItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: MenuCategorySchema,
  priceMinor: z.number().int().positive().safe(),
  foodCostMinor: z.number().int().nonnegative().safe(),
  // Stock names the recipe draws on, e.g. "coffee_beans", "whole_milk".
  ingredients: z
    .array(StockNameSchema)
    .nonempty()
    .refine((xs) => new Set(xs).size === xs.length, { message: "an ingredient may appear only once per item" }),
})
  // The gate refuses a price at or below food cost, so the menu may not hold one
  // either. It keeps every margin positive, which the labels below rely on.
  .refine((item) => item.foodCostMinor < item.priceMinor, { message: "an item's food cost must be below its price" });

// A duplicate SKU would be classified twice, each copy credited with every sale.
export const MenuSchema = z
  .array(MenuItemSchema)
  .nonempty()
  .refine((items) => new Set(items.map((i) => i.sku)).size === items.length, {
    message: "menu SKUs must be unique",
  });

export type MenuItem = z.infer<typeof MenuItemSchema>;

// The Kasavana-Smith menu-engineering matrix, run within each category and
// named for the action each quadrant calls for: star (popular, high margin),
// price_up (popular, low margin: raise the price), promote (unpopular, high
// margin: promote or reposition). An unpopular, low-margin item is retire only
// when it needs stock nothing else uses, since taking it off saves that stock,
// its waste and its prep. When every ingredient is shared, dropping it saves
// nothing and only loses its sales, so it is keep.
export type MenuLabel = "star" | "price_up" | "promote" | "keep" | "retire";

export interface MenuClassification {
  readonly sku: string;
  readonly name: string;
  readonly category: MenuCategory;
  readonly priceMinor: number;
  readonly foodCostMinor: number;
  // Price minus food cost, per unit.
  readonly contributionMarginMinor: number;
  // A fraction in (0, 1], not a percentage; above 0 because food cost is below price.
  readonly grossMarginPct: number;
  readonly unitsSold: number;
  // Ingredients no other menu item uses: what taking this item off would save.
  readonly dedicatedIngredients: readonly string[];
  readonly label: MenuLabel;
}

export interface CategoryBenchmark {
  readonly category: MenuCategory;
  // The category's contribution margin per unit, weighted by units sold and
  // rounded to whole pence; null when nothing in it sold. High is judged
  // against marginLineMinor, not this.
  readonly averageContributionMarginMinor: number | null;
  // The contribution margin an item needs to count as high: the average less
  // the tolerance, rounded up to whole pence. Null when nothing in it sold.
  readonly marginLineMinor: number | null;
  // Units an item must sell to count as popular in its category, to two
  // places; classification compares against this same rounded value.
  readonly popularityLineUnits: number;
}

export interface MenuEngineering {
  readonly items: readonly MenuClassification[];
  readonly categories: readonly CategoryBenchmark[];
}

// How far below a category's average margin still counts as high, as a fraction.
export const MARGIN_TOLERANCE = 0.05;

export interface ClassifyMenuOptions {
  // Popular means selling at least this fraction of the category's average
  // units per item. 0.7 is the line Kasavana and Smith use, and being relative
  // it holds for a week of orders or a month.
  readonly popularityFactor?: number;
  // A margin within this fraction below the category average still counts as
  // high. A few pence either side of an average is noise in food costs, not a
  // reason to tell the owner to reprice a drink that sells well.
  readonly marginTolerance?: number;
}

const marginOf = (item: MenuItem) => item.priceMinor - item.foodCostMinor;

function benchmark(
  category: MenuCategory,
  items: readonly MenuItem[],
  unitsOf: (item: MenuItem) => number,
  popularityFactor: number,
  marginTolerance: number,
): CategoryBenchmark {
  const units = items.reduce((sum, item) => sum + unitsOf(item), 0);
  const marginMinor = items.reduce((sum, item) => sum + marginOf(item) * unitsOf(item), 0);
  if (!Number.isSafeInteger(marginMinor)) {
    throw new RangeError(`Contribution margin for ${category} exceeds the safe integer range`);
  }
  const average = units === 0 ? null : Math.round(marginMinor / units);
  return {
    category,
    averageContributionMarginMinor: average,
    marginLineMinor: average === null ? null : Math.ceil(average * (1 - marginTolerance)),
    popularityLineUnits: roundTo((popularityFactor * units) / items.length, 2),
  };
}

// Margin is judged in pence, not percent: a dish at 56% that earns £4.40 an
// item does more for the till than one at 90% that earns £2.25. An item alone
// in its category is its own benchmark, so it is a star once it sells; in a
// category where nothing sold, every item is retire or keep.
export function classifyMenu(
  menu: readonly MenuItem[],
  orders: readonly CanonicalOrder[],
  options: ClassifyMenuOptions = {},
): MenuEngineering {
  const popularityFactor = options.popularityFactor ?? 0.7;
  const marginTolerance = options.marginTolerance ?? MARGIN_TOLERANCE;
  if (!Number.isFinite(popularityFactor) || popularityFactor < 0) {
    throw new RangeError(`popularityFactor must be a non-negative number, received ${popularityFactor}`);
  }
  if (!Number.isFinite(marginTolerance) || marginTolerance < 0 || marginTolerance >= 1) {
    throw new RangeError(`marginTolerance must be at least 0 and below 1, received ${marginTolerance}`);
  }
  const unitsBySku = unitsSoldBySku(orders);
  const unitsOf = (item: MenuItem) => unitsBySku.get(item.sku) ?? 0;

  const byCategory = new Map<MenuCategory, MenuItem[]>();
  for (const item of menu) byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item]);
  const categories = [...byCategory].map(([category, items]) => benchmark(category, items, unitsOf, popularityFactor, marginTolerance));
  const benchmarkOf = new Map(categories.map((c) => [c.category, c]));
  const itemsUsing = new Map<string, number>();
  for (const item of menu) for (const ing of item.ingredients) itemsUsing.set(ing, (itemsUsing.get(ing) ?? 0) + 1);

  const items = menu.map((item): MenuClassification => {
    const { marginLineMinor, popularityLineUnits } = benchmarkOf.get(item.category)!;
    const unitsSold = unitsOf(item);
    const contributionMarginMinor = marginOf(item);
    // An item nobody bought is never popular, even when nothing sold at all.
    const popular = unitsSold > 0 && unitsSold >= popularityLineUnits;
    const highMargin = marginLineMinor !== null && contributionMarginMinor >= marginLineMinor;
    const dedicatedIngredients = item.ingredients.filter((ing) => itemsUsing.get(ing) === 1);
    const label: MenuLabel = popular
      ? highMargin
        ? "star"
        : "price_up"
      : highMargin
        ? "promote"
        : dedicatedIngredients.length > 0
          ? "retire"
          : "keep";
    return {
      sku: item.sku,
      name: item.name,
      category: item.category,
      priceMinor: item.priceMinor,
      foodCostMinor: item.foodCostMinor,
      contributionMarginMinor,
      grossMarginPct: contributionMarginMinor / item.priceMinor,
      unitsSold,
      dedicatedIngredients,
      label,
    };
  });
  return { items, categories };
}
