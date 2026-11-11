import { type LlmClient, type LlmMessage, type LlmRequest, type LlmResponse } from "../../lib/agent/llm.js";
import { ReviewsSchema } from "../../lib/tools/reviews.js";
import reviewsJson from "../../lib/data/mock/reviews.json";
import { DemoLlmClient } from "../../lib/web/demo-llm.js";
import { draftReply } from "../../lib/web/demo-script.js";

const REVIEWS = ReviewsSchema.parse(reviewsJson);

// A test double for the server tests: two fixed command shapes become tool
// calls ("Raise avocado toast to £8.50.", "Reply to rev-2"); everything else,
// tool results included, goes to the offline demo.
export class CommandLlm implements LlmClient {
  private readonly demo = new DemoLlmClient();
  private calls = 0;

  async respond(request: LlmRequest): Promise<LlmResponse> {
    const last = request.messages.at(-1);
    const question = last?.role === "user" ? textOf(last) : undefined;
    const call = question === undefined ? undefined : command(question);
    if (!call) return this.demo.respond(request);
    this.calls += 1;
    return { stop: "tool_use", blocks: [{ type: "tool_use", id: `cmd-${this.calls}`, ...call }] };
  }
}

function textOf(message: LlmMessage): string | undefined {
  const block = message.blocks.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : undefined;
}

function command(question: string): { name: string; input: Record<string, unknown> } | undefined {
  const price = question.match(/^Raise (?:the )?(.+) to £(\d+)\.(\d\d)\.?$/);
  if (price) {
    const sku = price[1]!.replace(/ and /g, " ").replace(/\s+/g, "_");
    return { name: "propose_price_change", input: { sku, proposedPriceMinor: Number(price[2]) * 100 + Number(price[3]) } };
  }
  const reply = question.match(/^Reply to (rev-\d+)$/);
  const review = reply ? REVIEWS.find((r) => r.id === reply[1]) : undefined;
  return review ? { name: "propose_review_reply", input: { reviewId: review.id, replyText: draftReply(review) } } : undefined;
}
