import { describe, expect, it } from "vitest";

import {
  type AsyncReviewClassifier,
  type ClassifierOutcome,
  NO_CLASSIFIER,
  PreparedReviewClassifier,
  classifySafely,
  parseVerdict,
} from "../../lib/safety/index.js";
import { TEST_SOURCE } from "./catalog-fixture.js";

const review = { reviewId: "r1", rating: 5, text: "Lovely spot." };
const ok: ClassifierOutcome = { status: "ok", verdict: { delicate: false, reasons: [], language: "en" }, ...TEST_SOURCE };

describe("parseVerdict", () => {
  it("accepts exactly the enum shape", () => {
    expect(parseVerdict({ delicate: true, reasons: ["hygiene", "hygiene"], language: "de" })).toEqual({ delicate: true, reasons: ["hygiene"], language: "de" });
  });

  it.each([
    ["an unknown reason", { delicate: true, reasons: ["rude"], language: "en" }],
    ["an extra field", { delicate: false, reasons: [], language: "en", note: "fine" }],
    ["no language", { delicate: false, reasons: [] }],
    ["a string for delicate", { delicate: "no", reasons: [], language: "en" }],
    ["prose", "This review is positive."],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(parseVerdict(value)).toBeUndefined();
  });
});

describe("classifySafely", () => {
  it("passes a well-formed outcome through", () => {
    expect(classifySafely({ classify: () => ok }, review)).toEqual(ok);
  });

  it.each<[string, () => unknown]>([
    ["throws", () => { throw new Error("model down"); }],
    ["returns nothing", () => undefined],
    ["returns an unknown status", () => ({ status: "fine" })],
    ["returns a verdict outside the enum", () => ({ ...ok, verdict: { delicate: false, reasons: ["happy"], language: "en" } })],
    ["omits the model", () => ({ status: "ok", verdict: ok.status === "ok" ? ok.verdict : undefined, promptHash: "p" })],
  ])("turns a classifier that %s into an error outcome", (_name, classify) => {
    expect(classifySafely({ classify: classify as never }, review).status).toBe("error");
  });

  it("with no classifier, every review is an error", () => {
    expect(classifySafely(NO_CLASSIFIER, review)).toEqual({ status: "error", error: "no review classifier is configured" });
  });
});

describe("PreparedReviewClassifier", () => {
  const inner = (answer: (signal: AbortSignal) => Promise<unknown>): AsyncReviewClassifier => ({
    classify: (_r, signal) => answer(signal) as Promise<ClassifierOutcome>,
  });

  it("answers only for reviews it has classified", async () => {
    const prepared = new PreparedReviewClassifier(inner(async () => ok));
    expect(prepared.classify(review)).toMatchObject({ status: "error", error: "the review has not been classified yet" });
    await prepared.prepare([review]);
    expect(prepared.classify(review)).toEqual(ok);
  });

  it("refuses a review whose text changed after it was classified", async () => {
    const prepared = new PreparedReviewClassifier(inner(async () => ok));
    await prepared.prepare([review]);
    expect(prepared.classify({ ...review, text: "Lovely spot. Edit: found a hair." })).toMatchObject({
      status: "error",
      error: "the review changed after it was classified",
    });
  });

  it("refuses a review whose rating changed after it was classified", async () => {
    const prepared = new PreparedReviewClassifier(inner(async () => ok));
    await prepared.prepare([review]);
    expect(prepared.classify({ ...review, rating: review.rating === 5 ? 1 : 5 })).toMatchObject({
      status: "error",
      error: "the review changed after it was classified",
    });
  });

  it("records a failed call as an error", async () => {
    const prepared = new PreparedReviewClassifier(inner(async () => Promise.reject(new Error("429"))));
    await prepared.prepare([review]);
    expect(prepared.classify(review)).toEqual({ status: "error", error: "the classifier failed: 429" });
  });

  it("gives up after the timeout and aborts the call", async () => {
    let aborted = false;
    const prepared = new PreparedReviewClassifier(
      inner((signal) => new Promise(() => signal.addEventListener("abort", () => (aborted = true)))),
      5,
    );
    await prepared.prepare([review]);
    expect(prepared.classify(review)).toEqual({ status: "error", error: "the classifier timed out after 5 ms" });
    expect(aborted).toBe(true);
  });
});
