// Integer minor units (pence) only, so sums never pick up float rounding error.

import { z } from "zod";

export const CURRENCY_SYMBOLS = { GBP: "£", EUR: "€", USD: "$" } as const;
export type Currency = keyof typeof CURRENCY_SYMBOLS;
export const CurrencySchema = z.enum(["GBP", "EUR", "USD"]) satisfies z.ZodType<Currency>;

export interface Money {
  readonly amountMinor: number;
  readonly currency: Currency;
}

// Safe-integer check: past 2^53 precision is lost silently.
export function money(amountMinor: number, currency: Currency): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(
      `Money must be a safe integer number of minor units, received ${amountMinor}`,
    );
  }
  return { amountMinor, currency };
}

export function zero(currency: Currency): Money {
  return money(0, currency);
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function formatMoney(m: Money): string {
  const symbol = CURRENCY_SYMBOLS[m.currency];
  const sign = m.amountMinor < 0 ? "-" : "";
  const abs = Math.abs(m.amountMinor);
  const major = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+$)/g, ",");
  const minor = (abs % 100).toString().padStart(2, "0");
  return `${sign}${symbol}${major}.${minor}`;
}

// For text: a pence amount straight from a tool field, e.g. 180000 -> "£1,800.00".
export function formatMinor(amountMinor: number, currency: Currency): string {
  return formatMoney(money(amountMinor, currency));
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} and ${b.currency}`);
  }
}
