import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AddressInfo } from "node:net";
import { type Server, request } from "node:http";
import { readFileSync, readdirSync } from "node:fs";

import {
  type ActionGateBundle,
  type ActionHandler,
  HandlerRegistry,
  priceChangeHandler,
  reviewReplyHandler,
} from "../../lib/safety/index.js";
import { type LlmRequest, type LlmResponse, createDemoGate } from "../../lib/agent/index.js";
import { createApp } from "../../lib/web/server.js";
import { demoReviewClassifier } from "../../lib/agent/review-classifier.js";
import { SAMPLE_REVIEWS, withSampleLabels } from "../../lib/web/sample-reviews.js";
import { CommandLlm } from "./command-llm.js";

let server: Server;
let base: string;
let bundle: ActionGateBundle;

async function listen(app: Server): Promise<string> {
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const { port } = app.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const close = (app: Server) => new Promise<void>((resolve) => app.close(() => resolve()));

// A fresh server and gate for every test, so no test depends on what an
// earlier one proposed or approved.
beforeEach(async () => {
  bundle = createDemoGate();
  server = createApp({ llm: new CommandLlm(), mode: "demo", bundle });
  base = await listen(server);
});

afterEach(async () => {
  await close(server);
});

const get = (path: string) => fetch(`${base}${path}`);
const post = (path: string, body?: unknown, root = base) =>
  fetch(`${root}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// fetch() won't let a test set Host, so this goes through node:http.
function statusWithHost(host: string): Promise<number> {
  const port = new URL(base).port;
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/proposals", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

const isListed = async (id: string) =>
  ((await body(await get("/api/proposals"))).proposals as Array<{ id: string }>).some((p) => p.id === id);

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe("createLlmClient", () => {
  it("uses the real model only when a non-blank key is set", async () => {
    const { createLlmClient } = await import("../../lib/web/server.js");
    const saved = process.env["ANTHROPIC_API_KEY"];
    try {
      process.env["ANTHROPIC_API_KEY"] = "   ";
      expect(createLlmClient().mode).toBe("demo");
      process.env["ANTHROPIC_API_KEY"] = "sk-test";
      expect(createLlmClient().mode).toBe("anthropic");
    } finally {
      if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });
});

describe("internal errors", () => {
  it("answers 500 with a request id, logging the error server-side without leaking it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = createApp({ llm: { respond: async () => Promise.reject(new Error("secret detail")) } });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const { port } = failing.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "anything" }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("secret detail");
      const { requestId } = JSON.parse(text) as { requestId: string };
      expect(logged.mock.calls.some((c) => String(c[0]).includes(requestId) && String(c[1]).includes("secret detail"))).toBe(true);
    } finally {
      logged.mockRestore();
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });
});

describe("web server", () => {
  it("serves the app shell and its assets with a strict CSP", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(res.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("Counter");
    expect((await get("/app.js")).status).toBe(200);
    expect((await get("/markdown.js")).status).toBe(200);
    expect((await get("/markdown.d.ts")).status).toBe(404);
    expect((await get("/styles.css")).status).toBe(200);
  });

  it("serves every module the page imports", async () => {
    const dir = new URL("../../lib/web/public/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
    const imported = files.flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/from "(\/[\w-]+\.js)"/g)].map((m) => m[1]!));
    expect(imported).toContain("/queue.js");
    for (const path of new Set(imported)) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/text\/javascript/);
    }
  });

  it("reports the model mode on /api/health", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    const health = await body(res);
    expect(health).toMatchObject({ ok: true, mode: "demo" });
    // Any model but the offline demo gets the four starter questions.
    expect(health.suggestions).toEqual([
      "How did last week compare with the week before?",
      "Is my tomato supplier overcharging me?",
      "Which items on the menu have a thin margin?",
      "What are customers saying?",
    ]);
  });

  it("returns the morning brief as sales, a headline and more lines, never the raw action spec", async () => {
    const brief = await body(await get("/api/brief"));
    // Sales first, then findings by money at stake: £429.26 of staff cost on a
    // day with no sales outranks the £3.20 tomato overcharge.
    expect(brief.sales).toMatch(/^Saturday's sales were £1,873\.00, down 4% on the Saturday before/);
    expect(brief.sales).toContain('The manager\'s note for Saturday 31 October: "Halloween.');
    expect(brief.headline).toBe("Data issue: Sunday booked £429.26 of staff cost with no recorded sales. Check the till and the rota.");
    expect(Object.keys(brief)).toEqual(["latestDay", "sales", "headline", "more", "suggestion"]);
    // The note is dated by the data, not by the browser's clock.
    expect(brief.latestDay).toBe("2026-11-08");
    expect(brief.more).toHaveLength(3);
    expect(brief.more[0]).toMatch(/^Ham & Cheese Toastie sells well but earns £2\.70 an item/);
    expect(brief.more[1]).toMatch(/^Tuesday staff cost is 39% of sales/);
    expect(brief.more[2]).toMatch(/^Your latest invoice is £12\.00 over the agreed prices across six lines\. The biggest is tomatoes/);
    // The suggestion is the owner-facing summary, never the spec with its sku.
    expect(brief.suggestion).toBe("Change Ham & Cheese Toastie price from £6.50 to £7.15");
    expect(brief).not.toHaveProperty("suggestedAction");
  });

  it("answers a question with the tool's real numbers and proposes nothing", async () => {
    const res = await post("/api/ask", { question: "Is my tomato supplier overcharging me?" });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.body).toContain("17.8");
    expect(b.body).toContain("£3.20");
    expect(b.proposals).toHaveLength(0);
    // The status lines are the server's, kept apart from the model's words.
    expect(b.status).toEqual([{ kind: "none", text: "No change was proposed." }]);
    expect(b).not.toHaveProperty("text");
  });

  it("creates a pending proposal from a chat request without executing it", async () => {
    const asked = await body(await post("/api/ask", { question: "Raise avocado toast to £8.50." }));
    expect(asked.proposals).toHaveLength(1);
    const id = asked.proposals[0].id;
    expect(asked.proposals[0].kind).toBe("price_change");

    const listed = await body(await get("/api/proposals"));
    expect(listed.proposals.some((p: { id: string }) => p.id === id)).toBe(true);
  });

  it("executes only after approval, and is conflict-safe on a second decision", async () => {
    const asked = await body(await post("/api/ask", { question: "Raise flat white to £3.60." }));
    const id = asked.proposals[0].id;
    const pending = (await body(await get("/api/proposals"))).proposals.find((p: { id: string }) => p.id === id);
    expect(pending?.status).toBe("pending");
    expect(bundle.sink.applied().some((c) => c.actionId === id)).toBe(false);

    const approved = await post(`/api/proposals/${id}/approve`);
    expect(approved.status).toBe(200);
    expect((await body(approved)).status).toBe("executed");
    expect(bundle.sink.applied().filter((c) => c.actionId === id)).toHaveLength(1);
    expect(await isListed(id)).toBe(false);

    // Rejecting an already-approved action is refused with a conflict, not a crash.
    const conflict = await post(`/api/proposals/${id}/reject`);
    expect(conflict.status).toBe(409);
  });

  it("rejects a proposal without touching the real world", async () => {
    const asked = await body(await post("/api/ask", { question: "Raise latte to £3.80." }));
    const id = asked.proposals[0].id;
    const rejected = await post(`/api/proposals/${id}/reject`);
    expect(rejected.status).toBe(200);
    expect((await body(rejected)).status).toBe("rejected");
    expect(await isListed(id)).toBe(false);
    expect(bundle.store.get(id)?.status).toBe("rejected");
    expect(bundle.sink.applied().some((c) => c.actionId === id)).toBe(false);
  });

  it("refuses a reserved or blank approver with 400 and leaves the proposal pending", async () => {
    const id = (await body(await post("/api/ask", { question: "Raise mocha to £4.20." }))).proposals[0].id;
    expect((await post(`/api/proposals/${id}/approve`, { approver: "agent" })).status).toBe(400);
    expect((await post(`/api/proposals/${id}/approve`, { approver: "  " })).status).toBe(400);
    expect((await post(`/api/proposals/${id}/reject`, { approver: "agent" })).status).toBe(400);
    expect(bundle.store.get(id)?.status).toBe("pending");
  });

  it("refuses the old reuse flag on an approval: there is no bank of reused replies", async () => {
    const id = (await body(await post("/api/ask", { question: "Reply to rev-4" }))).proposals[0].id;
    expect((await post(`/api/proposals/${id}/approve`, { reusable: true })).status).toBe(400);
    expect(bundle.store.get(id)?.status).toBe("pending");
    expect((await body(await get("/api/proposals"))).proposals[0]).not.toHaveProperty("reuse");
  });

  it("refuses a decision body with an unknown field (strict schema)", async () => {
    const id = (await body(await post("/api/ask", { question: "Raise chai latte to £3.90." }))).proposals[0].id;
    const res = await post(`/api/proposals/${id}/approve`, { approver: "owner", force: true });
    expect(res.status).toBe(400);
    expect(bundle.store.get(id)?.status).toBe("pending");
  });

  it("records a custom approver name on the approved action", async () => {
    const id = (await body(await post("/api/ask", { question: "Raise hot chocolate to £3.70." }))).proposals[0].id;
    const res = await post(`/api/proposals/${id}/approve`, { approver: "Sam" });
    expect(res.status).toBe(200);
    expect(bundle.store.get(id)).toMatchObject({ status: "executed", approvedBy: "Sam" });
    expect(bundle.audit.entries().find((e) => e.actionId === id && e.type === "approved")?.actor).toBe("Sam");
  });

  it("404s a decision on an unknown proposal id", async () => {
    expect((await post("/api/proposals/does-not-exist/approve")).status).toBe(404);
  });

  it("validates the ask body and rejects a bad one with 400", async () => {
    expect((await post("/api/ask", { question: "" })).status).toBe(400);
    expect((await post("/api/ask", { nope: 1 })).status).toBe(400);
    const badJson = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
  });

  it("rejects an oversized body with a clean 413", async () => {
    const res = await post("/api/ask", { question: "x".repeat(70 * 1024) });
    expect(res.status).toBe(413);
  });

  it("refuses a non-JSON content-type on a mutating request (415)", async () => {
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ question: "Raise avocado toast to £8.50." }),
    });
    expect(res.status).toBe(415);
    // A simple request a foreign page may send without a preflight: JSON only
    // as a parameter, not as the type.
    const smuggled = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "content-type": "text/plain; x=application/json" },
      body: JSON.stringify({ question: "Raise avocado toast to £8.50." }),
    });
    expect(smuggled.status).toBe(415);
  });

  it("refuses a cross-origin mutating request (403) and creates nothing", async () => {
    const before = (await body(await get("/api/proposals"))).proposals.length;
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ question: "Raise avocado toast to £8.50." }),
    });
    expect(res.status).toBe(403);
    expect((await body(await get("/api/proposals"))).proposals.length).toBe(before);
  });

  it("accepts a same-origin Origin header on /api/ask", async () => {
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ question: "Is my tomato supplier overcharging me?" }),
    });
    expect(res.status).toBe(200);
    expect((await body(res)).body).toContain("17.8");
  });

  it("refuses a cross-origin approve (403)", async () => {
    const asked = await body(await post("/api/ask", { question: "Raise cortado to £3.20." }));
    const id = asked.proposals[0].id;
    const res = await fetch(`${base}/api/proposals/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    const listed = await body(await get("/api/proposals"));
    expect(listed.proposals.some((p: { id: string }) => p.id === id)).toBe(true);
  });

  it("refuses a request addressed to a foreign Host (DNS rebinding)", async () => {
    const port = new URL(base).port;
    expect(await statusWithHost(`evil.example:${port}`)).toBe(403);
    expect(await statusWithHost(`localhost:${port}`)).toBe(200);
  });

  it("refuses a bare localhost Host when the server is not on port 80", async () => {
    expect(await statusWithHost("localhost")).toBe(403);
  });

  it("refuses a request that did not arrive on a loopback address, whatever its Host says", async () => {
    const { hostAllowed } = await import("../../lib/web/guards.js");
    const req = (localAddress: string) =>
      ({ socket: { localAddress, localPort: 8787 }, headers: { host: "127.0.0.1:8787" } }) as unknown as Parameters<typeof hostAllowed>[0];
    expect(hostAllowed(req("192.168.1.20"))).toBe(false);
    expect(hostAllowed(req("127.0.0.1"))).toBe(true);
    expect(hostAllowed(req("::1"))).toBe(true);
  });

  it("405s a wrong method and 404s an unknown path", async () => {
    expect((await get("/api/brief/suggestion")).status).toBe(405);
    expect((await post("/api/brief")).status).toBe(405);
    expect((await get("/api/nope")).status).toBe(404);
  });
});

