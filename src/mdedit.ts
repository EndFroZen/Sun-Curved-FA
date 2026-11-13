// One-pane Markdown editor with live preview (Obsidian-style): markup is hidden on every line except
// the one(s) being edited, headings/bold/code are styled in place, task boxes are clickable.
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { safeMd } from "./notes";

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
  ".md-block": { padding: "4px 0", cursor: "text" },
  ".md-bullet": { color: "var(--color-amber-400)", padding: "0 .35em 0 .1em" },
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
/** A fenced code block or table, rendered; clicking it puts the cursor inside to edit the source. */
class Block extends WidgetType {
  constructor(readonly src: string, readonly at: number) { super(); }
  eq(o: Block) { return o.src === this.src && o.at === this.at; }
  toDOM(view: EditorView) {
    const d = Object.assign(document.createElement("div"), { className: "manual cal-md md-block", innerHTML: safeMd(this.src) });
    d.onmousedown = (e) => (e.preventDefault(), view.focus(), view.dispatch({ selection: { anchor: this.at } }));
    return d;
  }
  ignoreEvent() { return false; }
}
const hide = Decoration.replace({});
const HIDDEN = new Set(["HeaderMark", "EmphasisMark", "StrikethroughMark", "LinkMark", "URL", "QuoteMark"]);
const setFocus = StateEffect.define<boolean>();

// Multi-line (block) replacements must come from a state field, not a view plugin, so everything lives here.
// ponytail: re-decorates the whole doc on every change; fine for notes, viewport-limit it for big files.
function decorate(state: EditorState, focus: boolean): DecorationSet {
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
    if (name === "CodeMark" && n.node.parent?.name === "InlineCode") return void out.push(hide.range(n.from, n.to));
    if (name === "URL" && n.node.parent?.name !== "Link") return; // bare autolinks stay visible
    if (HIDDEN.has(name)) out.push(hide.range(n.from, n.to + (name === "HeaderMark" || name === "QuoteMark" ? +(next === " ") : 0)));
  } });
  return Decoration.set(out, true);
}

const live = StateField.define<{ focus: boolean; deco: DecorationSet }>({
  create: (s) => ({ focus: false, deco: decorate(s, false) }),
  update(v, tr) {
    const f = tr.effects.find((e) => e.is(setFocus)), focus = f ? (f.value as boolean) : v.focus;
    const stale = f || tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState);
    return stale ? { focus, deco: decorate(tr.state, focus) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export function createMdEditor(parent: HTMLElement, opts: { placeholder?: string; onSubmit: () => void }) {
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
      ],
    }),
  });
  return {
    get: () => view.state.doc.toString(),
    set: (s: string) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s }, selection: { anchor: s.length } }),
    focus: () => view.focus(),
  };
}
