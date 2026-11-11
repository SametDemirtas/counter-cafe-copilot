// Builds a gate with in-memory defaults for everything but the catalog.

import { randomUUID } from "node:crypto";

import { type AuditLog, InMemoryAuditLog } from "./audit.js";
import { ActionGate, type ActionGateDeps } from "./gate.js";
import { type EffectSink, InMemoryEffectSink, defaultHandlers } from "./handlers.js";
import { type ActionCatalog } from "./policy.js";
import { NO_CLASSIFIER } from "./review-classifier.js";
import { ReviewInbox } from "./review-inbox.js";
import { type ActionStore, InMemoryActionStore } from "./store.js";

export interface ActionGateBundle {
  readonly gate: ActionGate;
  // The catalog given, with every review that arrived since.
  readonly catalog: ActionCatalog;
  readonly store: ActionStore;
  readonly audit: AuditLog;
  readonly sink: EffectSink;
}

// The catalog is required: without the live menu and reviews the gate could not
// tell a sane price from a 1p one, so there is no permissive default.
export type ActionGateOptions = Pick<ActionGateDeps, "catalog"> & Partial<Omit<ActionGateDeps, "catalog">>;

export function createActionGate(overrides: ActionGateOptions): ActionGateBundle {
  const store = overrides.store ?? new InMemoryActionStore();
  const audit = overrides.audit ?? new InMemoryAuditLog();
  const sink = overrides.sink ?? new InMemoryEffectSink();
  const handlers = overrides.handlers ?? defaultHandlers();
  const gate = new ActionGate({
    catalog: new ReviewInbox(overrides.catalog),
    store,
    audit,
    handlers,
    sink,
    now: overrides.now ?? (() => new Date()),
    newId: overrides.newId ?? (() => randomUUID()),
    newToken: overrides.newToken ?? (() => randomUUID()),
    classifier: overrides.classifier ?? NO_CLASSIFIER,
  });
  return { gate, catalog: gate.catalog, store, audit, sink };
}
