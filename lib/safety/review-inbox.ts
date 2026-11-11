// Reviews that arrive while the café is open, kept next to the catalog the gate
// was given. The gate, the policy and the eval rail all read reviews through
// this, so a new review is checked the same way as one loaded at startup.

import { type ActionCatalog, type CatalogItem, type CatalogReview, PolicyRejection } from "./policy.js";

export const MAX_AUTHOR_CHARS = 80;
export const MAX_REVIEW_CHARS = 2000;
const REVIEW_ID = /^[A-Za-z0-9_-]{1,64}$/u;

// A review as the review site sends it. The id is optional; the gate makes one.
export interface ArrivingReview {
  readonly id?: string;
  readonly author: string;
  readonly rating: number;
  readonly text: string;
}

export interface ArrivedReview extends CatalogReview {
  readonly id: string;
  readonly arrivedAt: string;
}

export class ReviewInbox implements ActionCatalog {
  private readonly reviews = new Map<string, ArrivedReview>();

  constructor(private readonly base: ActionCatalog) {}

  get currency() {
    return this.base.currency;
  }

  menuItem(sku: string): CatalogItem | undefined {
    return this.base.menuItem(sku);
  }

  review(id: string): CatalogReview | undefined {
    return this.reviews.get(id) ?? this.base.review(id);
  }

  knownNames(): readonly string[] {
    const base = this.base.knownNames?.() ?? [];
    return [...new Set([...base, ...[...this.reviews.values()].map((r) => r.author)])];
  }

  // Newest last.
  arrived(): readonly ArrivedReview[] {
    return [...this.reviews.values()];
  }

  // Checks the shape and stores the review. Throws a PolicyRejection
  // ("invalid_review") and stores nothing when the review is malformed or its
  // id is already taken.
  add(input: ArrivingReview, id: string, arrivedAt: string): ArrivedReview {
    const review = parseArriving(input, id);
    if (this.review(review.id)) throw new PolicyRejection("invalid_review", `a review with id ${review.id} already exists`);
    const stored = Object.freeze({ ...review, arrivedAt });
    this.reviews.set(stored.id, stored);
    return stored;
  }
}

function parseArriving(input: ArrivingReview, fallbackId: string): Omit<ArrivedReview, "arrivedAt"> {
  const bad = (why: string) => new PolicyRejection("invalid_review", why);
  if (typeof input !== "object" || input === null) throw bad("a review must be an object");
  const id = input.id ?? fallbackId;
  if (typeof id !== "string" || !REVIEW_ID.test(id)) throw bad("a review id is 1 to 64 letters, digits, - or _");
  if (typeof input.author !== "string" || [...input.author].length > MAX_AUTHOR_CHARS) {
    throw bad(`a reviewer's name is text of at most ${MAX_AUTHOR_CHARS} characters`);
  }
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw bad("a rating is a whole number of stars from 1 to 5");
  if (typeof input.text !== "string" || [...input.text].length > MAX_REVIEW_CHARS) {
    throw bad(`a review's text is at most ${MAX_REVIEW_CHARS} characters`);
  }
  return { id, author: input.author, rating: input.rating, text: input.text };
}
