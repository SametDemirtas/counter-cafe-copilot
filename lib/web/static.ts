import { type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sendJson } from "./http.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

export interface StaticEntry {
  readonly file: string;
  readonly type: string;
}

// A fixed whitelist, so there is no path to traverse.
export const STATIC: Readonly<Record<string, StaticEntry>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/dom.js": { file: "dom.js", type: "text/javascript; charset=utf-8" },
  "/queue.js": { file: "queue.js", type: "text/javascript; charset=utf-8" },
  "/queue-state.js": { file: "queue-state.js", type: "text/javascript; charset=utf-8" },
  "/brief.js": { file: "brief.js", type: "text/javascript; charset=utf-8" },
  "/autopilot.js": { file: "autopilot.js", type: "text/javascript; charset=utf-8" },
  "/reviews.js": { file: "reviews.js", type: "text/javascript; charset=utf-8" },
  "/markdown.js": { file: "markdown.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function serveStatic(res: ServerResponse, entry: StaticEntry): Promise<void> {
  try {
    const content = await readFile(join(PUBLIC_DIR, entry.file));
    res.writeHead(200, {
      "content-type": entry.type,
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}
