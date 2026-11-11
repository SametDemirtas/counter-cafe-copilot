// The owner's autopilot panel for review replies: one reply template per star
// rating, and a switch per rating that only a saved template can turn on.

import { $, api, button, el } from "/dom.js";

// Text the owner typed but has not saved, so a refresh does not wipe it.
function unsavedDrafts(box) {
  const drafts = new Map();
  for (const area of box.querySelectorAll(".ap-template")) {
    if (area.value !== area.dataset.saved) drafts.set(area.closest(".ap-rating").dataset.rating, area.value);
  }
  return drafts;
}

function renderAutopilot(s) {
  const box = $("autopilot");
  const drafts = unsavedDrafts(box);
  box.textContent = "";
  box.hidden = false;
  box.appendChild(el("h3", "autopilot-title", "Autopilot for review replies"));
  const count = Math.min(s.approvedReplies, s.required);
  box.appendChild(
    el(
      "p",
      "autopilot-text",
      s.unlocked
        ? "When a new review arrives at a ticked rating, autopilot can post your template for it."
        : `${count} of ${s.required} replies approved by hand; ${s.required} unlock it. You can write your templates now.`,
    ),
  );
  for (const rating of s.eligibleRatings) box.appendChild(ratingRow(s, rating, drafts.get(String(rating))));
  box.appendChild(el("p", "autopilot-text", ruleText(s.ownerRatings)));
}

function ratingRow(s, rating, draft) {
  const key = String(rating);
  const saved = s.templates[key];
  const row = el("div", "ap-rating");
  row.dataset.rating = key;
  const label = el("label", "ap-switch");
  const check = el("input");
  check.type = "checkbox";
  check.checked = s.enabled && s.ratings.includes(rating);
  check.disabled = !s.unlocked || saved === undefined;
  check.addEventListener("change", saveSwitch);
  label.append(check, document.createTextNode(`${rating} stars`));
  row.appendChild(label);

  const area = el("textarea", "ap-template");
  area.rows = 2;
  area.maxLength = 1000;
  area.placeholder = `Your reply to ${rating} star reviews, e.g. "Thank you so much, {name}! We're glad you enjoyed your visit."`;
  area.dataset.saved = saved ?? "";
  area.value = draft ?? saved ?? "";
  area.setAttribute("aria-label", `Reply template for ${rating} star reviews`);
  const save = button("ap-save", "Save template", () => saveTemplate(rating, area.value, row));
  row.append(area, save);
  if (saved !== undefined && saved.includes("{name}")) {
    row.appendChild(el("p", "ap-preview", `If the reviewer's name can't be used: "${s.withoutName[key]}"`));
  } else if (saved === undefined) {
    row.appendChild(el("p", "ap-preview", "No template yet, so these reviews always come to you."));
  }
  return row;
}

// Worded from the ratings the server says always come to the owner.
function ruleText(ownerRatings) {
  const names = ownerRatings.map(String);
  const stars = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  const always = stars ? `${stars} star reviews always come to you, and so does any` : "Any";
  return `${always} review that reads as delicate. Autopilot posts only your template, with {name} filled in when the reviewer's name is a plain first name.`;
}

function showError(where, message) {
  where.querySelector(".pc-error")?.remove();
  where.appendChild(el("p", "pc-error", message));
}

async function saveTemplate(rating, text, row) {
  try {
    const status = await api("/api/autopilot/templates", { method: "POST", body: JSON.stringify({ rating, text }) });
    // The saved text replaces the draft for this rating.
    const area = row.querySelector(".ap-template");
    area.dataset.saved = area.value;
    renderAutopilot(status);
  } catch (err) {
    // The owner's text stays in the box so they can fix it.
    showError(row, err.message);
  }
}

async function saveSwitch() {
  const box = $("autopilot");
  const ratings = [...box.querySelectorAll(".ap-switch input")].filter((c) => c.checked).map((c) => Number(c.closest(".ap-rating").dataset.rating));
  try {
    renderAutopilot(await api("/api/autopilot", { method: "POST", body: JSON.stringify({ enabled: ratings.length > 0, ratings }) }));
  } catch (err) {
    // Show the server's state again, not the boxes as clicked, then the error.
    await loadAutopilot();
    showError(box, err.message);
  }
}

export async function loadAutopilot() {
  try {
    renderAutopilot(await api("/api/autopilot"));
  } catch {
    $("autopilot").hidden = true;
  }
}
