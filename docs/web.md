# The web UI and server

`npm run serve` opens one page with three parts: the morning note, an ask bar
with the conversation under it, and an approvals panel at the side. A reply
card shows the whole draft under the reviewer's name. The autopilot section of
the approvals panel shows progress towards the unlock and, once unlocked, the
per-rating settings.

## Trust boundary

The server (`lib/web/server.ts`) holds the full gate. The agent gets only the
propose-only port, so the UI cannot make an action run without approval any
more than the model can.

## Network and request handling

- It binds to 127.0.0.1 only and refuses to start if `HOST` names anything but
  loopback, since there is no login (`lib/web/guards.ts`).
- It answers only requests that arrive on a loopback socket with a loopback
  `Host` header, which blocks DNS rebinding.
- A mutating request must be `application/json` and may not carry a foreign
  `Origin`, which blocks cross-site form posts.
- Request bodies are capped at 64 KB and validated with `zod`.
- Static files come from a fixed whitelist (`lib/web/static.ts`), so there is no
  path to traverse. They are served with a strict `Content-Security-Policy`
  (`default-src 'none'`, scripts and styles from self only,
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`,
  `no-referrer` and `no-store`.
- Answers are rendered by a small markdown parser
  (`lib/web/public/markdown.js`) into DOM nodes with `textContent`, never
  `innerHTML`.
- An internal error is logged with a request id, and the client gets a generic
  message with that id.

## Conversation history

The server keeps a short text history per conversation (the last six turns,
each side capped at 2,000 characters), so a follow-up such as "and the second
one?" has context. Only the question and the answer text are kept. Earlier
answers are not a source for figures; the model has to call a tool again.

## Offline mode

Without `ANTHROPIC_API_KEY`, `lib/web/demo-llm.ts` stands in for the model. It
answers only the scripted questions the page offers as buttons
(`lib/web/demo-script.ts`), each with one tool call and a fixed template, and
the review classifier uses the hand-labelled table for the seven mock reviews.
With a key, the reviews are classified once at startup; until that finishes,
autopilot leaves every text review to the owner.
