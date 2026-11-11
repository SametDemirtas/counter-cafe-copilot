// A small markdown subset for the model's answers: paragraphs, bullet and
// numbered lists, pipe tables and **bold**. It only parses to plain data; the
// page builds DOM nodes from it with textContent, so no markup in an answer
// can ever become HTML.

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function parseInline(text) {
  const parts = String(text).split(/\*\*([^*]+)\*\*/g);
  const out = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) out.push({ type: "strong", text: part });
    else if (part) out.push({ type: "text", text: part });
  });
  return out;
}

function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => parseInline(c.trim()));
}

export function parseMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush();
      const header = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      i -= 1;
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? "bullets" : "numbered";
      const pattern = bullet ? BULLET : NUMBERED;
      const last = blocks[blocks.length - 1];
      const list = last && last.type === kind ? last : { type: kind, items: [] };
      if (list !== last) blocks.push(list);
      list.items.push(parseInline(pattern.exec(line)[1]));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "paragraph", inlines: [{ type: "strong", text: heading[1] }] });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
