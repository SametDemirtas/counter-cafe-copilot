// The page's entry point: the question box and its answers. The queue, the
// morning note, the new reviews and the autopilot panel live in their own modules.

import { $, api, button, el } from "/dom.js";
import { parseMarkdown } from "/markdown.js";
import { addProposalCard, loadPendingProposals } from "/queue.js";
import { loadBrief } from "/brief.js";
import { loadAutopilot } from "/autopilot.js";
import { initReviews, loadReviews } from "/reviews.js";

function appendInlines(node, inlines) {
  for (const part of inlines) {
    node.appendChild(part.type === "strong" ? el("strong", null, part.text) : document.createTextNode(part.text));
  }
  return node;
}

function renderBlock(block) {
  if (block.type === "paragraph") return appendInlines(el("p"), block.inlines);
  if (block.type === "bullets" || block.type === "numbered") {
    const list = el(block.type === "bullets" ? "ul" : "ol");
    for (const item of block.items) list.appendChild(appendInlines(el("li"), item));
    return list;
  }
  const wrap = el("div", "table-wrap");
  const table = el("table");
  const head = el("tr");
  for (const cell of block.header) head.appendChild(appendInlines(el("th"), cell));
  table.appendChild(el("thead")).appendChild(head);
  const body = table.appendChild(el("tbody"));
  for (const row of block.rows) {
    const tr = el("tr");
    for (const cell of row) tr.appendChild(appendInlines(el("td"), cell));
    body.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

// Paragraphs, lists, tables and **bold**, built from parsed data with textContent only.
function setFormatted(node, text) {
  node.textContent = "";
  node.classList.add("answer");
  for (const block of parseMarkdown(text)) node.appendChild(renderBlock(block));
}

// ---- Questions and answers ----

// The server says which questions to offer: the offline demo answers only these.
function addSuggestions(suggestions) {
  const wrap = $("suggestions");
  wrap.textContent = "";
  for (const q of suggestions) wrap.appendChild(button("chip", q, () => submitQuestion(q)));
}

function addEntry(question) {
  const entry = el("li", "entry");
  entry.appendChild(el("p", "entry-question", question));
  const answer = el("div", "entry-answer pending");
  answer.appendChild(el("span", "thinking", "Looking at your numbers…"));
  entry.appendChild(answer);
  $("log").prepend(entry);
  return { entry, answer };
}

// One conversation per page load: a reload starts afresh.
const conversationId = crypto.randomUUID();

// One question at a time, so each answer sees the turns before it.
let inFlight = false;

async function submitQuestion(question) {
  const q = question.trim();
  if (!q || inFlight) return;
  inFlight = true;
  const input = $("question");
  input.value = "";
  resizeInput();
  $("send").disabled = true;

  const { entry, answer } = addEntry(q);
  try {
    const reply = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: q, conversationId }) });
    answer.classList.remove("pending");
    setFormatted(answer, reply.body);
    // What happened to any proposal, written by the server, not the model.
    const status = el("ul", "entry-status");
    for (const line of reply.status || []) status.appendChild(el("li", null, line.text));
    if (status.childElementCount > 0) answer.appendChild(status);
    for (const p of reply.proposals || []) addProposalCard(p);
    // A draft to a new review changes what its card says.
    if ((reply.proposals || []).length > 0) loadReviews();
  } catch (err) {
    answer.classList.remove("pending");
    answer.textContent = `Something went wrong: ${err.message}`;
  } finally {
    inFlight = false;
    $("send").disabled = false;
    input.focus();
    entry.scrollIntoView({ block: "nearest" });
  }
}

function resizeInput() {
  const input = $("question");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

// ---- Header ----

async function loadHealth() {
  try {
    const { mode, suggestions } = await api("/api/health");
    $("mode-badge").textContent = mode === "anthropic" ? "live model" : mode === "demo" ? "offline demo" : mode;
    addSuggestions(suggestions || []);
  } catch {
    $("mode-badge").textContent = "offline";
  }
}

function init() {
  const input = $("question");
  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitQuestion(input.value);
    }
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    submitQuestion(input.value);
  });

  loadHealth();
  loadAutopilot();
  loadBrief();
  loadPendingProposals();
  initReviews();
  // An approved price moves the note's figures and its suggestion on.
  document.addEventListener("proposal-decided", () => {
    loadAutopilot();
    loadBrief();
  });
}

init();
