import { describe, expect, it } from "vitest";

import {
  addMoney,
  formatMoney,
  money,
  subtractMoney,
} from "../lib/domain/money.js";

describe("money()", () => {
  it("accepts an integer number of minor units", () => {
    expect(money(320, "GBP")).toEqual({ amountMinor: 320, currency: "GBP" });
  });

  it("rejects a fractional amount", () => {
    expect(() => money(3.2, "GBP")).toThrow(RangeError);
  });

  it("rejects an amount past the safe-integer range", () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "GBP")).toThrow(RangeError);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts within one currency", () => {
    expect(addMoney(money(320, "GBP"), money(40, "GBP")).amountMinor).toBe(360);
    expect(subtractMoney(money(320, "GBP"), money(40, "GBP")).amountMinor).toBe(280);
  });

  it("refuses to mix currencies when adding or subtracting", () => {
    expect(() => addMoney(money(100, "GBP"), money(100, "EUR"))).toThrow(/Currency mismatch: GBP and EUR/);
    expect(() => subtractMoney(money(100, "GBP"), money(100, "EUR"))).toThrow(/Currency mismatch: GBP and EUR/);
  });

});

describe("formatMoney", () => {
  it("formats whole and sub-unit amounts", () => {
    expect(formatMoney(money(320, "GBP"))).toBe("£3.20");
    expect(formatMoney(money(5, "GBP"))).toBe("£0.05");
    expect(formatMoney(money(100, "EUR"))).toBe("€1.00");
    expect(formatMoney(money(250, "USD"))).toBe("$2.50");
    expect(formatMoney(money(180000, "GBP"))).toBe("£1,800.00");
    expect(formatMoney(money(123456789, "GBP"))).toBe("£1,234,567.89");
    expect(formatMoney(money(99999, "GBP"))).toBe("£999.99");
  });

  it("formats a negative amount", () => {
    expect(formatMoney(money(-100, "GBP"))).toBe("-£1.00");
  });
});
