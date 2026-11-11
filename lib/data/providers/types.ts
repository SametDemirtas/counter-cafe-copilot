import { type CanonicalOrder, type ProviderId } from "../../domain/order.js";

// Year 2100 in epoch ms; both adapters reject timestamps outside (0, this].
export const MAX_EPOCH_MS = 4102444800000;

// toCanonical must throw on a bad payload, never return a half-built order.
export interface ProviderAdapter {
  readonly id: ProviderId;
  toCanonical(raw: unknown): CanonicalOrder;
}
