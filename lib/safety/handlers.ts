// Handlers don't re-check approval; the gate only calls them after it.

import { type Currency, formatMoney, money } from "../domain/money.js";
import { type ActionKind, type ActionSpec } from "./types.js";

export interface AppliedChange {
  readonly kind: ActionKind;
  readonly actionId: string;
  readonly description: string;
}

// Stand-in for the POS / reviews API.
export interface EffectSink {
  apply(change: AppliedChange): void;
  applied(): readonly AppliedChange[];
}

export class InMemoryEffectSink implements EffectSink {
  private readonly changes: AppliedChange[] = [];

  // Idempotent on actionId so a retry after a partial failure can't apply twice.
  apply(change: AppliedChange): void {
    if (this.changes.some((c) => c.actionId === change.actionId)) return;
    this.changes.push(change);
  }

  applied(): readonly AppliedChange[] {
    return [...this.changes];
  }
}

export interface ActionHandler {
  readonly kind: ActionKind;
  execute(actionId: string, spec: ActionSpec, sink: EffectSink): string;
}

// The menu the till and the agent read prices from. An executed price change
// is written here, so the next question and the next proposal see the new price.
export interface PriceList {
  name(sku: string): string | undefined;
  setPrice(sku: string, priceMinor: number): void;
}

export function priceChangeHandlerFor(prices?: PriceList): ActionHandler {
  return {
    kind: "price_change",
    execute(actionId, spec, sink): string {
      if (spec.kind !== "price_change") {
        throw new Error(`priceChangeHandler received a ${spec.kind} spec`);
      }
      const { sku, proposedPriceMinor } = spec.params;
      const currency: Currency = spec.params.currency;
      const to = formatMoney(money(proposedPriceMinor, currency));
      const description = `Set ${prices?.name(sku) ?? sku} price to ${to}`;
      sink.apply({ kind: "price_change", actionId, description });
      prices?.setPrice(sku, proposedPriceMinor);
      return description;
    },
  };
}

// Without a price list: records the change in the sink only.
export const priceChangeHandler: ActionHandler = priceChangeHandlerFor();

export const reviewReplyHandler: ActionHandler = {
  kind: "review_reply",
  execute(actionId, spec, sink): string {
    if (spec.kind !== "review_reply") {
      throw new Error(`reviewReplyHandler received a ${spec.kind} spec`);
    }
    const description = `Posted reply to review ${spec.params.reviewId}`;
    sink.apply({ kind: "review_reply", actionId, description });
    return description;
  },
};

export class HandlerRegistry {
  private readonly handlers = new Map<ActionKind, ActionHandler>();

  register(handler: ActionHandler): this {
    this.handlers.set(handler.kind, handler);
    return this;
  }

  get(kind: ActionKind): ActionHandler {
    const handler = this.handlers.get(kind);
    if (!handler) throw new Error(`No handler registered for action kind "${kind}"`);
    return handler;
  }
}

export function defaultHandlers(prices?: PriceList): HandlerRegistry {
  return new HandlerRegistry().register(prices ? priceChangeHandlerFor(prices) : priceChangeHandler).register(reviewReplyHandler);
}
