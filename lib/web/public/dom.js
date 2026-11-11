// Small DOM and fetch helpers shared by the page's modules. Text goes in via
// textContent only, never innerHTML.

export const $ = (id) => document.getElementById(id);

// Throws with the server's message and the HTTP status, so a caller can tell a
// failed send (502) from a refusal.
export async function api(path, options) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || `request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return body;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className, text, onClick) {
  const b = el("button", className, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
