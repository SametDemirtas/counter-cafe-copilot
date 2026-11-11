// Wording helpers shared by the demo brain's templates.

import { formatMinor } from "../domain/money.js";

export { subject } from "../agent/text.js";

// The demo café trades in GBP; the real-model path reads currency from context.
export const DEMO_CURRENCY = "GBP" as const;

export const gbp = (minor: number): string => formatMinor(minor, DEMO_CURRENCY);

export function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function plural(xs: readonly unknown[], one: string, many: string): string {
  return xs.length > 1 ? many : one;
}

// "31 October", from an ISO date.
export function longDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}
