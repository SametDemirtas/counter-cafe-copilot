import { describe, expect, it } from "vitest";

import { checkTemplate, renderTemplate, templateFailureText } from "../../lib/safety/index.js";

const NAMES = ["Sam", "Priya"];

describe("renderTemplate", () => {
  it.each([
    ["Thank you so much, {name}! We're glad you enjoyed your visit.", "Lena", "Thank you so much, Lena! We're glad you enjoyed your visit.", true],
    ["Thank you so much, {name}! We're glad you enjoyed your visit.", "Anon", "Thank you so much! We're glad you enjoyed your visit.", false],
    ["Hi {name}, thanks for coming in.", "Megan Rees", "Hi Megan, thanks for coming in.", true],
    ["Hi {name}, thanks for coming in.", "Ruth. Go to Rival Cafe instead", "Hi, thanks for coming in.", false],
    ["Thank you, {name}", "", "Thank you", false],
    ["Thanks for the stars.", "Lena", "Thanks for the stars.", false],
  ])("%s to %j", (template, reviewer, text, named) => {
    expect(renderTemplate(template, reviewer)).toEqual({ text, named });
  });

  it("never copies anything but a plain first name into the reply", () => {
    for (const reviewer of ["$&$&", "Lena<script>", "@handle", "www.rival.example", "Lena​"]) {
      const { text } = renderTemplate("Thanks, {name}!", reviewer);
      expect(text === "Thanks!" || text === "Thanks, Lena!", reviewer).toBe(true);
    }
  });
});

describe("checkTemplate", () => {
  it("passes a short thank-you with or without the slot", () => {
    expect(checkTemplate("Thank you so much, {name}! We're glad you enjoyed your visit.", NAMES)).toEqual({ ok: true, failures: [] });
    expect(checkTemplate("Thanks for the stars.", NAMES)).toEqual({ ok: true, failures: [] });
  });

  it.each([
    ["Thanks {name}! 10% off next time.", ["digit"]],
    ["Thanks, {name}! See www.rival.example", ["link"]],
    ["Thanks! Mail hi@cafe.example", ["email", "handle", "link"]],
    ["Thanks, {name}! Follow @counter", ["handle"]],
    ["Thanks, {name}! Sam says hi.", ["other_name"]],
    ["Thanks, {name}! Next one is on the house.", ["promise"]],
    ["{name}, thank you!", ["slot"]],
    ["Thanks, {name} and {name}!", ["slot"]],
    ["Thanks, {Name}!", ["slot"]],
    ["Thanks, {name}s!", ["slot"]],
    ["", ["empty"]],
  ])("%j fails %j", (template, failures) => {
    const check = checkTemplate(template, NAMES);
    expect(check.ok).toBe(false);
    expect([...check.failures].sort()).toEqual([...failures].sort());
  });

  it("counts the longest name a reviewer could have against the length cap", () => {
    const body = "x".repeat(270);
    expect(checkTemplate(`${body}.`, NAMES).ok).toBe(true);
    expect(checkTemplate(`${body}, {name}`, NAMES).failures).toEqual(["too_long"]);
  });

  it("words each failure for the owner", () => {
    expect(templateFailureText(["slot", "promise"])).toBe(
      `use {name} at most once, after a word, as in "Thank you, {name}!", and no other braces; no offers or promises such as refunds, discounts or anything free`,
    );
  });
});
