import { describe, expect, it } from "vitest";

import { Agent, createDemoGate, defaultToolRegistry, loadDemoContext, morningBrief } from "../../lib/agent/index.js";
import { CommandLlm } from "../web/command-llm.js";

function setup() {
  const bundle = createDemoGate();
  const ctx = loadDemoContext(bundle.gate, bundle.store);
  return { bundle, ctx, agent: new Agent(new CommandLlm(), defaultToolRegistry()) };
}

describe("an approved price is written back", () => {
  it("shows the new price to the next proposal, the tools and the brief, and names the item in the result", async () => {
    const { bundle, ctx, agent } = setup();
    const first = await agent.ask(ctx, "Raise flat white to £3.60");
    const result = bundle.gate.execute(bundle.gate.approve(first.proposals[0]!.id, "owner"));
    expect(result.outcome).toBe("Set Flat White price to £3.60");
    expect(ctx.menu.find((m) => m.sku === "flat_white")?.priceMinor).toBe(360);

    const again = await agent.ask(ctx, "Raise flat white to £3.80");
    expect(again.body).toMatch(/Change Flat White price from £3\.60 to £3\.80/);

    // The brief's suggestion moves on once the toastie's rise is applied.
    const toastie = await agent.ask(ctx, "Raise ham and cheese toastie to £7.15");
    bundle.gate.execute(bundle.gate.approve(toastie.proposals[0]!.id, "owner"));
    expect(morningBrief(ctx).suggestedAction).not.toMatchObject({ params: { sku: "ham_cheese_toastie", currentPriceMinor: 650 } });
  });
});

describe("a refused proposal", () => {
  it("reads as one sentence per full stop", async () => {
    const { ctx, agent } = setup();
    const answer = await agent.ask(ctx, "Raise the latte to £9.00");
    expect(answer.body).toMatch(/^I couldn't prepare that: .*[^.]\. Nothing has been changed\.$/);
    expect(answer.body).not.toContain("..");
    expect(answer.proposals).toHaveLength(0);
  });
});
