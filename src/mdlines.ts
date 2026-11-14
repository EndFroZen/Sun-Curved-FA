// A note drawn the way the Notepad editor shows it, for Export PDF and the hover preview:
// one 24px row per source line (blank lines kept), headings / tasks / bullets / quotes / dividers styled like the
// editor, pictures with their |width|align and their height rounded up to whole rows, code blocks and tables
// rendered whole. Pages are then filled row by row, so a printed page matches the screen.
import { safeInline, safeMd } from "./notes";

export const ROW = 24; // px, the paper's line grid

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const el = (cls: string, html = "") => Object.assign(document.createElement("div"), { className: cls, innerHTML: html });

/** ![alt|300|left](url) options, same rules as the editor */
function imgOpts(alt: string) {
  const [, ...opts] = alt.split("|").map((o) => o.trim());
  const width = opts.find((o) => /^\d+$/.test(o));
  const align = opts.find((o) => o === "left" || o === "right" || o === "center");
  return { width: width ? +width : 0, align };
}

/** a picture on its own row(s): sized like the editor, height snapped to the line grid; null if it can't load */
async function picture(url: string, alt: string, resolve: (u: string) => string | Promise<string>, maxW: number) {
  const src = await resolve(url);
  if (!src) return null;
  const img = new Image();
  img.src = src;
  try { await img.decode(); } catch { return null; }
  const o = imgOpts(alt);
  const w = Math.min(o.width || img.naturalWidth, maxW), h = (img.naturalHeight * w) / img.naturalWidth;
  Object.assign(img.style, { width: `${w}px`, height: `${h}px`, borderRadius: "6px", display: "block" });
  const box = el(`mdl-img${o.align ? ` mdl-img-${o.align}` : ""}`);
  box.style.height = `${Math.ceil((h + 8) / ROW) * ROW}px`;
  box.append(img);
  return box;
}

/** the note as a list of row / block elements, top to bottom; maxW = text width of the page in px */
export async function renderLines(src: string, resolve: (u: string) => string | Promise<string>, maxW: number) {
  const lines = src.split("\n"), out: HTMLElement[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // fenced code block / table: one rendered block, like the editor's widget
    if (/^\s*(```|~~~)/.test(line)) {
      const fence = line.trim().slice(0, 3);
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence)) j++;
      out.push(el("mdl-block manual cal-md", safeMd(lines.slice(i, j + 1).join("\n"))));
      i = j;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "")) {
      let j = i;
      while (j + 1 < lines.length && /^\s*\|/.test(lines[j + 1])) j++;
      out.push(el("mdl-block manual cal-md", safeMd(lines.slice(i, j + 1).join("\n"))));
      i = j;
      continue;
    }
    const pic = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (pic) {
      const box = await picture(pic[2], pic[1], resolve, maxW);
      if (box) out.push(box);
      continue;
    }
    let m: RegExpExecArray | null;
    const ind = (s: string) => `style="padding-left:${s.replace(/\t/g, "    ").length * 0.5}em"`;
    if (!line.trim()) out.push(el("mdl-row"));
    else if ((m = /^\s*(#{1,6})\s+(.*)$/.exec(line))) out.push(el(`mdl-row mdl-h${Math.min(m[1].length, 3)}`, safeInline(m[2])));
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push(el("mdl-row", `<span class="mdl-hr"></span>`));
    else if ((m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)))
      out.push(el("mdl-row", `<span ${ind(m[1])}><input type="checkbox" class="mdl-box" disabled ${m[2] === " " ? "" : "checked"} />${safeInline(m[3])}</span>`));
    else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) out.push(el("mdl-row", `<span ${ind(m[1])}><span class="mdl-bullet">•</span>${safeInline(m[2])}</span>`));
    else if ((m = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line))) out.push(el("mdl-row", `<span ${ind(m[1])}>${esc(m[2])} ${safeInline(m[3])}</span>`));
    else if ((m = /^\s*>\s?(.*)$/.exec(line))) out.push(el("mdl-row mdl-quote", safeInline(m[1])));
    else out.push(el("mdl-row", safeInline(line)));
  }
  // inline pictures inside a text row: load them like the editor (or drop them)
  await Promise.all(out.flatMap((r) => [...r.querySelectorAll<HTMLImageElement>(".mdl-row img")]).map(async (img) => {
    const s = await resolve(img.getAttribute("src") ?? "");
    if (!s) return img.remove();
    img.src = s;
    img.style.maxWidth = "100%";
    await img.decode().catch(() => img.remove());
  }));
  return out;
}

/** pour rows into fixed-height sheets made by `sheet()`; a row that doesn't fit starts the next sheet */
export function paginate(rows: HTMLElement[], sheet: () => HTMLElement) {
  let cur = sheet();
  for (const r of rows) {
    cur.append(r);
    if (cur.scrollHeight > cur.clientHeight && cur.childElementCount > 1) (cur = sheet()).append(r);
  }
}
