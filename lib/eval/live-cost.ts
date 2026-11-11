// What a live run costs, and when it must stop: the spending cap, and the API
// errors that make every further call pointless.

import Anthropic from "@anthropic-ai/sdk";

import { type LlmClient, type LlmRequest, type LlmResponse } from "../agent/index.js";

// US dollars per million tokens, from Anthropic's published price list for
// first-party API use. A cache write is 1.25 times the input price (the 5
// minute cache this code uses); a cache read is the listed cache read price.
export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  // The review classifier (eval:routing); prompts of 100K tokens or fewer.
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
};

export function pricingFor(model: string): ModelPricing | undefined {
  return Object.hasOwn(PRICING, model) ? PRICING[model] : undefined;
}

export type CallUsage = NonNullable<LlmResponse["usage"]>;

// inputTokens counts every input token; the cache shares are priced apart.
export function costUsd(usage: CallUsage, pricing: ModelPricing): number {
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const plain = Math.max(0, usage.inputTokens - read - write);
  return (
    (plain * pricing.inputPerMTok +
      read * pricing.cacheReadPerMTok +
      write * pricing.cacheWritePerMTok +
      usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}

// Used before any run has finished and no smoke report exists: about four model
// calls per question, each resending the system prompt, the tool definitions and
// the tool results so far, with no credit for caching.
export const ASSUMED_RUN_USAGE: CallUsage = { inputTokens: 40_000, outputTokens: 2_000 };

// One judge call before any has been measured. In: the judge prompt (about 520
// tokens) plus the question, answer, proposals, facts and criteria (about 170
// on average over the fixtures), rounded up. Out: the verdicts and the judge's
// thinking at medium effort, a guess with headroom.
export const ASSUMED_JUDGE_USAGE: CallUsage = { inputTokens: 1_200, outputTokens: 800 };

// The spending cap. Each finished model call is metered as it returns, and a
// new run starts only if the money spent, plus what the runs still going are
// expected to cost beyond what they have already spent, plus this one, stays
// under the cap. Counting a running run's spend and its full estimate would
// charge the same calls twice.
export class Budget {
  private spent = 0;
  private inFlight = 0;
  // Already in `spent`: what the runs still going have cost so far.
  private inFlightSpent = 0;
  private finishedRuns = 0;
  private finishedSpend = 0;

  constructor(
    readonly maxUsd: number,
    private readonly pricing: ModelPricing,
    private readonly fallbackPerRunUsd: number,
  ) {}

  get spentUsd(): number {
    return this.spent;
  }

  // The observed average once a run has finished, the fallback before.
  get perRunUsd(): number {
    return this.finishedRuns > 0 ? this.finishedSpend / this.finishedRuns : this.fallbackPerRunUsd;
  }

  record(usage: CallUsage): void {
    this.recordUsd(costUsd(usage, this.pricing));
  }

  // Spend priced elsewhere, such as the judge's calls on its own model.
  recordUsd(cost: number): void {
    this.spent += cost;
    this.inFlightSpent += cost;
  }

  get running(): number {
    return this.inFlight;
  }

  tryStart(): boolean {
    const stillOwed = Math.max(0, this.inFlight * this.perRunUsd - this.inFlightSpent);
    if (this.spent + stillOwed + this.perRunUsd > this.maxUsd) return false;
    this.inFlight += 1;
    return true;
  }

  finish(runSpendUsd: number): void {
    this.inFlight -= 1;
    this.inFlightSpent = Math.max(0, this.inFlightSpent - runSpendUsd);
    this.finishedRuns += 1;
    this.finishedSpend += runSpendUsd;
  }
}

// Wraps a client so every response's usage reaches the meter, even for a run
// that later throws.
export class MeteredLlm implements LlmClient {
  spentUsd = 0;
  constructor(
    private readonly inner: LlmClient,
    private readonly pricing: ModelPricing,
    private readonly onUsage: (usage: CallUsage) => void,
  ) {}

  async respond(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.inner.respond(request);
    if (response.usage) {
      this.spentUsd += costUsd(response.usage, this.pricing);
      this.onUsage(response.usage);
    }
    return response;
  }
}

// An error after which no later call can succeed, so the run stops instead of
// scoring a string of failures that are not the model's. The SDK has already
// retried 529 by the time one reaches here, so it counts as repeated. A 429 is
// not fatal: see infraReason.
export class FatalApiError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "FatalApiError";
  }
}

export function fatalReason(error: unknown): string | undefined {
  if (error instanceof FatalApiError) return error.reason;
  if (!(error instanceof Anthropic.APIError)) return undefined;
  if (error.status === 401) return "authentication failed (401)";
  if (error.status === 403) return "permission denied (403)";
  if (error.status === 402 || error.type === "billing_error") return "billing error (402)";
  // Typically a model id the API does not know; every call would fail the same way.
  if (error.status === 404) return "model or endpoint not found (404)";
  // The API reports an exhausted balance as a 400 with no dedicated code, so
  // this one case has to read the message.
  if (error.status === 400 && /credit balance/i.test(`${error.apiMessage ?? ""} ${error.message}`)) {
    return "credit balance too low (400)";
  }
  if (error.status === 529 || error.type === "overloaded_error") return "API still overloaded after retries (529)";
  return undefined;
}

// A 400 that is not about credit means the request itself was malformed. It
// is scored as the run's failure, but a few of them point at a bug in how
// requests are built, which would fail every later run the same way.
export const MAX_BAD_REQUESTS = 3;

export function badRequestReason(error: unknown): string | undefined {
  if (!(error instanceof Anthropic.APIError) || error.status !== 400) return undefined;
  return `${error.apiMessage ?? error.message}`.slice(0, 200);
}

// A server error (5xx other than 529) or a rate limit (429) that outlasted the
// SDK's retries. It says nothing about the model, so the run is neither passed
// nor failed: it is retried once after a pause, then left out of scoring and
// counted on its own line. Several in a row mean the API is down or the limit
// is far too tight, and the run stops.
export const MAX_CONSECUTIVE_INFRA_ERRORS = 3;

export class InfraApiError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "InfraApiError";
  }
}

export function infraReason(error: unknown): string | undefined {
  if (error instanceof InfraApiError) return error.reason;
  // A dropped connection (a network blip, a laptop waking from sleep) says
  // nothing about the model; a dead network still stops the run after three.
  if (error instanceof Anthropic.APIConnectionError) return "the API could not be reached";
  if (!(error instanceof Anthropic.APIError) || typeof error.status !== "number") return undefined;
  if (error.status === 429) return "still rate limited after retries (429)";
  if (error.status >= 500 && error.status < 600 && error.status !== 529) return `server error after retries (${error.status})`;
  return undefined;
}