describe("conversation history", () => {
  it("sends a conversation's earlier turns with a follow-up, and keeps conversations apart", async () => {
    const seen: LlmRequest[] = [];
    const llm = {
      respond: async (request: LlmRequest): Promise<LlmResponse> => {
        seen.push({ ...request, messages: [...request.messages] });
        // No digits, so the grounding check has nothing to correct.
        return { stop: "end", blocks: [{ type: "text", text: `answer ${"abcdefgh"[seen.length - 1]}` }] };
      },
    };
    const app = createApp({ llm });
    const root = await listen(app);
    try {
      const ask = (question: string, conversationId?: string) =>
        post("/api/ask", { question, ...(conversationId ? { conversationId } : {}) }, root);
      expect((await ask("first?", "conv-aaaa-1111")).status).toBe(200);
      await ask("and the second one?", "conv-aaaa-1111");
      await ask("unrelated", "conv-bbbb-2222");
      await ask("no id");
      const texts = (r: LlmRequest) => r.messages.map((m) => (m.blocks[0]?.type === "text" ? m.blocks[0].text : ""));
      expect(texts(seen[1]!)).toEqual(["first?", "answer a", "and the second one?"]);
      expect(texts(seen[2]!)).toEqual(["unrelated"]);
      expect(texts(seen[3]!)).toEqual(["no id"]);
      expect((await ask("bad id", "x")).status).toBe(400);
    } finally {
      await close(app);
    }
  });

  it("keeps both turns when two questions on one conversation are answered at once", async () => {
    const seen: string[][] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm = {
      respond: async (request: LlmRequest): Promise<LlmResponse> => {
        const texts = request.messages.map((m) => (m.blocks[0]?.type === "text" ? m.blocks[0].text : ""));
        seen.push(texts);
        // The first two wait for each other, so both read the same history.
        if (seen.length <= 2) await gate;
        return { stop: "end", blocks: [{ type: "text", text: `answer to ${texts.at(-1)}` }] };
      },
    };
    const app = createApp({ llm });
    const root = await listen(app);
    try {
      const ask = (question: string) => post("/api/ask", { question, conversationId: "conv-race-0001" }, root);
      const both = Promise.all([ask("first?"), ask("second?")]);
      while (seen.length < 2) await new Promise((r) => setTimeout(r, 5));
      release();
      await both;
      await ask("third?");
      expect(seen.at(-1)).toEqual(["first?", "answer to first?", "second?", "answer to second?", "third?"]);
    } finally {
      await close(app);
    }
  });
});

