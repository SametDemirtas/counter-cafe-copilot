// The seam between the gate and whatever reads a review's text. A classifier
// answers with a fixed enum: is the review delicate, and why. The gate acts on
// that enum and nothing else, so a review that talks the classifier into prose
// or a made-up label gets the owner, not a post. Every failure is an outcome
// too (no classifier, an error, a timeout, a refusal, an answer that does not
// parse), and decideAutopilot sends each one to the owner.

import { z } from "zod";

export const DELICATE_REASONS = [
  "illness_or_allergy",
  "hygiene",
  "staff_conduct",
  "refund_or_money",
  "legal_or_safety",
  "stars_text_mismatch",
  "sarcasm",
  "other",
] as const;

export type DelicateReason = (typeof DELICATE_REASONS)[number];

export interface ClassifierVerdict {
  readonly delicate: boolean;
  readonly reasons: readonly DelicateReason[];
  // What the classifier says the review is written in, e.g. "en" or "de".
  readonly language: string;
}

// Which classifier answered, so an audit entry can be traced to a model and the
// exact prompt it was given.
export interface ClassifierSource {
  readonly model: string;
  readonly promptHash: string;
}

export type ClassifierOutcome =
  | ({ readonly status: "ok"; readonly verdict: ClassifierVerdict } & ClassifierSource)
  | ({ readonly status: "error"; readonly error: string } & Partial<ClassifierSource>);

export const VerdictSchema = z
  .object({
    delicate: z.boolean(),
    reasons: z.array(z.enum(DELICATE_REASONS)).max(DELICATE_REASONS.length),
    language: z.string().trim().min(1).max(35),
  })
  .strict();

// The verdict if `value` is exactly one, otherwise undefined. Used on what a
// model returns and again by decideAutopilot on what the audit recorded.
export function parseVerdict(value: unknown): ClassifierVerdict | undefined {
  const parsed = VerdictSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { delicate, reasons, language } = parsed.data;
  return Object.freeze({ delicate, reasons: Object.freeze([...new Set(reasons)]), language });
}

export interface ClassifiedReview {
  readonly reviewId: string;
  readonly rating: number;
  readonly text: string;
}

// Asked synchronously at propose time, so the gate never waits on a network
// call halfway through a proposal. A model-backed classifier answers ahead of
// time; see PreparedReviewClassifier.
export interface ReviewClassifier {
  classify(review: ClassifiedReview): ClassifierOutcome;
}

const failed = (error: string, source: Partial<ClassifierSource> = {}): ClassifierOutcome =>
  Object.freeze({ status: "error", error, ...source });

// The default: with no classifier configured, no text review is posted by autopilot.
export const NO_CLASSIFIER: ReviewClassifier = Object.freeze({
  classify: () => failed("no review classifier is configured"),
});

// Whatever a classifier returned or threw, as an outcome the gate can record.
export function classifySafely(classifier: ReviewClassifier, review: ClassifiedReview): ClassifierOutcome {
  try {
    return normaliseOutcome(classifier.classify(review));
  } catch (error) {
    return failed(`the classifier failed: ${messageOf(error)}`);
  }
}

function normaliseOutcome(raw: unknown): ClassifierOutcome {
  if (typeof raw !== "object" || raw === null) return failed("the classifier gave no answer");
  const r = raw as Record<string, unknown>;
  const source = {
    ...(typeof r["model"] === "string" ? { model: r["model"] } : {}),
    ...(typeof r["promptHash"] === "string" ? { promptHash: r["promptHash"] } : {}),
  };
  if (r["status"] === "error") return failed(typeof r["error"] === "string" ? r["error"] : "unknown error", source);
  if (r["status"] !== "ok") return failed("the classifier gave no status", source);
  const verdict = parseVerdict(r["verdict"]);
  if (!verdict) return failed("the classifier's verdict is not one of the allowed answers", source);
  if (!source.model || !source.promptHash) return failed("the classifier did not say which model and prompt answered", source);
  return Object.freeze({ status: "ok", verdict, model: source.model, promptHash: source.promptHash });
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// A classifier that has to be awaited, such as a model call.
export interface AsyncReviewClassifier {
  classify(review: ClassifiedReview, signal: AbortSignal): Promise<ClassifierOutcome>;
}

export const DEFAULT_CLASSIFY_TIMEOUT_MS = 15_000;

// Runs an async classifier ahead of time and answers the gate from what it
// found. A review that was never classified, or whose text has changed since,
// gets an error outcome, as does one whose call failed or timed out. The rating
// is kept too, since a verdict such as stars_text_mismatch depends on it.
export class PreparedReviewClassifier implements ReviewClassifier {
  private readonly outcomes = new Map<string, { readonly review: ClassifiedReview; readonly outcome: ClassifierOutcome }>();

  constructor(
    private readonly inner: AsyncReviewClassifier,
    private readonly timeoutMs: number = DEFAULT_CLASSIFY_TIMEOUT_MS,
  ) {}

  async prepare(reviews: readonly ClassifiedReview[]): Promise<void> {
    await Promise.all(
      reviews.map(async (review) => this.outcomes.set(review.reviewId, { review, outcome: await this.ask(review) })),
    );
  }

  classify(review: ClassifiedReview): ClassifierOutcome {
    const known = this.outcomes.get(review.reviewId);
    if (!known) return failed("the review has not been classified yet");
    if (known.review.text !== review.text || known.review.rating !== review.rating) {
      return failed("the review changed after it was classified");
    }
    return known.outcome;
  }

  private async ask(review: ClassifiedReview): Promise<ClassifierOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ClassifierOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(failed(`the classifier timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
    });
    try {
      return normaliseOutcome(await Promise.race([this.inner.classify(review, controller.signal), timeout]));
    } catch (error) {
      return failed(`the classifier failed: ${messageOf(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
