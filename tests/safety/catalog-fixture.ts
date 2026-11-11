import {
  type ActionCatalog,
  type ActionHandler,
  type ActionSpec,
  type ArrivingReview,
  type ClassifierOutcome,
  type ReviewArrival,
  type ReviewClassifier,
  createActionGate,
  reviewReplyHandler,
} from "../../lib/safety/index.js";

export const TEST_SOURCE = { model: "test-classifier", promptHash: "test-prompt" } as const;

// Calls every review not delicate, so a test sees what the tripwire, the draft
// checks and the rest of the gate do on their own. Never the default outside tests.
export const PASS_CLASSIFIER: ReviewClassifier = {
  classify: (): ClassifierOutcome => ({ status: "ok", verdict: { delicate: false, reasons: [], language: "en" }, ...TEST_SOURCE }),
};

// Answers from a script keyed by review text; any other review gets an error.
// Arrived reviews get ids the gate makes, so the text is the stable key.
export function scriptedByText(script: Record<string, ClassifierOutcome>): ReviewClassifier {
  return { classify: (r) => script[r.text] ?? { status: "error", error: "not in the script" } };
}

// Answers from a script keyed by review id; any other review gets an error.
export function scriptedClassifier(script: Record<string, ClassifierOutcome>): ReviewClassifier {
  return { classify: (r) => script[r.reviewId] ?? { status: "error", error: "not in the script" } };
}

export const HAND_REVIEWS = ["hand-1", "hand-2", "hand-3", "hand-4", "hand-5"] as const;

const ITEMS: Record<string, { name: string; priceMinor: number; foodCostMinor: number }> = {
  avocado_toast: { name: "Avocado Toast", priceMinor: 780, foodCostMinor: 340 },
};

// One review per star rating, plus five the owner answers by hand. New reviews
// arrive through onReviewArrived in the tests that need them.
const RATINGS: Record<string, number> = {
  "one-star": 1,
  "two-star": 2,
  "three-star": 3,
  "four-star": 4,
  "five-star": 5,
  // The five the owner answers by hand to unlock autopilot.
  "hand-1": 5,
  "hand-2": 4,
  "hand-3": 3,
  "hand-4": 5,
  "hand-5": 4,
};

export const catalog: ActionCatalog = {
  currency: "GBP",
  menuItem: (sku) => ITEMS[sku],
  review: (id) =>
    RATINGS[id] === undefined ? undefined : { author: "Sam", rating: RATINGS[id], text: "Lovely spot, friendly staff." },
  knownNames: () => ["Sam", "Lena", "Omar", "Jasmin", "Priya"],
};

export const reply = (reviewId: string, replyText = "Thank you!"): ActionSpec => ({
  kind: "review_reply",
  params: { reviewId, replyText },
});

export function fixtureGate(overrides: Omit<Parameters<typeof createActionGate>[0], "catalog"> = {}) {
  let idN = 0;
  let tokenN = 0;
  return createActionGate({
    catalog,
    now: () => new Date("2026-11-10T08:00:00.000Z"),
    newId: () => `act-${++idN}`,
    newToken: () => `tok-${++tokenN}`,
    classifier: PASS_CLASSIFIER,
    ...overrides,
  });
}

// The owner approves and posts replies to distinct reviews by hand until
// autopilot unlocks.
export function approveRepliesByHand(bundle: ReturnType<typeof fixtureGate>, count: number, approver = "owner"): void {
  for (const reviewId of HAND_REVIEWS.slice(0, count)) {
    bundle.gate.execute(bundle.gate.approve(bundle.gate.propose(reply(reviewId)).id, approver));
  }
}

export const TEMPLATES: Readonly<Record<number, string>> = {
  3: "Thank you for the stars, {name}.",
  4: "Thank you, {name}! We hope to see you again soon.",
  5: "Thank you so much, {name}! We're glad you enjoyed your visit.",
};

// Unlocked, with the owner's templates saved and autopilot on for `ratings`.
export function autopilotOn(ratings: number[] = [3, 4, 5], overrides: Parameters<typeof fixtureGate>[0] = {}) {
  const bundle = fixtureGate(overrides);
  approveRepliesByHand(bundle, 5);
  for (const rating of ratings) bundle.gate.setReplyTemplate(rating, TEMPLATES[rating] ?? "Thank you!", "owner");
  bundle.gate.setAutopilot({ enabled: true, ratings }, "owner");
  return bundle;
}

export const review = (rating: number, text = "Lovely spot, friendly staff.", author = "Lena"): ArrivingReview => ({ author, rating, text });

export function arrive(bundle: ReturnType<typeof fixtureGate>, input: ArrivingReview): ReviewArrival {
  return bundle.gate.onReviewArrived(input);
}

// A reply handler whose sends fail while `down` is true.
export function switchableReplyHandler(): { handler: ActionHandler; setDown(down: boolean): void } {
  let down = false;
  return {
    handler: {
      kind: "review_reply",
      execute(actionId, spec, sink) {
        if (down) throw new Error("reviews API down");
        return reviewReplyHandler.execute(actionId, spec, sink);
      },
    },
    setDown: (value) => {
      down = value;
    },
  };
}
