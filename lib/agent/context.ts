import { type Currency } from "../domain/money.js";
import { type CanonicalOrder } from "../domain/order.js";
import { type Invoice } from "../tools/invoice.js";
import { type MenuItem } from "../tools/menu.js";
import { type Shifts } from "../tools/days.js";
import { type Review } from "../tools/reviews.js";
import { type ActionSpec, type ActionStatus, type ProposedAction } from "../safety/index.js";

export interface ProposalPort {
  propose(spec: ActionSpec): ProposedAction;
}

// Deliberately omits the grant token and approver.
export interface AgentActionView {
  readonly proposal: ProposedAction;
  readonly status: ActionStatus;
}

export interface ReadonlyActionStore {
  get(id: string): AgentActionView | undefined;
}

export interface AgentContext {
  readonly orders: readonly CanonicalOrder[];
  readonly menu: readonly MenuItem[];
  readonly invoice: Invoice;
  readonly shifts: Shifts;
  readonly reviews: readonly Review[];
  readonly currency: Currency;
  readonly gate: ProposalPort;
  readonly store: ReadonlyActionStore;
}