describe("execution failure, retry and withdrawal", () => {
  let app: Server;
  let root: string;
  let down = false;
  let failing: ActionGateBundle;

  beforeAll(async () => {
    const flakyPrice: ActionHandler = {
      kind: "price_change",
      execute(actionId, spec, sink) {
        if (down) throw new Error("POS unavailable");
        return priceChangeHandler.execute(actionId, spec, sink);
      },
    };
    const handlers = new HandlerRegistry().register(flakyPrice).register(reviewReplyHandler);
    failing = createDemoGate({ handlers });
    app = createApp({ llm: new CommandLlm(), mode: "demo", bundle: failing });
    root = await listen(app);
  });

  afterAll(async () => {
    await close(app);
  });

  it("keeps a failed execution approved and listed, retries it on a second approve, then refuses a reject", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const asked = await body(await post("/api/ask", { question: "Raise avocado toast to £8.50." }, root));
    const id = asked.proposals[0].id;

    down = true;
    const failed = await post(`/api/proposals/${id}/approve`, undefined, root);
    down = false;
    expect(failed.status).toBe(502);
    const failedBody = await body(failed);
    expect(failedBody).toMatchObject({ id, status: "approved", error: "execution failed, approve again to retry or reject to withdraw" });
    // The detail is logged on the server under the id the client gets, never sent.
    expect(JSON.stringify(failedBody)).not.toContain("POS unavailable");
    expect(failedBody.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(logged.mock.calls.some((c) => String(c[0]).includes(failedBody.requestId) && String(c[1]).includes("POS unavailable"))).toBe(true);

    const listed = (await body(await fetch(`${root}/api/proposals`))).proposals as Array<{ id: string; status: string }>;
    expect(listed.find((p) => p.id === id)?.status).toBe("approved");

    const retried = await post(`/api/proposals/${id}/approve`, undefined, root);
    expect(retried.status).toBe(200);
    expect(await body(retried)).toMatchObject({ id, status: "executed", result: { outcome: "Set avocado_toast price to £8.50" } });

    // Executed is final: a reject is a conflict.
    const late = await post(`/api/proposals/${id}/reject`, undefined, root);
    expect(late.status).toBe(409);
    expect((await body(late)).error).toMatch(/is executed/);
    logged.mockRestore();
  });

  it("lets the owner withdraw an approval whose send keeps failing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = (await body(await post("/api/ask", { question: "Raise latte to £3.80." }, root))).proposals[0].id;
    down = true;
    expect((await post(`/api/proposals/${id}/approve`, undefined, root)).status).toBe(502);
    expect((await post(`/api/proposals/${id}/approve`, undefined, root)).status).toBe(502);
    down = false;

    const withdrawn = await post(`/api/proposals/${id}/reject`, undefined, root);
    expect(withdrawn.status).toBe(200);
    expect(await body(withdrawn)).toEqual({ id, status: "rejected" });
    const listed = (await body(await fetch(`${root}/api/proposals`))).proposals as Array<{ id: string }>;
    expect(listed.some((p) => p.id === id)).toBe(false);
    expect(failing.sink.applied().some((c) => c.actionId === id)).toBe(false);
    expect(failing.audit.entries().at(-1)).toMatchObject({ type: "rejected", actor: "owner", detail: "withdrew an approval by owner; the action never ran" });
    // The approval held for the retry is gone with it.
    expect((await post(`/api/proposals/${id}/approve`, undefined, root)).status).toBe(409);
    logged.mockRestore();
  });

  it("answers 404 for an unknown proposal", async () => {
    expect((await post("/api/proposals/nope/approve", undefined, root)).status).toBe(404);
    expect((await post("/api/proposals/nope/reject", undefined, root)).status).toBe(404);
  });
});

