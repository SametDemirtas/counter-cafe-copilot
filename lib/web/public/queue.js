// The approval queue: one card per proposal, approved or rejected by the owner.
// A decision fires "proposal-decided" on the document, so other panels can reload.

import { $, api, button, el } from "/dom.js";
import { decisionLabels, outcomeText, unsentAfterError } from "/queue-state.js";

const queued = new Map();

function kindLabel(kind) {
  if (kind === "price_change") return "Price change";
  if (kind === "review_reply") return "Review reply";
  return kind;
}

export function updateQueueCount() {
  const waiting = [...queued.values()].filter((c) => c.dataset.state === "waiting").length;
  $("queue-count").textContent = waiting > 0 ? String(waiting) : "";
  $("queue-empty").hidden = queued.size > 0;
}

function setOutcome(card, state, text) {
  card.dataset.state = state;
  card.querySelector(".pc-actions")?.remove();
  card.querySelector(".pc-outcome")?.remove();
  card.appendChild(el("p", "pc-outcome", text));
  updateQueueCount();
}

function cardHead(p) {
  const card = el("li", "proposal");
  card.dataset.kind = p.kind;
  const head = el("div", "pc-head");
  head.append(el("span", "pc-kind", kindLabel(p.kind)));
  card.appendChild(head);
  // A reply is approved word for word, so show all of it, not the summary.
  const fullReply = p.kind === "review_reply" && p.params && p.params.replyText;
  if (fullReply) {
    card.appendChild(el("p", "pc-summary", p.title || `Reply to review ${p.params.reviewId}`));
    card.appendChild(el("blockquote", "pc-reply", fullReply));
  } else {
    card.appendChild(el("p", "pc-summary", p.summary));
  }
  // Why autopilot sent this reply, or why it waits for the owner.
  if (p.autopilotReason) card.appendChild(el("p", "pc-reason", p.autopilotReason));
  return card;
}

// Approved but not sent: autopilot's send or the owner's own failed. The owner
// sends it again or withdraws it.
function label(approve, reject, p, unsent) {
  const labels = decisionLabels(p, unsent);
  approve.textContent = labels.approve;
  reject.textContent = labels.reject;
  approve.setAttribute("aria-label", `${approve.textContent}: ${p.summary}`);
  reject.setAttribute("aria-label", `${reject.textContent}: ${p.summary}`);
}

function decisionButtons(card, p) {
  let unsent = p.status === "approved";
  const actions = el("div", "pc-actions");
  const decide = async (decision) => {
    for (const b of actions.querySelectorAll("button")) b.disabled = true;
    card.querySelector(".pc-error")?.remove();
    try {
      const result = await api(`/api/proposals/${encodeURIComponent(p.id)}/${decision}`, { method: "POST", body: "{}" });
      setOutcome(card, result.status === "executed" ? "done" : "rejected", outcomeText(p, result, unsent));
      document.dispatchEvent(new CustomEvent("proposal-decided"));
    } catch (err) {
      for (const b of actions.querySelectorAll("button")) b.disabled = false;
      unsent = unsentAfterError(err.status, unsent);
      label(approve, reject, p, unsent);
      card.appendChild(el("p", "pc-error", err.message));
    }
  };
  const approve = button("pc-approve", "", () => decide("approve"));
  const reject = button("pc-reject", "", () => decide("reject"));
  label(approve, reject, p, unsent);
  actions.append(approve, reject);
  return actions;
}

// One card per proposal; a proposal already shown is not added twice.
export function addProposalCard(p) {
  if (queued.has(p.id)) return queued.get(p.id);
  const card = cardHead(p);
  queued.set(p.id, card);
  $("queue-list").prepend(card);

  if (p.autopilot && p.status === "executed") {
    // The card's reason already says autopilot sent it; the outcome line only
    // stands in when there is none.
    if (p.autopilotReason) {
      card.dataset.state = "done";
      updateQueueCount();
    } else {
      setOutcome(card, "done", "Sent by the autopilot rule you switched on.");
    }
    return card;
  }
  card.appendChild(decisionButtons(card, p));
  card.dataset.state = "waiting";
  updateQueueCount();
  return card;
}

export async function loadPendingProposals() {
  try {
    const { proposals } = await api("/api/proposals");
    for (const p of proposals) addProposalCard(p);
  } catch {
    /* the queue stays empty if it can't load */
  }
  updateQueueCount();
}
