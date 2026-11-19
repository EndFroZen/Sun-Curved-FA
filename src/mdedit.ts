// One-pane Markdown editor with live preview (Obsidian-style): markup is hidden on every line except
// the one(s) being edited, headings/bold/code are styled in place, task boxes are clickable.
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { Compartment, EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { safeMd } from "./notes";
import { lucide } from "./iconpick";
import { blocks } from "./blocks";
import { CODE_LANGS, langOf } from "./codefmt";

const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontSize: "1.1em", fontWeight: "600", color: "var(--color-amber-400)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "'Cascadia Mono', Consolas, monospace", fontSize: ".9em", color: "var(--code-str)" },
  { tag: [t.link, t.url], color: "var(--color-amber-400)", textDecoration: "underline" },
  { tag: t.quote, color: "var(--color-zinc-400)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta], color: "var(--color-zinc-500)" }, // visible markup on the active line
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "15px", color: "var(--color-zinc-100)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.7" },
  ".cm-content": { padding: "12px 4px", caretColor: "var(--color-amber-400)" },
  ".cm-cursor": { borderLeftColor: "var(--color-amber-400)", borderLeftWidth: "2px" },
  ".cm-placeholder": { color: "var(--color-zinc-600)" },
  ".md-box": { accentColor: "var(--color-amber-500)", cursor: "pointer", margin: "0 .4em 0 0", verticalAlign: "-2px" },
  ".md-block": { display: "flex", flexDirection: "column", justifyContent: "center", cursor: "text" },
  ".md-bullet": { color: "var(--color-amber-400)", padding: "0 .35em 0 .1em" },
  ".md-hr": { display: "inline-block", width: "100%", verticalAlign: "middle", borderTop: "1px solid var(--color-zinc-700)" },
  ".md-imgbox": { position: "relative", display: "flex", alignItems: "center", width: "fit-content", maxWidth: "100%" },
  ".md-img": { display: "block", maxWidth: "100%", borderRadius: "6px", cursor: "pointer" },
  ".md-imgsize": { position: "absolute", right: "-5px", bottom: "-5px", width: "12px", height: "12px", borderRadius: "3px", border: "2px solid var(--color-amber-400)", background: "#fff", cursor: "nwse-resize", opacity: "0", transition: "opacity .15s" },
  ".md-imgbox:hover .md-imgsize": { opacity: "1" },
  ".md-img-center": { margin: "0 auto" },
  ".md-img-left": { float: "left", marginRight: "16px" },
  ".md-img-right": { float: "right", marginLeft: "16px" },
  ".md-img-right .md-imgsize": { right: "auto", left: "-5px", cursor: "nesw-resize" },
  ".md-img-sel .md-img": { outline: "2px solid var(--color-amber-400)", outlineOffset: "2px" },
  ".md-img-missing": { width: "240px", height: "48px", border: "1px dashed var(--color-zinc-700)" },
});

class Box extends WidgetType {
  constructor(readonly on: boolean, readonly at: number) { super(); }
  eq(o: Box) { return o.on === this.on && o.at === this.at; }
  toDOM(view: EditorView) {
    const c = Object.assign(document.createElement("input"), { type: "checkbox", checked: this.on, className: "md-box" });
    c.onmousedown = (e) => e.preventDefault(); // keep the cursor where it is
    c.onclick = () => view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.on ? " " : "x" } });
    return c;
  }
  ignoreEvent() { return false; }
}
class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() { return Object.assign(document.createElement("span"), { className: "md-bullet", textContent: "•" }); }
}
class Rule extends WidgetType {
  eq() { return true; }
  toDOM() { return Object.assign(document.createElement("span"), { className: "md-hr" }); }
}
/** Make el a whole number of text lines tall (inner + a little air), so the text below it stays on the
 * paper's ruled lines. Uses the editor's own line height, so it fits the calendar too. */
function snapToLines(view: EditorView, el: HTMLElement, inner: HTMLElement) {
  const lh = parseFloat(getComputedStyle(view.contentDOM).lineHeight) || 24;
  const h = inner.getBoundingClientRect().height / view.scaleY; // page may be zoomed
  el.style.height = `${Math.max(1, Math.ceil((h + 8) / lh)) * lh}px`;
  view.requestMeasure();
}
/** where an image link points to → something an <img> can load (the Notepad maps .assets/ files to blob URLs) */
let resolveImage: (url: string) => string | Promise<string> = (url) => (/^https?:/i.test(url) ? url : "");
export const setImageResolver = (f: typeof resolveImage) => void (resolveImage = f);

/** Image options live in the alt text, Obsidian-style, after "|": ![cat|300|left](url)
 * width in px; left / right float the picture so text runs beside it; center puts it alone in the middle. */
