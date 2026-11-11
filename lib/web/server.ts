// The human side of the gate: the server holds approve/execute, the agent only
// ever gets the propose-only context. A localhost demo surface, not a service.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { z } from "zod";

import {
  AUTOPILOT_ACTOR,
  AUTOPILOT_RATINGS,
  ActionConflictError,
  type ActionGateBundle,
  type ActionRecord,
  type ActionSpec,
  type ApprovedAction,
  PolicyRejection,
  PreparedReviewClassifier,
  type ReviewClassifier,
  UnknownActionError,
  hasText,
  isValidApprover,
  openProposalFor,
  replyTitle,
  summarizeAction,
  targetOf,
} from "../safety/index.js";
import {
  Agent,
  type AgentContext,
  ToolError,
  AnthropicLlmClient,
  type LlmClient,
  type Turn,
  createDemoGate,
  defaultToolRegistry,
  loadDemoContext,
  morningBrief,
  proposePriceChangeTool,
  remember,
} from "../agent/index.js";
import { formatMoney, money } from "../domain/money.js";
import { AnthropicReviewClassifier, demoReviewClassifier } from "../agent/review-classifier.js";
import { DemoLlmClient } from "./demo-llm.js";
import { STARTERS } from "./demo-script.js";
import { crossOriginBlocked, hostAllowed } from "./guards.js";
import { readJson, sendJson } from "./http.js";
import { SILENT_RULES, arrivedForAgent, handleNewReview, handleTemplate, listReviews, templatePreviews } from "./reviews-api.js";
import { withSampleLabels } from "./sample-reviews.js";
import { STATIC, serveStatic } from "./static.js";

export type LlmMode = "anthropic" | "demo" | "injected";

export function createLlmClient(): { readonly client: LlmClient; readonly mode: LlmMode } {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key && key.trim().length > 0) return { client: new AnthropicLlmClient({ apiKey: key }), mode: "anthropic" };
  return { client: new DemoLlmClient(), mode: "demo" };
}

// With a key, the reviews are classified by a small model once at startup;
// until that finishes, and for any review it could not classify, replies wait
// for the owner. Without a key, the hand-labelled table for the mock reviews.
export function createReviewClassifier(): { readonly classifier: ReviewClassifier; readonly prepare?: PreparedReviewClassifier } {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key || key.trim().length === 0) return { classifier: demoReviewClassifier };
  const prepared = new PreparedReviewClassifier(new AnthropicReviewClassifier({ apiKey: key }));
  return { classifier: prepared, prepare: prepared };
}

interface Session {
  readonly bundle: ActionGateBundle;
  // Classifies a new review with the model before autopilot looks at it.
  readonly prepare?: PreparedReviewClassifier;
  readonly ctx: AgentContext;
  readonly agent: Agent;
  // Approved but not yet executed, so a failed execute can be retried.
  readonly approved: Map<string, ApprovedAction>;
  // Recent turns per conversation (one per open page), text only.
  readonly conversations: Map<string, Turn[]>;
  // The questions the page offers as buttons.
  readonly suggestions: readonly string[];
}

// Bounds the memory one local session can hold for old pages.
const MAX_CONVERSATIONS = 20;

export interface AppOptions {
  readonly llm?: LlmClient;
  readonly mode?: LlmMode;
  readonly bundle?: ActionGateBundle;
  // Ignored when `bundle` is given, since that bundle has its own.
  readonly classifier?: ReviewClassifier;
}

