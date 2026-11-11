import { z } from "zod";

import { roundTo } from "../domain/round.js";

export const ReviewSchema = z.object({
  id: z.string().min(1),
  author: z.string(),
  rating: z.number().int().min(1).max(5),
  text: z.string(),
});
export const ReviewsSchema = z.array(ReviewSchema);
export type Review = z.infer<typeof ReviewSchema>;

export interface ReviewSummary {
  readonly reviews: readonly Review[];
  readonly count: number;
  // Rounded to one decimal; null when there are no reviews.
  readonly averageRating: number | null;
}

export function summarizeReviews(reviews: readonly Review[]): ReviewSummary {
  const count = reviews.length;
  const averageRating = count === 0 ? null : roundTo(reviews.reduce((s, r) => s + r.rating, 0) / count, 1);
  return { reviews: reviews.map((r) => ({ id: r.id, author: r.author, rating: r.rating, text: r.text })), count, averageRating };
}
