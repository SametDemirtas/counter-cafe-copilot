import { describe, expect, it } from "vitest";

import { humanApprover, isValidApprover } from "../../lib/safety/index.js";
import { fixtureGate } from "./catalog-fixture.js";

describe("approver names", () => {
  it("accepts ordinary names, accented ones included", () => {
    for (const name of ["owner", "Megan", "Zoë", "José García", "Ayşe", "Siobhán O'Neill", "Anne-Marie", "J. Smith"]) expect(isValidApprover(name)).toBe(true);
  });

  it("refuses names outside Latin script, so no lookalike of a reserved name gets through", () => {
    // An all-Cyrillic "autopilot", a Cyrillic first name, Greek, and names with digits or symbols.
    for (const name of ["аутопилот", "Сергей", "Ελένη", "owner2", "sam@cafe", "-", "..."]) {
      expect(isValidApprover(name), name).toBe(false);
    }
  });

  it("refuses the reserved names whatever their case or padding", () => {
    for (const name of ["agent", "SYSTEM", " Autopilot "]) expect(isValidApprover(name)).toBe(false);
  });

  it("refuses a reserved name spelt with dots, apostrophes or hyphens", () => {
    for (const name of ["autopilot.", "Autopilot'", "auto-pilot", "Agent.", "system-", "a.g.e.n.t"]) {
      expect(isValidApprover(name), name).toBe(false);
    }
  });

  it("refuses a reserved name hidden behind a zero-width or control character", () => {
    for (const name of ["auto\u200Bpilot", "\u200Dagent", "sys\u2060tem", "agent\u0000", "auto\u00ADpilot", "agent\uFEFF"]) {
      expect(isValidApprover(name), JSON.stringify(name)).toBe(false);
    }
  });

  it("refuses a reserved name spelt with fullwidth or other compatibility forms", () => {
    // Fullwidth "agent", and "system" with a mathematical bold s.
    for (const name of ["ａｇｅｎｔ", "\u{1d42c}ystem"]) expect(isValidApprover(name)).toBe(false);
  });

  it("refuses any name written in compatibility forms, reserved or not", () => {
    // Fullwidth "Sam" and a "ﬁ" ligature: Latin script, so only the NFKC check stops them.
    expect(isValidApprover("\uFF33\uFF41\uFF4D")).toBe(false);
    expect(isValidApprover("Gri\uFB01n")).toBe(false);
    expect(isValidApprover("Sam")).toBe(true);
  });

  it("refuses a reserved name with Cyrillic or Greek lookalike letters", () => {
    // Cyrillic a and e; Greek omicron.
    for (const name of ["аgеnt", "autοpilot"]) expect(isValidApprover(name)).toBe(false);
  });

  it("refuses any name with a non-printing character, reserved or not", () => {
    expect(isValidApprover("own\u200Ber")).toBe(false);
    expect(isValidApprover("owner\u202E")).toBe(false);
    expect(isValidApprover("own\u00A0er")).toBe(false);
  });

  it("keeps a homoglyph name from approving at the gate or unlocking autopilot", () => {
    const { gate } = fixtureGate();
    const p = gate.propose({ kind: "review_reply", params: { reviewId: "five-star", replyText: "Thank you!" } });
    expect(() => gate.approve(p.id, "auto\u200Bpilot")).toThrow(/not a valid approver/);
    expect(() => gate.setAutopilot({ enabled: false, ratings: [] }, "аgеnt")).toThrow(/not a valid approver/);
    expect(humanApprover(" owner ")).toBe("owner");
  });
});
