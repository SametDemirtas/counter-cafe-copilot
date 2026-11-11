import { type IncomingMessage, type ServerResponse } from "node:http";

import { type z } from "zod";

const MAX_BODY_BYTES = 64 * 1024;

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

// Resolves undefined on any failure, having already sent the error response
// (except when the request stream itself errors and there is no one to answer).
export async function readJson<T>(req: IncomingMessage, res: ServerResponse, schema: z.ZodType<T>): Promise<T | undefined> {
  const raw = await readBody(req, res);
  if (raw === undefined) return undefined;
  let parsed: unknown = {};
  if (raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "invalid JSON" });
      return undefined;
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    sendJson(res, 400, { error: "invalid request", issues: result.error.issues });
    return undefined;
  }
  return result.data;
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        // Destroy only after the 413 has flushed, or the client sees a reset.
        res.on("finish", () => req.destroy());
        sendJson(res, 413, { error: "request body too large" });
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      resolve(undefined);
    });
  });
}
