import { describe, expect, it } from "vitest";

import { decisionLabels, outcomeText, unsentAfterError } from "../../lib/web/public/queue-state.js";

const reply = { kind: "review_reply" };
const price = { kind: "price_change" };

describe("a proposal card's words", () => {
  it("offers approve and reject on a pending card", () => {
    expect(decisionLabels(price, false)).toEqual({ approve: "Approve", reject: "Reject" });
  });

  it("turns into try again and withdraw after a failed send (502), and stays so", () => {
    expect(unsentAfterError(502, false)).toBe(true);
    expect(unsentAfterError(409, false)).toBe(false);
    expect(unsentAfterError(409, true)).toBe(true);
    expect(decisionLabels(price, true)).toEqual({ approve: "Try again", reject: "Withdraw" });
    expect(decisionLabels({ ...reply, autopilot: true }, true)).toEqual({ approve: "Send it myself", reject: "Withdraw" });
  });

  it("says a withdrawn send sent nothing, and a rejection changed nothing", () => {
    expect(outcomeText(reply, { status: "rejected" }, true)).toBe("Withdrawn. Nothing was sent.");
    expect(outcomeText(price, { status: "rejected" }, false)).toBe("Rejected. Nothing changed.");
  });

  it("says a reply was posted and a price applied", () => {
    expect(outcomeText(reply, { status: "executed" }, false)).toBe("Approved and posted.");
    expect(outcomeText(price, { status: "executed" }, false)).toBe("Approved and applied.");
  });
});
