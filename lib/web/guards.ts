import { type IncomingMessage, type ServerResponse } from "node:http";

import { sendJson } from "./http.js";

// The server has no login, so it only ever listens on loopback. A LAN client
// could otherwise send "Host: 127.0.0.1" and approve prices.
export const BIND_ADDRESS = "127.0.0.1";

// main.ts binds to 127.0.0.1 only. The IPv6 forms stay so this check does not
// depend on how a caller of createApp chose to listen.
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// HOST is not an override: anything but loopback is refused, so nobody expects
// a LAN binding they are not getting.
export function bindAddress(env: NodeJS.ProcessEnv): string {
  const asked = env["HOST"];
  if (asked !== undefined && asked !== "" && !["127.0.0.1", "localhost", "::1"].includes(asked)) {
    throw new Error(`HOST=${asked} is not allowed: Counter has no login, so it only listens on ${BIND_ADDRESS}.`);
  }
  return BIND_ADDRESS;
}

// Loopback names only. Otherwise a DNS-rebinding page (evil.example pointed at
// 127.0.0.1) counts as same-origin and could read and approve proposals. The
// socket must be loopback too, so a spoofed Host from another machine fails.
export function hostAllowed(req: IncomingMessage): boolean {
  if (!LOOPBACK_ADDRESSES.has(req.socket.localAddress ?? "")) return false;
  const port = req.socket.localPort;
  const host = req.headers.host ?? "";
  const names = ["127.0.0.1", "localhost", "[::1]"];
  // On port 80 a browser sends the bare name with no port.
  return names.some((n) => host === `${n}:${port}` || (port === 80 && host === n));
}

// CSRF: a JSON content type forces a preflight that is never answered, and a
// foreign Origin is refused outright. Sends the error itself when it blocks.
export function crossOriginBlocked(req: IncomingMessage, res: ServerResponse): boolean {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    sendJson(res, 415, { error: "content-type must be application/json" });
    return true;
  }
  const origin = req.headers.origin;
  const host = req.headers.host ?? "";
  if (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    sendJson(res, 403, { error: "cross-origin request refused" });
    return true;
  }
  return false;
}
