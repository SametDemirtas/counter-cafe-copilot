import { type CanonicalOrder, type ProviderId } from "../domain/order.js";
import { cloverAdapter } from "./providers/clover.js";
import { squareAdapter } from "./providers/square.js";
import { type ProviderAdapter } from "./providers/types.js";

// Typed against ProviderId, so adding a provider without an adapter fails to compile.
const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  clover: cloverAdapter,
  square: squareAdapter,
};

export function adapterFor(provider: string): ProviderAdapter {
  // Own keys only, so an inherited name like "toString" is not a provider.
  if (!Object.hasOwn(ADAPTERS, provider)) throw new Error(`Unknown provider "${provider}"`);
  return ADAPTERS[provider as ProviderId];
}

// One malformed order fails the whole load rather than being silently dropped.
export function loadOrders(provider: string, rawOrders: readonly unknown[]): CanonicalOrder[] {
  const adapter = adapterFor(provider);
  return rawOrders.map((raw) => adapter.toCanonical(raw));
}
