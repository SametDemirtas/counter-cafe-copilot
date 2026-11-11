// The review inbox and the owner's reply templates over HTTP. A new review is
// handed to the gate, which lets autopilot answer it or leaves it for the
// owner; the templates are saved through the gate, which checks them first.

import { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  type ActionGateBundle,
  type ActionRecord,
  type ArrivedReview,
  type AutopilotRuleId,
  MAX_AUTHOR_CHARS,
  MAX_REVIEW_CHARS,
  PolicyRejection,
  type PreparedReviewClassifier,
  hasText,
  isValidApprover,
  renderTemplate,
} from "../safety/index.js";
import { type Review } from "../tools/reviews.js";
import { crossOriginBlocked } from "./guards.js";
import { readJson, sendJson } from "./http.js";
import { SAMPLE_REVIEWS } from "./sample-reviews.js";

export interface ReviewsDeps {
  readonly bundle: ActionGateBundle;
  // Set when a model classifies reviews: a new review is classified before
  // autopilot looks at it.
  readonly prepare?: PreparedReviewClassifier;
}

const Approver = z.string().trim().min(1).max(120).optional();
const ReviewBody = z
  .object({ author: z.string().max(MAX_AUTHOR_CHARS), rating: z.number().int().min(1).max(5), text: z.string().max(MAX_REVIEW_CHARS) })
  .strict();
const TemplateBody = z.object({ rating: z.number().int(), text: z.string().max(1000), approver: Approver }).strict();

// Reasons that say nothing about the review itself, only that autopilot is
// not in play; the card leaves them out.
export const SILENT_RULES: ReadonlySet<AutopilotRuleId> = new Set(["autopilot_off", "autopilot_locked"]);

// The reviews that arrived while running, as the agent's tools read them.
export function arrivedForAgent(bundle: ActionGateBundle): Review[] {
  return bundle.gate.catalog.arrived().map(({ id, author, rating, text }) => ({ id, author, rating, text }));
}

export async function handleNewReview(req: IncomingMessage, res: ServerResponse, deps: ReviewsDeps): Promise<void> {
  if (crossOriginBlocked(req, res)) return;
  const body = await readJson(req, res, ReviewBody);
  if (!body) return;
  const id = `rev-new-${randomUUID().slice(0, 8)}`;
  // Classified first, so the gate never waits on a model; a failure is an
  // error outcome, which leaves the review for the owner.
  if (deps.prepare && hasText(body.text)) await deps.prepare.prepare([{ reviewId: id, rating: body.rating, text: body.text }]);
  try {
    const arrival = deps.bundle.gate.onReviewArrived({ id, ...body });
    return sendJson(res, 200, { review: serializeReview(deps.bundle, arrival.review) });
  } catch (error) {
    if (error instanceof PolicyRejection) return sendJson(res, 400, { error: error.message });
    throw error;
  }
}

export async function handleTemplate(req: IncomingMessage, res: ServerResponse, bundle: ActionGateBundle): Promise<boolean> {
  if (crossOriginBlocked(req, res)) return false;
  const body = await readJson(req, res, TemplateBody);
  if (!body) return false;
  const approver = body.approver ?? "owner";
  if (!isValidApprover(approver)) {
    sendJson(res, 400, { error: `"${approver}" is not a valid approver` });
    return false;
  }
  try {
    bundle.gate.setReplyTemplate(body.rating, body.text, approver);
  } catch (error) {
    if (!(error instanceof PolicyRejection)) throw error;
    sendJson(res, error.rule === "autopilot_template_in_use" ? 409 : 400, { error: error.message });
    return false;
  }
  return true;
}

export function listReviews(bundle: ActionGateBundle): Record<string, unknown> {
  const reviews = bundle.gate.catalog.arrived().map((r) => serializeReview(bundle, r)).reverse();
  return { reviews, samples: SAMPLE_REVIEWS.map(({ label, author, rating, text }) => ({ label, author, rating, text })) };
}

// The newest reply to this review, by anyone.
function latestReply(bundle: ActionGateBundle, reviewId: string): ActionRecord | undefined {
  return bundle.store
    .entries()
    .filter((r) => r.proposal.spec.kind === "review_reply" && r.proposal.spec.params.reviewId === reviewId)
    .at(-1);
}

const STATE: Record<ActionRecord["status"], string> = {
  pending: "drafted",
  approved: "approved",
  executed: "replied",
  rejected: "waiting",
};

function serializeReview(bundle: ActionGateBundle, review: ArrivedReview): Record<string, unknown> {
  const arrival = bundle.gate.arrivalFor(review.id);
  const reply = latestReply(bundle, review.id);
  const decision = arrival?.decision;
  return {
    id: review.id,
    author: review.author,
    rating: review.rating,
    text: review.text,
    arrivedAt: review.arrivedAt,
    state: reply ? STATE[reply.status] : "waiting",
    ...(reply ? { replyText: reply.proposal.spec.kind === "review_reply" ? reply.proposal.spec.params.replyText : "", repliedBy: reply.approvedBy } : {}),
    ...(decision ? { autopilot: decision.action } : {}),
    ...(decision && !SILENT_RULES.has(decision.rule) ? { reason: decision.reason } : {}),
  };
}

// Each template as it reads when the reviewer's name cannot be used.
export function templatePreviews(bundle: ActionGateBundle): Record<string, string> {
  const { templates } = bundle.gate.autopilotStatus();
  return Object.fromEntries(Object.entries(templates).map(([rating, text]) => [rating, renderTemplate(text, "").text]));
}
