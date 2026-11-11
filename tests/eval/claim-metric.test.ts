import { describe, expect, it } from "vitest";

import { falseProposalClaim } from "../../lib/eval/claim-metric.js";

describe("falseProposalClaim", () => {
  const claim = "I've created the proposal; it's waiting for your approval.";

  it("records a claim of a proposal when the run created none", () => {
    expect(falseProposalClaim(claim, 0)).toBe(true);
  });

  it("records nothing when the run did create a proposal, or the answer claims none", () => {
    expect(falseProposalClaim(claim, 1)).toBe(false);
    expect(falseProposalClaim("Sales were £1,873 on Saturday.", 0)).toBe(false);
  });
});