type Align = "left" | "right" | "center";
const ALIGNS: Align[] = ["left", "right", "center"];
function parseAlt(alt: string) {
  const [name, ...opts] = alt.split("|");
  const width = opts.map((o) => o.trim()).find((o) => /^\d+$/.test(o));
  const align = opts.map((o) => o.trim()).find((o): o is Align => ALIGNS.includes(o as Align));
  return { name, width: width ? +width : null, align: align ?? null };
}
const fmtAlt = (a: ReturnType<typeof parseAlt>) =>
  [a.name, ...(a.width ? [String(a.width)] : []), ...(a.align ? [a.align] : [])].join("|");

// Right-click a picture → a small icon toolbar pops out at the mouse (one at a time, on <body> so page zoom doesn't scale it)
let imgBar: HTMLElement | null = null;
const closeImgBar = () => {
  imgBar?.remove();
  imgBar = null;
  document.querySelectorAll(".md-img-sel").forEach((x) => x.classList.remove("md-img-sel"));
};
addEventListener("mousedown", (e) => imgBar?.contains(e.target as Node) || closeImgBar(), true);
addEventListener("keydown", (e) => e.key === "Escape" && closeImgBar());
addEventListener("wheel", closeImgBar, { passive: true });
addEventListener("blur", closeImgBar);
function openImgBar(e: MouseEvent, box: HTMLElement, tools: [ic: string, title: string, on: boolean, run: () => void][]) {
  closeImgBar();
  box.classList.add("md-img-sel");
  const bar = (imgBar = Object.assign(document.createElement("div"), { className: "md-imgbar" }));
  tools.forEach(([ic, title, on, run], k) => {
    if (k === tools.length - 1) bar.append(Object.assign(document.createElement("span"), { className: "sep" }));
    const b = Object.assign(document.createElement("button"), { title, innerHTML: lucide(ic, "h-[18px] w-[18px]"), className: on ? "on" : "" });
    b.onmousedown = (ev) => ev.preventDefault(); // keep the editor focused
    b.onclick = () => (closeImgBar(), run());
    bar.append(b);
  });
  document.body.append(bar);
  // at the pointer's bottom-right, kept on screen
  const r = bar.getBoundingClientRect();
  bar.style.left = `${Math.max(8, Math.min(e.clientX + 4, innerWidth - r.width - 8))}px`;
  bar.style.top = `${Math.max(8, Math.min(e.clientY + 4, innerHeight - r.height - 8))}px`;
}
/** ![alt](url), shown as the picture; clicking it puts the cursor on its line. Drag the corner to resize
 * (double-click it for the original size); right-click it for the icon toolbar: own line / left / center / right. */