describe("review-reply autopilot", () => {
  const PRIYA = SAMPLE_REVIEWS.find((s) => s.author === "Priya")!;
  const FIVE = "Thank you so much, {name}! We're glad you enjoyed your visit.";

  // Each test gets its own server, so none depends on another having run first.
  // `failOnSend` makes that numbered reply send fail once.
  async function autopilotApp(failOnSend?: number | readonly number[]) {
    let sends = 0;
    const flakyReply: ActionHandler = {
      kind: "review_reply",
      execute(actionId, spec, sink) {
        sends += 1;
        if ([failOnSend ?? []].flat().includes(sends)) throw new Error("reviews API down");
        return reviewReplyHandler.execute(actionId, spec, sink);
      },
    };
    const apBundle = createDemoGate({
      handlers: new HandlerRegistry().register(priceChangeHandler).register(flakyReply),
      classifier: withSampleLabels(demoReviewClassifier),
    });
    const app = createApp({ llm: new CommandLlm(), mode: "demo", bundle: apBundle });
    opened.push(app);
    const root = await listen(app);
    const send = (path: string, b: unknown, headers: Record<string, string> = {}) =>
      fetch(`${root}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
    const setting = (b: unknown, headers: Record<string, string> = {}) => send("/api/autopilot", b, headers);
    const template = (b: unknown, headers: Record<string, string> = {}) => send("/api/autopilot/templates", b, headers);
    const arrive = (b: unknown, headers: Record<string, string> = {}) => send("/api/reviews", b, headers);
    const ask = async (question: string) => body(await post("/api/ask", { question }, root));
    // Five replies posted by hand, to five different reviews.
    const unlock = async () => {
      for (const review of ["rev-1", "rev-3", "rev-4", "rev-5", "rev-6"]) {
        const id = (await ask(`Reply to ${review}`)).proposals[0].id;
        expect((await post(`/api/proposals/${id}/approve`, {}, root)).status).toBe(200);
      }
    };
    const switchOn = async () => {
      await unlock();
      expect((await template({ rating: 5, text: FIVE })).status).toBe(200);
      expect((await setting({ enabled: true, ratings: [5] })).status).toBe(200);
    };
    return { apBundle, root, setting, template, arrive, ask, unlock, switchOn };
  }

  const opened: Server[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map(close));
  });

  it("starts off and locked, with no templates", async () => {
    const { root } = await autopilotApp();
    const res = await fetch(`${root}/api/autopilot`);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      enabled: false,
      ratings: [],
      templates: {},
      approvedReplies: 0,
      required: 5,
      unlocked: false,
      eligibleRatings: [3, 4, 5],
      ownerRatings: [1, 2],
      withoutName: {},
    });
  });

  it("refuses to switch on before 5 replies were approved (409), and guards the request like other mutations", async () => {
    const { root, setting } = await autopilotApp();
    expect((await setting({ enabled: true, ratings: [5] })).status).toBe(409);
    expect((await setting({ enabled: true, ratings: [5] }, { origin: "http://evil.example" })).status).toBe(403);
    const plain = await fetch(`${root}/api/autopilot`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ enabled: true, ratings: [5] }),
    });
    expect(plain.status).toBe(415);
    expect((await setting({ enabled: true, ratings: [5], force: true })).status).toBe(400);
    expect((await setting({ enabled: "yes", ratings: [5] })).status).toBe(400);
    expect((await setting({ enabled: true, ratings: [9] })).status).toBe(400);
    expect((await fetch(`${root}/api/autopilot`, { method: "DELETE" })).status).toBe(405);
  });

  it("saves a template that passes the checks, shows how it reads without a name, and refuses one that fails with the reason", async () => {
    const { template, apBundle } = await autopilotApp();
    const saved = await template({ rating: 5, text: FIVE });
    expect(saved.status).toBe(200);
    expect(await body(saved)).toMatchObject({ templates: { "5": FIVE }, withoutName: { "5": "Thank you so much! We're glad you enjoyed your visit." } });
    expect(apBundle.audit.entries().at(-1)).toMatchObject({ type: "autopilot_changed", actor: "owner", detail: "reply template for 5 star reviews saved" });

    const refused = await template({ rating: 4, text: "Thanks {name}! Your next 2 coffees are free." });
    expect(refused.status).toBe(400);
    expect((await body(refused)).error).toBe("the template was not saved: no digits; no offers or promises such as refunds, discounts or anything free");
    expect((await template({ rating: 2, text: "Thanks." })).status).toBe(400);
    expect((await template({ rating: 5, text: FIVE, approver: "autopilot" })).status).toBe(400);
    expect((await template({ rating: 5, text: FIVE, extra: 1 })).status).toBe(400);
    expect(apBundle.gate.autopilotStatus().templates).toEqual({ "5": FIVE });
  });

  it("guards the template and review endpoints like other mutations", async () => {
    const { root, template, arrive } = await autopilotApp();
    expect((await template({ rating: 5, text: FIVE }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await arrive({ author: "Priya", rating: 5, text: "" }, { origin: "http://evil.example" })).status).toBe(403);
    for (const path of ["/api/autopilot/templates", "/api/reviews"]) {
      const plain = await fetch(`${root}${path}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
      expect(plain.status).toBe(415);
    }
    expect((await fetch(`${root}/api/autopilot/templates`)).status).toBe(405);
    expect((await fetch(`${root}/api/reviews`, { method: "DELETE" })).status).toBe(405);
    expect((await arrive({ author: "Priya", rating: 6, text: "" })).status).toBe(400);
    expect((await arrive({ author: "Priya", rating: 5, text: "", id: "rev-2" })).status).toBe(400);
    expect((await arrive({ author: "x".repeat(81), rating: 5, text: "" })).status).toBe(400);
    expect((await body(await fetch(`${root}/api/reviews`))).reviews).toEqual([]);
  });

  it("needs a saved template before a rating can be switched on", async () => {
    const { setting, template, unlock } = await autopilotApp();
    await unlock();
    const missing = await setting({ enabled: true, ratings: [4, 5] });
    expect(missing.status).toBe(400);
    expect((await body(missing)).error).toMatch(/write a reply template for 4, 5 star reviews/);
    expect((await template({ rating: 5, text: FIVE })).status).toBe(200);
    expect((await setting({ enabled: true, ratings: [5] })).status).toBe(200);
    expect((await template({ rating: 5, text: "" })).status).toBe(409);
  });

  it("posts the template when a clean 5 star review arrives, and lists the review as replied by autopilot", async () => {
    const { root, arrive, switchOn, apBundle } = await autopilotApp();
    await switchOn();
    const res = await arrive({ author: PRIYA.author, rating: PRIYA.rating, text: PRIYA.text });
    expect(res.status).toBe(200);
    const { review } = await body(res);
    expect(review).toMatchObject({
      author: "Priya",
      rating: 5,
      state: "replied",
      repliedBy: "autopilot",
      autopilot: "post",
      replyText: "Thank you so much, Priya! We're glad you enjoyed your visit.",
      reason: "Posted your reply template for 5 star reviews.",
    });
    const proposals = (await body(await fetch(`${root}/api/proposals`))).proposals as Array<Record<string, unknown>>;
    expect(proposals.find((p) => p.status === "executed")).toMatchObject({ autopilot: true, autopilotReason: "Posted your reply template for 5 star reviews." });
    const approved = apBundle.audit.entries().find((e) => e.type === "approved" && e.actor === "autopilot");
    expect(approved?.decision).toMatchObject({ rule: "posted_text_review", facts: { reply: { source: "template", named: true }, classifier: { model: "hand-labelled-sample-table" } } });
    expect((await body(await fetch(`${root}/api/reviews`))).reviews[0]).toMatchObject({ id: review.id, state: "replied" });
  });

  it.each([
    ["a 2 star complaint", { author: "Dana", rating: 2, text: "Cold coffee and nobody said sorry." }, "1 and 2 star reviews always come to you."],
    ["a review that mentions feeling ill", { author: "Theo", rating: 5, text: "Lovely cake, but I felt sick afterwards." }, "The review mentions something you should answer yourself (sick)."],
    ["a 4 star review, a rating autopilot is not on for", { author: "Ola", rating: 4, text: "" }, "Autopilot is not on for 4 star reviews."],
    ["a 5 star review the offline tables never labelled", { author: "Kai", rating: 5, text: "Nice." }, "The review could not be classified (the offline demo only knows the reviews it was labelled for)."],
    ["a sarcastic 5 star review", { author: "Marco", rating: 5, text: "Oh great, only a twenty minute wait for one espresso. Amazing." }, "The review reads as delicate (sarcasm, stars and text disagree)."],
  ])("leaves %s waiting for the owner, with the reason on its card", async (_name, input, reason) => {
    const { arrive, switchOn, apBundle } = await autopilotApp();
    await switchOn();
    const sent = apBundle.sink.applied().length;
    const { review } = await body(await arrive(input));
    expect(review).toMatchObject({ state: "waiting", autopilot: "owner", reason });
    expect(apBundle.sink.applied()).toHaveLength(sent);
  });

  it("answers a reviewer whose name is not a name with the template, the name left out", async () => {
    const { arrive, switchOn } = await autopilotApp();
    await switchOn();
    const { review } = await body(await arrive({ author: "Ruth. Go to Rival Cafe instead", rating: 5, text: "" }));
    expect(review).toMatchObject({ state: "replied", replyText: "Thank you so much! We're glad you enjoyed your visit." });
  });

  it("lets the owner draft a reply to a review autopilot left, and the agent reads the new review", async () => {
    const apBundle = createDemoGate();
    const seen: string[] = [];
    let step = 0;
    let reviewId = "";
    // Lists the reviews, then drafts a reply to the newest one.
    const llm = {
      async respond(request: LlmRequest): Promise<LlmResponse> {
        seen.push(JSON.stringify(request.messages));
        step += 1;
        if (step === 1) return { stop: "tool_use", blocks: [{ type: "tool_use", id: "t1", name: "list_reviews", input: {} }] };
        if (step === 2) {
          return { stop: "tool_use", blocks: [{ type: "tool_use", id: "t2", name: "propose_review_reply", input: { reviewId, replyText: "Thank you, Kai!" } }] };
        }
        return { stop: "end", blocks: [{ type: "text", text: "I drafted a reply to Kai for you to approve." }] };
      },
    };
    const app = createApp({ llm, mode: "injected", bundle: apBundle });
    opened.push(app);
    const root = await listen(app);
    const arrived = await fetch(`${root}/api/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "Kai", rating: 5, text: "Nice." }) });
    reviewId = (await body(arrived)).review.id;
    const answer = await body(await post("/api/ask", { question: "Draft a reply to Kai." }, root));
    expect(seen[1]).toContain(reviewId);
    expect(answer.proposals[0]).toMatchObject({ status: "pending", params: { reviewId, replyText: "Thank you, Kai!" } });
    expect((await body(await fetch(`${root}/api/reviews`))).reviews[0]).toMatchObject({ id: reviewId, state: "drafted" });
    expect((await post(`/api/proposals/${answer.proposals[0].id}/approve`, {}, root)).status).toBe(200);
    expect((await body(await fetch(`${root}/api/reviews`))).reviews[0]).toMatchObject({ state: "replied", repliedBy: "owner" });
  });

  it("keeps an autopilot reply that failed to send in the queue, and the owner's approve retries it", async () => {
    // The sixth send is the first one autopilot makes.
    const { root, arrive, switchOn } = await autopilotApp(6);
    await switchOn();
    const { review } = await body(await arrive({ author: "Lena", rating: 5, text: "" }));
    expect(review).toMatchObject({ state: "approved", reason: "Autopilot approved this reply, but sending it failed. Send it yourself or withdraw it." });
    const card = ((await body(await fetch(`${root}/api/proposals`))).proposals as Array<Record<string, any>>).find((p) => p.status === "approved")!;
    expect(card).toMatchObject({ autopilot: true, title: "Reply to Lena's review" });
    const retried = await post(`/api/proposals/${card.id}/approve`, undefined, root);
    expect(retried.status).toBe(200);
    expect(await body(retried)).toMatchObject({ status: "executed" });
    expect((await post(`/api/proposals/${card.id}/approve`, undefined, root)).status).toBe(409);
  });

  it("never posts a draft the agent proposes, even for a covered rating", async () => {
    const { ask, switchOn } = await autopilotApp();
    await switchOn();
    expect((await ask("Reply to rev-2")).proposals[0]).toMatchObject({ status: "pending", autopilot: false });
  });

  it("leaves price changes without an autopilot reason", async () => {
    const { ask } = await autopilotApp();
    const price = (await ask("Raise cortado to £3.20.")).proposals[0];
    expect(price.kind).toBe("price_change");
    expect(price).not.toHaveProperty("autopilotReason");
  });

  it("switches off, after which a new 5 star review waits for the owner with no reason shown", async () => {
    const { setting, arrive, switchOn } = await autopilotApp();
    await switchOn();
    const off = await setting({ enabled: false, ratings: [] });
    expect(off.status).toBe(200);
    const { review } = await body(await arrive({ author: "Lena", rating: 5, text: "" }));
    expect(review).toMatchObject({ state: "waiting", autopilot: "owner" });
    expect(review).not.toHaveProperty("reason");
  });

  it("offers the sample reviews, and the default offline app labels them so a clean one posts", async () => {
    const app = createApp({ llm: new CommandLlm(), mode: "demo" });
    opened.push(app);
    const root = await listen(app);
    const listed = await body(await fetch(`${root}/api/reviews`));
    expect(listed.samples.map((s: { author: string }) => s.author)).toEqual(SAMPLE_REVIEWS.map((s) => s.author));
    const { review } = await body(
      await fetch(`${root}/api/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: "Priya", rating: 5, text: PRIYA.text }) }),
    );
    // Autopilot is off on a fresh app, so it waits, but it was accepted and listed.
    expect(review).toMatchObject({ author: "Priya", state: "waiting", autopilot: "owner" });
  });
});

