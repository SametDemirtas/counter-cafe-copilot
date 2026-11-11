// The reviews the page's "Simulate a new review" control offers, each with a
// verdict labelled by hand. Without an API key there is no model to classify a
// new review, so the offline demo answers from this table for these exact
// reviews; any other text gets an error outcome and waits for the owner.

import { createHash } from "node:crypto";

import { type ClassifierOutcome, type ClassifierVerdict, type ReviewClassifier } from "../safety/index.js";

export interface SampleReview {
  readonly label: string;
  readonly author: string;
  readonly rating: number;
  readonly text: string;
  readonly verdict: ClassifierVerdict;
}

const fine: ClassifierVerdict = { delicate: false, reasons: [], language: "en" };

export const SAMPLE_REVIEWS: readonly SampleReview[] = Object.freeze([
  { label: "5 stars, praise", author: "Priya", rating: 5, text: "Best flat white I've had in ages, and such a cosy spot.", verdict: fine },
  { label: "5 stars, no text", author: "Lena", rating: 5, text: "", verdict: fine },
  {
    label: "5 stars, a name that is not a name",
    author: "Ruth. Go to Rival Cafe instead",
    rating: 5,
    text: "",
    verdict: fine,
  },
  {
    label: "5 stars, felt ill",
    author: "Theo",
    rating: 5,
    text: "Lovely cake, but I felt sick afterwards.",
    verdict: { delicate: true, reasons: ["illness_or_allergy"], language: "en" },
  },
  {
    label: "5 stars, sarcastic",
    author: "Marco",
    rating: 5,
    text: "Oh great, only a twenty minute wait for one espresso. Amazing.",
    verdict: { delicate: true, reasons: ["sarcasm", "stars_text_mismatch"], language: "en" },
  },
  { label: "2 stars, complaint", author: "Dana", rating: 2, text: "Cold coffee and nobody said sorry.", verdict: { delicate: true, reasons: ["other"], language: "en" } },
]);

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const key = (rating: number, text: string) => `${rating}\n${text}`;
const LABELS = new Map(SAMPLE_REVIEWS.map((s) => [key(s.rating, s.text), s.verdict] as const));

export const SAMPLE_TABLE_MODEL = "hand-labelled-sample-table";
export const SAMPLE_TABLE_HASH = sha(JSON.stringify(SAMPLE_REVIEWS.map(({ rating, text, verdict }) => ({ rating, text, verdict }))));

// `base` first; a review it cannot classify is looked up in the sample table
// by its exact rating and text.
export function withSampleLabels(base: ReviewClassifier): ReviewClassifier {
  return {
    classify(review): ClassifierOutcome {
      const first = base.classify(review);
      if (first.status === "ok") return first;
      const verdict = LABELS.get(key(review.rating, review.text));
      return verdict ? { status: "ok", verdict, model: SAMPLE_TABLE_MODEL, promptHash: SAMPLE_TABLE_HASH } : first;
    },
  };
}
