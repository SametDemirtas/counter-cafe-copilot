// The demo café: its menu held in memory, a gate wired to it, and a context
// loaded from the mock data.

import { type Currency } from "../domain/money.js";
import { loadOrders } from "../data/loader.js";
import { InvoiceSchema } from "../tools/invoice.js";
import { type MenuItem, MenuSchema } from "../tools/menu.js";
import { ShiftsSchema } from "../tools/days.js";
import { unknownRecipeStock } from "../tools/stock.js";
import { type Review, ReviewsSchema } from "../tools/reviews.js";
import {
  type ActionCatalog,
  type ActionGate,
  type ActionGateBundle,
  type ActionGateOptions,
  type ActionStore,
  type PriceList,
  createActionGate,
  defaultHandlers,
} from "../safety/index.js";
import cloverOrders from "../data/mock/clover-orders.json";
import menuJson from "../data/mock/menu.json";
import invoiceJson from "../data/mock/invoice.json";
import shiftsJson from "../data/mock/shifts.json";
import reviewsJson from "../data/mock/reviews.json";
import { type AgentContext } from "./context.js";
import { demoReviewClassifier } from "./review-classifier.js";

// The demo's menu, held in memory like the till's own: an approved price
// change is written here, and the gate, the tools and the brief all read it.
export class DemoMenu implements PriceList {
  private current: readonly MenuItem[];

  constructor(items: readonly MenuItem[] = MenuSchema.parse(menuJson)) {
    this.current = items;
  }

  items(): readonly MenuItem[] {
    return this.current;
  }

  name(sku: string): string | undefined {
    return this.current.find((m) => m.sku === sku)?.name;
  }

  setPrice(sku: string, priceMinor: number): void {
    if (!this.current.some((m) => m.sku === sku)) throw new Error(`No menu item with sku "${sku}"`);
    this.current = this.current.map((m) => (m.sku === sku ? { ...m, priceMinor } : m));
  }
}

// `staff` are the rota's names; with the reviewers' they are every person an
// autopilot reply must not name, other than the reviewer it answers.
export function catalogFrom(
  menu: readonly MenuItem[] | DemoMenu,
  reviews: readonly Review[],
  currency: Currency,
  staff: readonly string[] = [],
): ActionCatalog {
  const items = () => (menu instanceof DemoMenu ? menu.items() : menu);
  const byId = new Map(reviews.map((r) => [r.id, r] as const));
  const names = Object.freeze([...new Set([...reviews.map((r) => r.author), ...staff])]);
  return { currency, menuItem: (sku) => items().find((m) => m.sku === sku), review: (id) => byId.get(id), knownNames: () => names };
}

// The café trades in the currency its till records; the menu has no currency
// of its own, so the till's is the one prices are proposed in.
function demoCurrency(): Currency {
  return ShiftsSchema.parse(shiftsJson).currency;
}

function demoStaff(): string[] {
  return ShiftsSchema.parse(shiftsJson).days.flatMap((d) => d.shifts.map((s) => s.staff));
}

// Each demo gate's menu, so loadDemoContext reads the same prices the gate
// writes without every caller passing the menu along.
const menus = new WeakMap<ActionGate, DemoMenu>();

// The gate checks proposals against the same menu and reviews the agent reads,
// and an executed price change updates that menu. Unless told otherwise it
// classifies reviews with the hand-labelled demo table, which knows only the
// seven mock reviews.
export function createDemoGate(overrides: Omit<Partial<ActionGateOptions>, "catalog"> = {}): ActionGateBundle {
  const menu = new DemoMenu();
  const catalog = catalogFrom(menu, ReviewsSchema.parse(reviewsJson), demoCurrency(), demoStaff());
  const bundle = createActionGate({ handlers: defaultHandlers(menu), classifier: demoReviewClassifier, ...overrides, catalog });
  menus.set(bundle.gate, menu);
  return bundle;
}

export function loadDemoContext(gate: ActionGate, store: ActionStore): AgentContext {
  const shifts = ShiftsSchema.parse(shiftsJson);
  const menu = menus.get(gate) ?? new DemoMenu();
  const invoice = InvoiceSchema.parse(invoiceJson);
  const unknown = unknownRecipeStock(invoice, menu.items());
  if (unknown.length > 0) throw new Error(`The invoice names stock no menu item uses: ${unknown.join(", ")}`);
  return {
    orders: loadOrders("clover", cloverOrders),
    // A getter, so a price approved after this context was made is still seen.
    get menu() {
      return menu.items();
    },
    invoice,
    shifts,
    reviews: ReviewsSchema.parse(reviewsJson),
    currency: shifts.currency,
    // Wrapped so tools can't reach approve/execute at runtime, not just in types.
    gate: { propose: (spec) => gate.propose(spec) },
    store: {
      get: (id) => {
        const record = store.get(id);
        return record ? Object.freeze({ proposal: record.proposal, status: record.status }) : undefined;
      },
    },
  };
}