class Img extends WidgetType {
  constructor(readonly url: string, readonly alt: string) { super(); }
  eq(o: Img) { return o.url === this.url && o.alt === this.alt; } // same picture → keep the loaded <img> (no flicker while typing above it)
  toDOM(view: EditorView) {
    const opt = parseAlt(this.alt);
    const box = Object.assign(document.createElement("span"), { className: `md-imgbox${opt.align ? ` md-img-${opt.align}` : ""}` });
    const i = Object.assign(document.createElement("img"), { className: "md-img", alt: opt.name });
    const grip = Object.assign(document.createElement("span"), { className: "md-imgsize", title: "Drag to resize · double-click for original size" });
    if (opt.width) i.style.width = `${opt.width}px`;
    Promise.resolve(resolveImage(this.url)).then((s) => (s ? (i.src = s) : (i.classList.add("md-img-missing"), requestAnimationFrame(() => snapToLines(view, box, i)))));
    i.onload = () => snapToLines(view, box, i); // height is known once it loads
    i.onmousedown = (e) => e.button === 0 && (e.preventDefault(), view.focus(), view.dispatch({ selection: { anchor: view.posAtDOM(box) } }));
    // rewrite this ![...]'s alt text with changed options
    const save = (change: Partial<ReturnType<typeof parseAlt>>) => {
      const at = view.posAtDOM(box), m = /^!\[([^\]]*)\]/.exec(view.state.sliceDoc(at, at + 500));
      if (!m) return;
      view.dispatch({ changes: { from: at + 2, to: at + 2 + m[1].length, insert: fmtAlt({ ...parseAlt(m[1]), ...change }) } });
    };
    // right-click: placement + original size
    box.oncontextmenu = (e) => {
      e.preventDefault();
      openImgBar(e, box, [
        ["between-horizontal-start", "On its own line", !opt.align, () => save({ align: null })],
        ["panel-left", "Left, text beside it", opt.align === "left", () => save({ align: "left" })],
        ["align-center", "Center", opt.align === "center", () => save({ align: "center" })],
        ["panel-right", "Right, text beside it", opt.align === "right", () => save({ align: "right" })],
        ["rotate-ccw", "Original size", false, () => save({ width: null })],
      ]);
    };
    grip.ondblclick = (e) => (e.preventDefault(), save({ width: null }));
    grip.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX, w0 = i.getBoundingClientRect().width / view.scaleX; // page may be zoomed
      const dir = opt.align === "right" ? -1 : 1; // a right-aligned picture grows to the left
      const move = (m: MouseEvent) => ((i.style.width = `${Math.max(40, Math.round(w0 + dir * (m.clientX - x0) / view.scaleX))}px`), snapToLines(view, box, i));
      const up = () => {
        removeEventListener("mousemove", move);
        removeEventListener("mouseup", up);
        save({ width: Math.round(i.getBoundingClientRect().width / view.scaleX) }); // as shown (max-width may have capped it)
      };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    };
    box.append(i, grip);
    return box;
  }
  ignoreEvent() { return false; }
}
/** A fenced code block or table, rendered; clicking it puts the cursor inside to edit the source. */
class Block extends WidgetType {
  constructor(readonly src: string, readonly at: number) { super(); }
  eq(o: Block) { return o.src === this.src && o.at === this.at; }
  toDOM(view: EditorView) {
    const d = Object.assign(document.createElement("div"), { className: "manual cal-md md-block", innerHTML: `<div>${safeMd(this.src)}</div>` });
    requestAnimationFrame(() => snapToLines(view, d, d.firstElementChild as HTMLElement));
    d.onmousedown = (e) => (e.preventDefault(), view.focus(), view.dispatch({ selection: { anchor: this.at } }));
    const f = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*\n?/.exec(this.src);
    if (f) d.append(this.codeBar(view, f[1], f[2], this.src.slice(f[0].length).replace(/\n?[ \t]*(`{3,}|~{3,})[ \t]*$/, "")));
    return d;
  }
  /** top-right of a ``` block: language (rewrites the tag after ```), Format, Copy */
  codeBar(view: EditorView, fence: string, tag: string, body: string) {
    const bar = Object.assign(document.createElement("div"), { className: "md-codebar" });
    bar.onmousedown = (e) => e.stopPropagation(); // the block's own mousedown would jump into the source
    const put = (t: string, b: string) => {
      if (view.state.sliceDoc(this.at, this.at + this.src.length) !== this.src) return; // note changed meanwhile
      view.dispatch({ changes: { from: this.at, to: this.at + this.src.length, insert: `${fence}${t}\n${b.replace(/\n+$/, "")}\n${fence}` } });
    };
    const lang = langOf(tag);
    const sel = document.createElement("select");
    sel.title = "Language";
    sel.innerHTML = (lang ? "" : `<option value="${tag.replace(/"/g, "")}">${tag.replace(/</g, "&lt;")}</option>`) +
      CODE_LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    sel.value = lang ? lang[0] : tag;
    sel.onchange = () => put(sel.value, body);
    const btn = (label: string, ic: string, run: (b: HTMLButtonElement) => Promise<void>) => {
      const b = Object.assign(document.createElement("button"), { innerHTML: `${lucide(ic, "h-3.5 w-3.5")}<span>${label}</span>` });
      b.onclick = async () => {
        const s = b.querySelector("span")!;
        try { await run(b); } catch (e) { s.textContent = "Error"; b.title = String(e); setTimeout(() => ((s.textContent = label), (b.title = "")), 2500); }
      };
      return b;
    };
    const fmt = btn("Format", "wand-sparkles", async () => put(lang ? lang[0] : tag, await lang![2]!(body)));
    if (!lang?.[2]) Object.assign(fmt, { disabled: true, title: "No formatter for this language" });
    const copy = btn("Copy", "copy", async (b) => {
      await navigator.clipboard.writeText(body);
      b.querySelector("span")!.textContent = "Copied";
      setTimeout(() => (b.querySelector("span")!.textContent = "Copy"), 1200);
    });
    bar.append(sel, fmt, copy);
    return bar;
  }
  ignoreEvent(e: Event) { return !!(e.target as Element).closest?.(".md-codebar"); } // its own clicks, not "edit the source"
}
const hide = Decoration.replace({});
const HIDDEN = new Set(["HeaderMark", "EmphasisMark", "StrikethroughMark", "LinkMark", "URL", "QuoteMark"]);
const setFocus = StateEffect.define<boolean>();
const setImgSource = StateEffect.define<boolean>(); // true: show ![](...) as text instead of the picture

// Multi-line (block) replacements must come from a state field, not a view plugin, so everything lives here.
// ponytail: re-decorates the whole doc on every change; fine for notes, viewport-limit it for big files.
function decorate(state: EditorState, focus: boolean, imgSource = false): DecorationSet {
  const out: Range<Decoration>[] = [], doc = state.doc;
  const active = new Set(!focus ? [] : state.selection.ranges.flatMap((r) => {
    const a = doc.lineAt(r.from).number, z = doc.lineAt(r.to).number;
    return Array.from({ length: z - a + 1 }, (_, i) => a + i);
  }));
  const touched = (from: number, to: number) => {
    for (let l = doc.lineAt(from).number, z = doc.lineAt(to).number; l <= z; l++) if (active.has(l)) return true;
    return false;
  };
  syntaxTree(state).iterate({ enter: (n) => {
    const name = n.name;
    if (name === "FencedCode" || name === "Table") {
      if (touched(n.from, n.to)) return; // editing it: show the source
      const from = doc.lineAt(n.from).from, to = doc.lineAt(n.to).to;
      out.push(Decoration.replace({ widget: new Block(doc.sliceString(n.from, n.to), n.from), block: true }).range(from, to));
      return false;
    }
    if (name === "Image") { // always the picture, even on the line being edited; imgSource shows the Markdown instead
      if (imgSource) return false;
      const url = n.node.getChild("URL");
      const alt = /^!\[([^\]]*)\]/.exec(doc.sliceString(n.from, n.to))?.[1] ?? "";
      if (url) out.push(Decoration.replace({ widget: new Img(doc.sliceString(url.from, url.to), alt) }).range(n.from, n.to));
      return false;
    }
    if (active.has(doc.lineAt(n.from).number)) return;
    const next = doc.sliceString(n.to, n.to + 1);
    if (name === "Task") {
      const mark = n.node.getChild("TaskMarker");
      if (mark) out.push(Decoration.replace({ widget: new Box(doc.sliceString(mark.from + 1, mark.from + 2) !== " ", mark.from) })
        .range(mark.from, mark.to + (doc.sliceString(mark.to, mark.to + 1) === " " ? 1 : 0)));
      return false;
    }
    if (name === "ListMark") {
      if (n.node.parent?.getChild("Task")) out.push(hide.range(n.from, n.to + (next === " " ? 1 : 0))); // the checkbox stands in for the bullet
      else if (/[-*+]/.test(doc.sliceString(n.from, n.to))) out.push(Decoration.replace({ widget: new Bullet() }).range(n.from, n.to));
      return;
    }
    if (name === "HorizontalRule") return void out.push(Decoration.replace({ widget: new Rule() }).range(n.from, n.to));
    if (name === "CodeMark" && n.node.parent?.name === "InlineCode") return void out.push(hide.range(n.from, n.to));
    if (name === "URL" && n.node.parent?.name !== "Link") return; // bare autolinks stay visible
    if (HIDDEN.has(name)) out.push(hide.range(n.from, n.to + (name === "HeaderMark" || name === "QuoteMark" ? +(next === " ") : 0)));
  } });
  return Decoration.set(out, true);
}

const live = StateField.define<{ focus: boolean; img: boolean; deco: DecorationSet }>({
  create: (s) => ({ focus: false, img: false, deco: decorate(s, false) }),
  update(v, tr) {
    const f = tr.effects.find((e) => e.is(setFocus)), focus = f ? (f.value as boolean) : v.focus;
    const g = tr.effects.find((e) => e.is(setImgSource)), img = g ? (g.value as boolean) : v.img;
    const stale = f || g || tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState);
    return stale ? { focus, img, deco: decorate(tr.state, focus, img) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export function createMdEditor(parent: HTMLElement, opts: { placeholder?: string; onSubmit: () => void; onChange?: () => void; blocks?: Parameters<typeof blocks>[0] }) {
  const lock = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      extensions: [
        history(),
        keymap.of([{ key: "Mod-Enter", run: () => (opts.onSubmit(), true) }, ...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage }), // GFM: tasks, strikethrough, tables
        syntaxHighlighting(style),
        live,
        EditorView.focusChangeEffect.of((_, focusing) => setFocus.of(focusing)),
        theme,
        EditorView.lineWrapping,
        placeholder(opts.placeholder ?? ""),
        EditorView.updateListener.of((u) => u.docChanged && opts.onChange?.()),
        opts.blocks ? blocks(opts.blocks) : [],
        lock.of([]),
      ],
    }),
  });
  return {
    get: () => view.state.doc.toString(),
    set: (s: string) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s }, selection: { anchor: s.length } }),
    focus: () => view.focus(),
    /** true: images show as their Markdown; false: as pictures */
    imageSource: (on: boolean) => view.dispatch({ effects: setImgSource.of(on) }),
    /** false: view only (no cursor, so every line shows rendered) */
    editable: (on: boolean) => view.dispatch({ effects: lock.reconfigure(on ? [] : [EditorView.editable.of(false), EditorState.readOnly.of(true)]) }),
  };
}