describe("one-tap brief suggestion", () => {
  const suggestion = "Change Ham & Cheese Toastie price from £6.50 to £7.15";

  it("proposes the brief's suggestion through the gate, leaving it pending for approval", async () => {
    const res = await post("/api/brief/suggestion", { suggestion });
    expect(res.status).toBe(200);
    const { proposal } = await body(res);
    expect(proposal).toMatchObject({ kind: "price_change", status: "pending", summary: suggestion });
    expect(proposal.params).toMatchObject({ sku: "ham_cheese_toastie", currentPriceMinor: 650, proposedPriceMinor: 715 });
    expect(bundle.store.get(proposal.id)?.status).toBe("pending");
    expect(bundle.sink.applied()).toHaveLength(0);
    expect(await isListed(proposal.id)).toBe(true);

    // Approving it in the queue is what applies it.
    expect((await post(`/api/proposals/${proposal.id}/approve`, {})).status).toBe(200);
    expect(bundle.sink.applied()).toHaveLength(1);
  });

  it("hands back the open proposal on a second tap instead of a duplicate", async () => {
    const first = (await body(await post("/api/brief/suggestion", { suggestion }))).proposal;
    const second = await post("/api/brief/suggestion", { suggestion });
    expect(second.status).toBe(200);
    const again = await body(second);
    expect(again.proposal.id).toBe(first.id);
    // The page says it is already waiting rather than added again.
    expect(again.alreadyWaiting).toBe(true);
    expect(bundle.store.entries()).toHaveLength(1);
  });

  it("names a different waiting change for the item instead of claiming this one was added", async () => {
    await post("/api/ask", { question: "Raise the ham and cheese toastie to £7.20" });
    const res = await post("/api/brief/suggestion", { suggestion });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("A different change for this item is already waiting: £6.50 to £7.20.");
    expect(bundle.store.entries()).toHaveLength(1);
  });

  it("writes an approved price back, so the brief stops suggesting it", async () => {
    const { proposal } = await body(await post("/api/brief/suggestion", { suggestion }));
    const approved = await body(await post(`/api/proposals/${proposal.id}/approve`, {}));
    expect(approved.result.outcome).toBe("Set Ham & Cheese Toastie price to £7.15");
    expect((await body(await get("/api/brief"))).suggestion).not.toBe(suggestion);
  });

  it("refuses a stale suggestion and proposes nothing", async () => {
    const res = await post("/api/brief/suggestion", { suggestion: "Change Latte price from £3.40 to £9.00" });
    expect(res.status).toBe(409);
    expect(bundle.store.entries()).toHaveLength(0);
  });

  it("is guarded like every other write", async () => {
    const res = await fetch(`${base}/api/brief/suggestion`, { method: "POST", body: JSON.stringify({ suggestion }) });
    expect(res.status).toBe(415);
    const foreign = await fetch(`${base}/api/brief/suggestion`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ suggestion }),
    });
    expect(foreign.status).toBe(403);
    expect(bundle.store.entries()).toHaveLength(0);
  });
});
