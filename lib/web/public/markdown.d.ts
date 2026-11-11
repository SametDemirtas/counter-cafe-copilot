// Types for markdown.js, which the browser loads as is, without a build step.

export type Inline = { readonly type: "text" | "strong"; readonly text: string };

export type Block =
  | { readonly type: "paragraph"; readonly inlines: readonly Inline[] }
  | { readonly type: "bullets" | "numbered"; readonly items: readonly (readonly Inline[])[] }
  | { readonly type: "table"; readonly header: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] };

export function parseInline(text: string): Inline[];
export function parseMarkdown(text: string): Block[];
