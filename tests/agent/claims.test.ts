import { describe, expect, it } from "vitest";

import { proposalClaim } from "../../lib/agent/claims.js";

describe("proposalClaim", () => {
  it.each([
    "I've created a £1.00 proposal for the avocado toast.",
    "I have drafted a reply to Sofyen's review.",
    "I've prepared the price change for you.",
    "No problem, I've queued a proposal to raise the latte.",
    "Done. I've put together a reply.",
    // An earlier "can" in another clause hedges nothing.
    "Sure, I can do that: I've created a proposal for the toastie.",
    "I've proposed raising the toastie to £7.15.",
    "Proposal created: toastie to £7.15.",
  ])("reads %j as a claim that a proposal was created", (text) => {
    expect(proposalClaim(text)).toBe("created");
  });

  it.each([
    "It is waiting for your approval.",
    "I sent it for your approval.",
    "It's in your approval queue now.",
    "The proposal is ready.",
    "Done. The toastie price change is waiting on your approval.",
  ])("reads %j as a claim that something is waiting", (text) => {
    expect(proposalClaim(text)).toBe("waiting");
  });

  it.each([
    "I couldn't create the proposal because £1.00 is below the food cost.",
    "I haven't created a proposal.",
    "I have not drafted a reply yet.",
    "Nothing is waiting for your approval.",
    "No proposal is waiting for your approval.",
    "If you tell me the exact price, I'll prepare a proposal and it will be waiting for your approval.",
    "Once you confirm, it would be ready for your approval.",
    "I can draft a reply if you like.",
    "Tomatoes are 17.8% over the agreed price.",
    "I've prepared a summary of your sales.",
    "I can create a proposal if you give me a price.",
    "I couldn't create the proposal because the price is below the food cost.",
    "Once you approve, it will be waiting on your approval in the queue.",
    "If you give me a price, I'll have proposed raising it by then.",
    // A modal in the claim's own clause hedges it.
    "Sure, it will be ready for your approval.",
    "Give me the price and I'll have it waiting on your approval.",
  ])("does not read %j as a claim", (text) => {
    expect(proposalClaim(text)).toBeUndefined();
  });

  it("does not let a hedge in one sentence excuse a claim in the next", () => {
    expect(proposalClaim("I couldn't do it at first. I've created the proposal now.")).toBe("created");
  });
});
