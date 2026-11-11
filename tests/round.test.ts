import { describe, expect, it } from "vitest";

import { percentOf } from "../lib/domain/percent.js";
import { roundTo } from "../lib/domain/round.js";

describe("roundTo", () => {
  it("rounds half away from zero, absorbing float noise", () => {
    expect(roundTo(14.5, 0)).toBe(15);
    // 0.145 * 100 is 14.499999999999998 in floating point.
    expect(roundTo(0.145 * 100, 0)).toBe(15);
    expect(roundTo(2.345, 2)).toBe(2.35);
    expect(roundTo(14.4, 0)).toBe(14);
  });

  it("rounds a negative value the same way as its magnitude", () => {
    expect(roundTo(-14.5, 0)).toBe(-15);
    expect(roundTo(-2.345, 2)).toBe(-2.35);
    expect(roundTo(-14.4, 0)).toBe(-14);
  });

  it("rounds to tens, hundreds and so on with a negative count", () => {
    expect(roundTo(1234, -2)).toBe(1200);
    expect(roundTo(1250, -2)).toBe(1300);
    expect(roundTo(-1250, -2)).toBe(-1300);
    expect(roundTo(5, -1)).toBe(10);
  });
});

describe("percentOf", () => {
  it("turns a fraction into a percentage at the precision asked for", () => {
    expect(percentOf(0.1778, 1)).toBe(17.8);
    expect(percentOf(0.178)).toBe(18);
    expect(percentOf(-0.1)).toBe(-10);
  });
});