export function createApp(options: AppOptions = {}): Server {
  const resolved = options.llm ? { client: options.llm, mode: options.mode ?? "injected" } : createLlmClient();
  const reviews = reviewClassifierFor(options, resolved.mode);
  const classifier = options.classifier ?? reviews?.classifier;
  const bundle = options.bundle ?? createDemoGate(classifier ? { classifier } : {});
  const ctx = withArrivedReviews(loadDemoContext(bundle.gate, bundle.store), bundle);
  if (reviews?.prepare) {
    const withText = ctx.reviews.filter((r) => hasText(r.text)).map((r) => ({ reviewId: r.id, rating: r.rating, text: r.text }));
    reviews.prepare.prepare(withText).catch((error: unknown) => console.error("review classification failed:", error));
  }
  const session: Session = {
    bundle,
    ...(reviews?.prepare ? { prepare: reviews.prepare } : {}),
    ctx,
    agent: new Agent(resolved.client, defaultToolRegistry()),
    approved: new Map(),
    conversations: new Map(),
    // The offline demo answers only its own prompts, so it offers all of them.
    suggestions: resolved.client instanceof DemoLlmClient ? resolved.client.suggestions() : STARTERS.map((p) => p.question),
  };
  return createServer((req, res) => {
    handle(req, res, session, resolved.mode).catch((error: unknown) => {
      // The detail goes to the server log; the client gets an id to quote.
      const requestId = logError(req, error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error", requestId });
      else res.end();
    });
  });
}

// A given bundle or classifier is used as it is. Otherwise the real model gets
// the network classifier, and the offline demo or an injected model (tests)
// the hand-labelled tables for the mock reviews and the page's sample reviews.
function reviewClassifierFor(options: AppOptions, mode: LlmMode): ReturnType<typeof createReviewClassifier> | undefined {
  if (options.bundle || options.classifier) return undefined;
  if (mode === "anthropic") return createReviewClassifier();
  return { classifier: withSampleLabels(demoReviewClassifier) };
}

// The agent reads the mock reviews plus every review that arrived since, so
// the owner can ask for a draft to a review autopilot left for them.
function withArrivedReviews(ctx: AgentContext, bundle: ActionGateBundle): AgentContext {
  const loaded = ctx.reviews;
  return Object.defineProperty(ctx, "reviews", { get: () => [...loaded, ...arrivedForAgent(bundle)], enumerable: true });
}

function logError(req: IncomingMessage, error: unknown): string {
  const requestId = randomUUID();
  console.error(`[${requestId}] ${req.method ?? "?"} ${req.url ?? "?"} failed:`, error);
  return requestId;
}

// The owner's question; separate from the reply limit, which the gate owns.
const MAX_QUESTION_LENGTH = 2000;

const AskBody = z
  .object({
    question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
    // Chosen by the page, so a reload starts a new conversation.
    conversationId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
  })
  .strict();
const SuggestionBody = z.object({ suggestion: z.string().min(1).max(500) }).strict();
const Approver = z.string().trim().min(1).max(120).optional();
const DecisionBody = z.object({ approver: Approver }).strict();
const AutopilotBody = z
  .object({ enabled: z.boolean(), ratings: z.array(z.number().int().min(1).max(5)).max(5), approver: Approver })
  .strict();

const methodNotAllowed = (res: ServerResponse) => sendJson(res, 405, { error: "method not allowed" });

async function handle(req: IncomingMessage, res: ServerResponse, session: Session, mode: LlmMode): Promise<void> {
  if (!hostAllowed(req)) return sendJson(res, 403, { error: "unknown host" });
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";

  const staticEntry = STATIC[path];
  if (staticEntry) return method === "GET" ? serveStatic(res, staticEntry) : methodNotAllowed(res);

  if (path === "/api/health") {
    return method === "GET" ? sendJson(res, 200, { ok: true, mode, suggestions: session.suggestions }) : methodNotAllowed(res);
  }
  if (path === "/api/brief") {
    if (method !== "GET") return methodNotAllowed(res);
    const brief = morningBrief(session.ctx);
    const suggestion = suggestionText(session, brief.suggestedAction);
    return sendJson(res, 200, {
      // The newest day in the data, so the note is dated by the numbers it reads.
      latestDay: session.ctx.shifts.days.at(-1)!.date,
      ...(brief.sales ? { sales: brief.sales } : {}),
      headline: brief.headline,
      ...(brief.more.length > 0 ? { more: brief.more } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }
  if (path === "/api/proposals") {
    if (method !== "GET") return methodNotAllowed(res);
    // Approved-but-unexecuted actions stay listed so a failed send can be retried
    // or withdrawn, and replies autopilot sent stay listed so the owner sees what went out.
    const open = (r: ActionRecord) => r.status === "pending" || r.status === "approved" || sentByAutopilot(r);
    const proposals = session.bundle.store.entries().filter(open).map((r) => serializeProposal(session, r));
    return sendJson(res, 200, { proposals });
  }
  if (path === "/api/brief/suggestion") return method === "POST" ? handleSuggestion(req, res, session) : methodNotAllowed(res);
  if (path === "/api/ask") return method === "POST" ? handleAsk(req, res, session) : methodNotAllowed(res);
  if (path === "/api/autopilot") {
    if (method === "GET") return sendJson(res, 200, autopilotView(session));
    return method === "POST" ? handleAutopilot(req, res, session) : methodNotAllowed(res);
  }
  if (path === "/api/autopilot/templates") {
    if (method !== "POST") return methodNotAllowed(res);
    if (await handleTemplate(req, res, session.bundle)) sendJson(res, 200, autopilotView(session));
    return;
  }
  if (path === "/api/reviews") {
    if (method === "GET") return sendJson(res, 200, listReviews(session.bundle));
    return method === "POST" ? handleNewReview(req, res, session) : methodNotAllowed(res);
  }

  const decision = path.match(/^\/api\/proposals\/([^/]+)\/(approve|reject)$/);
  if (decision) {
    if (method !== "POST") return methodNotAllowed(res);
    return handleDecision(req, res, session, decision[1]!, decision[2] as "approve" | "reject");
  }
  return sendJson(res, 404, { error: "not found" });
}

async function handleAsk(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
  if (crossOriginBlocked(req, res)) return;
  const body = await readJson(req, res, AskBody);
  if (!body) return;
  const { conversationId } = body;
  const history = conversationId ? (session.conversations.get(conversationId) ?? []) : [];
  const answer = await session.agent.ask(session.ctx, body.question, history);
  // Read again after the await: another question on this conversation may
  // have finished meanwhile, and its turn must not be overwritten.
  if (conversationId) {
    const latest = session.conversations.get(conversationId) ?? [];
    saveTurn(session, conversationId, remember(latest, { question: body.question, answer: answer.body }));
  }
  const proposals = answer.proposals
    .map((p) => session.bundle.store.get(p.id))
    .filter((r): r is ActionRecord => r !== undefined)
    .map((r) => serializeProposal(session, r));
  sendJson(res, 200, { body: answer.body, status: answer.status, proposals });
}

// The brief's suggested change in words, as the owner reads it on the card.
function suggestionText(session: Session, action: ActionSpec | undefined): string | undefined {
  return action ? summarizeAction(action, session.bundle.gate.displayName(action)) : undefined;
}

// One tap on the brief: proposes its suggestion through the same tool the agent
// uses, so it passes the same policy and still waits for the owner's approval.
// The page sends the summary it showed, so a stale card cannot propose a
// different change than the one the owner read.
async function handleSuggestion(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
  if (crossOriginBlocked(req, res)) return;
  const body = await readJson(req, res, SuggestionBody);
  if (!body) return;
  const action = morningBrief(session.ctx).suggestedAction;
  if (!action || action.kind !== "price_change" || suggestionText(session, action) !== body.suggestion) {
    return sendJson(res, 409, { error: "The brief's suggestion has changed. Reload the page to see the current one." });
  }
  const { sku, proposedPriceMinor } = action.params;
  // A second tap on the same card hands back the change it already queued.
  const open = openProposalFor(session.bundle.store, targetOf(action));
  const same = open?.proposal.spec.kind === "price_change" && open.proposal.spec.params.proposedPriceMinor === proposedPriceMinor;
  if (open && same) return sendJson(res, 200, { proposal: serializeProposal(session, open), alreadyWaiting: true });
  try {
    const result = proposePriceChangeTool.run({ sku, proposedPriceMinor }, session.ctx) as { proposalId: string };
    return sendJson(res, 200, { proposal: serializeProposal(session, session.bundle.store.get(result.proposalId)!) });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    // The policy allows one open change per item; name the one in the way.
    if (open?.proposal.spec.kind === "price_change") {
      const { currentPriceMinor, proposedPriceMinor: waiting, currency } = open.proposal.spec.params;
      const price = (minor: number) => formatMoney(money(minor, currency));
      return sendJson(res, 409, { error: `A different change for this item is already waiting: ${price(currentPriceMinor)} to ${price(waiting)}.` });
    }
    return sendJson(res, 409, { error: error.message });
  }
}

async function handleDecision(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  id: string,
  decision: "approve" | "reject",
): Promise<void> {
  if (crossOriginBlocked(req, res)) return;
  const body = await readJson(req, res, DecisionBody);
  if (!body) return;
  const approver = body.approver ?? "owner";
  if (!isValidApprover(approver)) return sendJson(res, 400, { error: `"${approver}" is not a valid approver` });

  // The gate decides what this action's state allows; its typed errors become 404 and 409.
  try {
    if (decision === "reject") {
      session.bundle.gate.reject(id, approver);
      session.approved.delete(id);
      return sendJson(res, 200, { id, status: "rejected" });
    }
    return executeApproved(req, res, session, id, approver);
  } catch (error) {
    if (error instanceof UnknownActionError) return sendJson(res, 404, { error: `no proposal with id ${id}` });
    if (error instanceof ActionConflictError) return sendJson(res, 409, { error: error.message });
    throw error;
  }
}

// An approval is kept until it runs, so approving again after a failed send retries it.
function executeApproved(req: IncomingMessage, res: ServerResponse, session: Session, id: string, approver: string): void {
  const { gate } = session.bundle;
  let approved = session.approved.get(id);
  if (!approved) {
    approved = gate.approve(id, approver);
    session.approved.set(id, approved);
  }
  try {
    const result = gate.execute(approved);
    session.approved.delete(id);
    return sendJson(res, 200, { id, status: "executed", result });
  } catch (error) {
    if (error instanceof ActionConflictError) throw error;
    // Still approved; approving again retries the execution, rejecting withdraws it.
    const requestId = logError(req, error);
    return sendJson(res, 502, { id, status: "approved", error: "execution failed, approve again to retry or reject to withdraw", requestId });
  }
}

// Re-inserted so the map's order is least recently used first.
function saveTurn(session: Session, conversationId: string, turns: Turn[]): void {
  session.conversations.delete(conversationId);
  session.conversations.set(conversationId, turns);
  while (session.conversations.size > MAX_CONVERSATIONS) {
    session.conversations.delete(session.conversations.keys().next().value!);
  }
}

function sentByAutopilot(record: ActionRecord): boolean {
  return record.status === "executed" && record.approvedBy === AUTOPILOT_ACTOR;
}

// The ratings autopilot can cover, and those it never does, so the page words
// the rule from the gate's own numbers.
function autopilotView(session: Session): Record<string, unknown> {
  const ownerRatings = [1, 2, 3, 4, 5].filter((r) => !AUTOPILOT_RATINGS.includes(r));
  return {
    ...session.bundle.gate.autopilotStatus(),
    eligibleRatings: AUTOPILOT_RATINGS,
    ownerRatings,
    // How each template reads to a reviewer whose name cannot be used.
    withoutName: templatePreviews(session.bundle),
  };
}

async function handleAutopilot(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
  if (crossOriginBlocked(req, res)) return;
  const body = await readJson(req, res, AutopilotBody);
  if (!body) return;
  const approver = body.approver ?? "owner";
  if (!isValidApprover(approver)) return sendJson(res, 400, { error: `"${approver}" is not a valid approver` });
  try {
    session.bundle.gate.setAutopilot({ enabled: body.enabled, ratings: body.ratings }, approver);
  } catch (error) {
    if (!(error instanceof PolicyRejection)) throw error;
    return sendJson(res, error.rule === "autopilot_locked" ? 409 : 400, { error: error.message });
  }
  return sendJson(res, 200, autopilotView(session));
}

function serializeProposal(session: Session, record: ActionRecord): Record<string, unknown> {
  const spec = record.proposal.spec;
  // Why autopilot sent this reply, or why the review it answers was left for the owner.
  const { gate } = session.bundle;
  const decision = gate.autopilotDecision(record.proposal.id) ?? (spec.kind === "review_reply" ? gate.arrivalFor(spec.params.reviewId)?.decision : undefined);
  const why = decision && !SILENT_RULES.has(decision.rule) ? decision.reason : undefined;
  return {
    id: record.proposal.id,
    kind: spec.kind,
    summary: record.proposal.summary,
    // A reply's card shows the whole draft under this title, not the cut-short summary.
    ...(spec.kind === "review_reply" && { title: replyTitle(spec.params, session.bundle.gate.displayName(spec)) }),
    params: record.proposal.spec.params,
    proposedAt: record.proposal.proposedAt,
    status: record.status,
    autopilot: record.approvedBy === AUTOPILOT_ACTOR,
    ...(why ? { autopilotReason: why } : {}),
  };
}
