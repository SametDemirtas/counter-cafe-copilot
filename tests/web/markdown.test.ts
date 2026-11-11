import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown } from "../../lib/web/public/markdown.js";

const t = (text: string) => ({ type: "text", text });
const b = (text: string) => ({ type: "strong", text });

describe("parseInline", () => {
  it("splits bold from plain text and keeps everything else literal", () => {
    expect(parseInline("Tomatoes are **17.8%** over <b>x</b>")).toEqual([t("Tomatoes are "), b("17.8%"), t(" over <b>x</b>")]);
  });
});

describe("parseMarkdown", () => {
  it("reads paragraphs separated by blank lines, keeping single line breaks", () => {
    expect(parseMarkdown("One\ntwo\n\nThree")).toEqual([
      { type: "paragraph", inlines: [t("One\ntwo")] },
      { type: "paragraph", inlines: [t("Three")] },
    ]);
  });

  it("reads bullet and numbered lists, each as its own block", () => {
    expect(parseMarkdown("Two things:\n- **Tomatoes**: £3.20\n* Sunday\n1. First\n2) Second")).toEqual([
      { type: "paragraph", inlines: [t("Two things:")] },
      { type: "bullets", items: [[b("Tomatoes"), t(": £3.20")], [t("Sunday")]] },
      { type: "numbered", items: [[t("First")], [t("Second")]] },
    ]);
  });

  it("reads a pipe table with a header rule, and leaves a lone pipe line as text", () => {
    const table = "| Day | Sales |\n|---|:---:|\n| Saturday | **£1,873.00** |\n| Sunday | none |\nAfter.";
    expect(parseMarkdown(table)).toEqual([
      {
        type: "table",
        header: [[t("Day")], [t("Sales")]],
        rows: [
          [[t("Saturday")], [b("£1,873.00")]],
          [[t("Sunday")], [t("none")]],
        ],
      },
      { type: "paragraph", inlines: [t("After.")] },
    ]);
    expect(parseMarkdown("| not a table |")).toEqual([{ type: "paragraph", inlines: [t("| not a table |")] }]);
  });

  it("shows a heading as a bold line and handles Windows line endings", () => {
    expect(parseMarkdown("### Summary\r\nText")).toEqual([
      { type: "paragraph", inlines: [b("Summary")] },
      { type: "paragraph", inlines: [t("Text")] },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(parseMarkdown("")).toEqual([]);
  });
});
