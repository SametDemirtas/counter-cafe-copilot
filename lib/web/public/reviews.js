// New reviews as they arrive, with what autopilot did about each one, and a
// control that simulates a review arriving from the review site.

import { $, api, el } from "/dom.js";
import { addProposalCard } from "/queue.js";

const STATE_TEXT = {
  replied: "Replied",
  approved: "Reply approved, not sent yet",
  drafted: "Draft waiting for your approval",
  waiting: "Waiting for you",
};

function stars(rating) {
  return `${"★".repeat(rating)}${"☆".repeat(5 - rating)}`;
}

function reviewCard(r) {
  const card = el("li", "review-card");
  card.dataset.state = r.state;
  const head = el("div", "rv-head");
  head.append(el("span", "rv-stars", stars(r.rating)), el("span", "rv-author", r.author.trim() || "No name"));
  head.querySelector(".rv-stars").setAttribute("aria-label", `${r.rating} stars`);
  card.appendChild(head);
  card.appendChild(el("p", "rv-text", r.text.trim() ? r.text : "A rating with no text."));
  const by = r.repliedBy === "autopilot" ? "Autopilot posted your template" : STATE_TEXT[r.state];
  card.appendChild(el("p", "rv-state", by));
  if (r.replyText && r.state !== "waiting") card.appendChild(el("blockquote", "pc-reply", r.replyText));
  if (r.reason && r.repliedBy !== "autopilot") card.appendChild(el("p", "pc-reason", r.reason));
  if (r.state === "waiting") card.appendChild(el("p", "rv-hint", "Ask for a draft reply above, naming the reviewer."));
  return card;
}

function renderReviews(reviews) {
  const list = $("reviews-list");
  list.textContent = "";
  for (const r of reviews) list.appendChild(reviewCard(r));
  $("reviews-empty").hidden = reviews.length > 0;
}

function fillFromSample(sample) {
  $("sim-author").value = sample.author;
  $("sim-rating").value = String(sample.rating);
  $("sim-text").value = sample.text;
}

let samples = [];

function renderSamples() {
  const select = $("sim-sample");
  select.textContent = "";
  samples.forEach((s, i) => {
    const option = el("option", null, s.label);
    option.value = String(i);
    select.appendChild(option);
  });
  if (samples[0]) fillFromSample(samples[0]);
}

async function simulate(event) {
  event.preventDefault();
  const send = $("sim-send");
  send.disabled = true;
  const form = $("simulate");
  form.querySelector(".pc-error")?.remove();
  try {
    const body = { author: $("sim-author").value, rating: Number($("sim-rating").value), text: $("sim-text").value };
    await api("/api/reviews", { method: "POST", body: JSON.stringify(body) });
    await loadReviews();
    // A reply autopilot posted shows in the queue as sent.
    const { proposals } = await api("/api/proposals");
    for (const p of proposals) addProposalCard(p);
    document.dispatchEvent(new CustomEvent("proposal-decided"));
  } catch (err) {
    form.appendChild(el("p", "pc-error", err.message));
  } finally {
    send.disabled = false;
  }
}

export async function loadReviews() {
  try {
    const data = await api("/api/reviews");
    renderReviews(data.reviews);
    if (samples.length === 0) {
      samples = data.samples;
      renderSamples();
    }
  } catch {
    /* the list stays as it was if it can't load */
  }
}

export function initReviews() {
  $("simulate").addEventListener("submit", simulate);
  $("sim-sample").addEventListener("change", (e) => fillFromSample(samples[Number(e.target.value)]));
  loadReviews();
  document.addEventListener("proposal-decided", loadReviews);
}
