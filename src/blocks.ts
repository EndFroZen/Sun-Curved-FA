// Notion-style blocks on top of the Markdown editor (Notepad only). A block is one line, or a whole
// fenced code block / table. The file stays plain Markdown: every action below is just a text edit.
//  - type "/" at the start of a line → menu of block types (filter by typing, Enter picks)
//  - hover a block → "+" (new block below, opens the menu) and "⋮⋮" (drag to move, click for the block menu)
import { EditorView, ViewPlugin, tooltips } from "@codemirror/view";
import { autocompletion, startCompletion, type CompletionContext } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { lucide } from "./iconpick";

type Kind = { id: string; label: string; hint: string; desc: string; ic: string; prefix?: string };
export const KINDS: Kind[] = [
  { id: "text", label: "Text", hint: "", desc: "Just start writing with plain text", ic: "type", prefix: "" },
  { id: "h1", label: "Heading 1", hint: "#", desc: "Big section heading", ic: "heading1", prefix: "# " },
  { id: "h2", label: "Heading 2", hint: "##", desc: "Medium section heading", ic: "heading2", prefix: "## " },
  { id: "h3", label: "Heading 3", hint: "###", desc: "Small section heading", ic: "heading3", prefix: "### " },
  { id: "todo", label: "To-do list", hint: "[]", desc: "Track tasks with a checkbox", ic: "list-todo", prefix: "- [ ] " },
  { id: "bullet", label: "Bulleted list", hint: "-", desc: "A simple bulleted list", ic: "list", prefix: "- " },
  { id: "number", label: "Numbered list", hint: "1.", desc: "A list with numbering", ic: "list-ordered", prefix: "1. " },
  { id: "quote", label: "Quote", hint: ">", desc: "Capture a quote", ic: "text-quote", prefix: "> " },
  { id: "code", label: "Code", hint: "```", desc: "Capture a code snippet", ic: "code" },
  { id: "divider", label: "Divider", hint: "---", desc: "Visually divide blocks", ic: "minus" },
  { id: "image", label: "Image", hint: "Ctrl+V", desc: "Upload a picture, or paste one anywhere", ic: "image" },
];
// the Markdown that makes a line a heading / task / list item / quote
const PREFIX = /^(\s*)(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/;

type Range = { from: number; to: number };
export type BlockMenu = (e: MouseEvent, items: [label: string, run: () => void][]) => void;
/** stores an image file and returns the URL to write in ![](...) */
export type SaveImage = (f: File) => Promise<string>;

/** put ![](url) for the image on its own line at the cursor */
async function insertImage(view: EditorView, f: File, save: SaveImage) {
  const md = `![](${await save(f)})`, line = view.state.doc.lineAt(view.state.selection.main.head);
  const blank = !line.text.trim(), at = blank ? line.from : line.to;
  const insert = blank ? `${md}\n` : `\n${md}\n`;
  view.dispatch({ changes: { from: at, to: blank ? line.to : at, insert }, selection: { anchor: at + insert.length } });
  view.focus();
}
const pickImage = () => new Promise<File | null>((res) => {
  const i = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
  i.onchange = () => res(i.files?.[0] ?? null);
  i.oncancel = () => res(null);
  i.click();
});

/** the block that holds pos: its line, or the whole top-level code block / table around it */
export function blockAt(state: EditorState, pos: number): Range {
  const line = state.doc.lineAt(pos);
  for (let c = syntaxTree(state).topNode.firstChild; c; c = c.nextSibling)
    if ((c.name === "FencedCode" || c.name === "Table") && c.from <= line.to && c.to >= line.from)
      return { from: state.doc.lineAt(c.from).from, to: state.doc.lineAt(c.to).to };
  return { from: line.from, to: line.to };
}

/** rewrite block b as kind k (keeps the text, swaps the Markdown prefix); `text` overrides the line's text */
function turnInto(view: EditorView, b: Range, k: Kind, text?: string) {
  const doc = view.state.doc, src = text ?? doc.sliceString(b.from, b.to);
  const body = src.replace(PREFIX, "");
  let insert: string, cursor: number;
  if (k.id === "code") (insert = "```\n" + body + "\n```"), (cursor = 4 + body.length);
  else if (k.id === "divider") {
    const prev = b.from > 0 ? doc.lineAt(b.from - 1).text.trim() : "";
    insert = (prev ? "\n" : "") + "---\n" + body; // a blank line first, or "text\n---" turns the text into a heading
    cursor = insert.length;
  } else (insert = (PREFIX.exec(src)?.[1] ?? "") + k.prefix + body), (cursor = insert.length);
  view.dispatch({ changes: { ...b, insert }, selection: { anchor: b.from + cursor } });
  view.focus();
}

// "/" menu, through the autocomplete popup (keyboard, filtering and positioning come with it)
const slash = (save: SaveImage) => (ctx: CompletionContext) => {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const m = /^(\s*)\/(\w*)$/.exec(ctx.state.sliceDoc(line.from, ctx.pos));
  if (!m) return null;
  const at = line.from + m[1].length; // the "/"
  return {
    from: at + 1,
    validFor: /^\w*$/,
    options: KINDS.map((k, i) => ({
      label: k.label,
      kind: k, // read by the row renderer below
      section: "Basic blocks",
      boost: 99 - i, // keep this order instead of alphabetical
      apply: (view: EditorView) => {
        const before = line.text.slice(0, at - line.from);
        if (k.id !== "image") return turnInto(view, { from: line.from, to: line.to }, k, before);
        turnInto(view, { from: line.from, to: line.to }, KINDS[0], before); // drop the "/image" text, then pick a file
        pickImage().then((f) => f && insertImage(view, f, save)).catch(console.error);
      },
    })),
  };
};

const handles = (menu: BlockMenu) => ViewPlugin.fromClass(class {
  dom = Object.assign(document.createElement("div"), {
    className: "cm-bhandle",
    innerHTML: `<button data-add title="Add a block below">${lucide("plus", "h-4 w-4")}</button><button data-grip title="Drag to move · click for options">${lucide("grip-vertical", "h-4 w-4")}</button>`,
  });
  drop = Object.assign(document.createElement("div"), { className: "cm-bdrop" });
  area: HTMLElement;
  block: Range | null = null;

  constructor(readonly view: EditorView) {
    view.dom.append(this.dom, this.drop);
    this.area = view.dom.parentElement ?? view.dom; // the whole page, margins included
    this.area.addEventListener("mousemove", this.hover);
    this.dom.querySelector<HTMLElement>("[data-add]")!.onmousedown = (e) => (e.preventDefault(), this.add());
    this.dom.querySelector<HTMLElement>("[data-grip]")!.onmousedown = this.grab;
  }
  destroy() {
    this.area.removeEventListener("mousemove", this.hover);
    this.dom.remove();
    this.drop.remove();
  }
  // y (client px) → the line block under it, in editor units (handles CSS zoom on the page)
  lineAt(y: number) {
    return this.view.lineBlockAtHeight((y - this.view.documentTop) / this.view.scaleY);
  }
  top(h: number) { // editor-unit height → px offset inside view.dom
    return h + (this.view.documentTop - this.view.dom.getBoundingClientRect().top) / this.view.scaleY;
  }
  hover = (e: MouseEvent) => {
    if (this.drop.style.display === "block") return; // dragging
    const b = blockAt(this.view.state, this.lineAt(e.clientY).from);
    this.block = b;
    this.dom.style.display = "flex";
    this.dom.style.top = `${this.top(this.view.lineBlockAt(b.from).top)}px`;
  };
  add() {
    const b = this.block;
    if (!b) return;
    const empty = !this.view.state.sliceDoc(b.from, b.to).trim();
    const at = empty ? b.from : b.to, insert = empty ? "/" : "\n/";
    this.view.dispatch({ changes: { from: at, to: empty ? b.to : at, insert }, selection: { anchor: at + insert.length } });
    this.view.focus();
    startCompletion(this.view);
  }
  grab = (e: MouseEvent) => {
    e.preventDefault();
    const b = this.block;
    if (!b) return;
    const y0 = e.clientY;
    let target: { pos: number; before: boolean } | null = null, moved = false;
    const move = (m: MouseEvent) => {
      if (!moved && Math.abs(m.clientY - y0) < 4) return;
      moved = true;
      const t = blockAt(this.view.state, this.lineAt(m.clientY).from);
      const top = this.view.lineBlockAt(t.from).top, bottom = this.view.lineBlockAt(t.to).bottom;
      const before = (m.clientY - this.view.documentTop) / this.view.scaleY < (top + bottom) / 2;
      target = t.from >= b.from && t.to <= b.to ? null : { pos: before ? t.from : t.to, before };
      this.drop.style.display = target ? "block" : "none";
      this.drop.style.top = `${this.top(before ? top : bottom)}px`;
    };
    const up = (u: MouseEvent) => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      this.drop.style.display = "none";
      if (!moved) return this.menu(u, b);
      if (target) this.moveBlock(b, target);
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  };
  moveBlock(b: Range, t: { pos: number; before: boolean }) {
    const doc = this.view.state.doc, text = doc.sliceString(b.from, b.to);
    const cut = b.to < doc.length ? { from: b.from, to: b.to + 1 } : { from: Math.max(0, b.from - 1), to: b.to }; // take its line break along
    const put = t.before ? { from: t.pos, insert: text + "\n" } : { from: t.pos, insert: "\n" + text };
    this.view.dispatch({ changes: [cut, put] });
  }
  menu(e: MouseEvent, b: Range) {
    const v = this.view, text = v.state.sliceDoc(b.from, b.to), oneLine = !text.includes("\n");
    menu(e, [
      ...(oneLine ? KINDS.filter((k) => k.id !== "image").map((k): [string, () => void] => [`Turn into ${k.label}`, () => turnInto(v, b, k)]) : []),
      ["Duplicate", () => v.dispatch({ changes: { from: b.to, insert: "\n" + text } })],
      ["Delete", () => {
        const doc = v.state.doc;
        v.dispatch({ changes: b.to < doc.length ? { from: b.from, to: b.to + 1 } : { from: Math.max(0, b.from - 1), to: b.to } });
      }],
    ]);
  }
});

export const blocks = ({ menu, saveImage }: { menu: BlockMenu; saveImage: SaveImage }) => [
  tooltips({ parent: document.body }), // outside the zoomed page, so the "/" menu stays the same size at any zoom
  autocompletion({
    override: [slash(saveImage)],
    icons: false,
    tooltipClass: () => "np-slash",
    // Notion-like row: icon tile, name + one-line description, Markdown shortcut on the right
    addToOptions: [{
      position: 20,
      render: (c) => {
        const k = (c as unknown as { kind: Kind }).kind, row = document.createElement("span");
        row.className = "np-row";
        row.innerHTML = `<span class="np-ic">${lucide(k.ic, "h-[18px] w-[18px]")}</span>
          <span class="np-tx"><span class="np-t">${k.label}</span><span class="np-d">${k.desc}</span></span>
          ${k.hint ? `<kbd class="np-k">${k.hint.replace(/</g, "&lt;")}</kbd>` : ""}`;
        return row;
      },
    }],
  }),
  handles(menu),
  EditorView.domEventHandlers({
    paste(e, view) { // Ctrl+V of a picture (screenshot, copied image) → saved and linked
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (!f) return false;
      e.preventDefault();
      insertImage(view, f, saveImage).catch(console.error);
      return true;
    },
  }),
  EditorView.theme({ "&": { position: "relative" } }),
];
