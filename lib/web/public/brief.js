// The morning note and its one-tap suggested change.

import { $, api, button, el } from "/dom.js";
import { addProposalCard } from "/queue.js";

// Dated by the newest day in the data, not the browser's clock: the note reads
// the café's figures up to that day.
function noteDate(latestDay) {
  const day = new Date(`${latestDay}T00:00:00Z`);
  return `Figures to ${day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}`;
}

function suggestionBlock(suggestion) {
  const box = el("div", "note-suggestion");
  box.appendChild(el("p", "note-label", "Suggested change"));
  box.appendChild(el("p", "note-suggestion-text", suggestion));
  const status = el("p", "note-status");
  status.setAttribute("role", "status");
  const prepare = button("prepare-button", "Prepare this change", async () => {
    prepare.disabled = true;
    status.textContent = "";
    try {
      const { proposal, alreadyWaiting } = await api("/api/brief/suggestion", { method: "POST", body: JSON.stringify({ suggestion }) });
      addProposalCard(proposal);
      prepare.remove();
      status.textContent = alreadyWaiting
        ? "This change is already waiting in your approvals. Nothing changes until you approve it."
        : "Added to your approvals. Nothing changes until you approve it.";
    } catch (err) {
      prepare.disabled = false;
      status.textContent = err.message;
    }
  });
  box.append(prepare, status);
  return box;
}

export async function loadBrief() {
  try {
    const brief = await api("/api/brief");
    const body = $("brief-body");
    body.textContent = "";
    if (brief.latestDay) {
      $("brief-date").textContent = noteDate(brief.latestDay);
      $("brief-date").setAttribute("datetime", brief.latestDay);
    }
    if (brief.sales) body.appendChild(el("p", "note-sales", brief.sales));
    body.appendChild(el("p", "note-label", "First thing"));
    body.appendChild(el("p", "note-headline", brief.headline));
    if (brief.more && brief.more.length) {
      body.appendChild(el("p", "note-label", "Also worth a look"));
      const list = el("ul", "note-more");
      for (const line of brief.more) list.appendChild(el("li", null, line));
      body.appendChild(list);
    }
    if (brief.suggestion) body.appendChild(suggestionBlock(brief.suggestion));
    $("brief").hidden = false;
  } catch {
    /* skip the note if it can't load */
  }
}
