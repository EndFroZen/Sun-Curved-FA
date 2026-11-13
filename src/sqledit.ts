// BaseCurves SQL editor: CodeMirror + dialect highlighting, schema-aware completion, query tabs kept in localStorage.
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { mySQL, pgSQL, sqlite } from "@codemirror/legacy-modes/mode/sql";
import { snippetCompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { contextAt, FUNCS, joinConds, NEXT_KW, refsIn, type Ref } from "./sqlcomplete";
import { highlight, theme } from "./editor";
import { statementAt, statements, type Dialect } from "./basecurves";

const LANGS = { sqlite: StreamLanguage.define(sqlite), postgres: StreamLanguage.define(pgSQL), mysql: StreamLanguage.define(mySQL) };

const unq = (s: string) => s.replace(/["`]/g, "");

export type SqlEditor = { setDialect(d: Dialect): void; setSchema(cols: { t: string; c: string; ty?: string }[]): void; focus(): void; runCurrent(): void; runAll(): void; newTab(text: string): void };

/** `run(sql)` gets the selection, else the statement at the cursor (Ctrl+Enter), or the whole tab (Ctrl+Shift+Enter). */
export function createSqlEditor(parent: HTMLElement, tabsBar: HTMLElement, run: (sql: string) => void): SqlEditor {
  let dialect: Dialect = "sqlite";
  type ColInfo = { c: string; ty: string };
  let schema = new Map<string, ColInfo[]>();
  const colsOf = (t: string) => schema.get(t) ?? schema.get(t.toLowerCase()) ?? [];

  function complete(ctx: CompletionContext) {
    const doc = ctx.state.doc.toString();
    // The statement around the cursor (text after the cursor counts too: SELECT | FROM t knows t).
    const sp = statements(doc).find((s) => ctx.pos >= s.from && ctx.pos <= s.to + 1);
    const base = sp && ctx.pos >= sp.from ? sp.from : ctx.pos;
    const stmt = sp ? doc.slice(sp.from, Math.max(sp.to, ctx.pos)) : "";
    const refs = refsIn(stmt);
    const lowerCase = (w: string) => /^[a-z]/.test(w); // match the user's keyword casing
    const kw = (k: string, w: string) => (lowerCase(w) ? k.toLowerCase() : k);
    // mode: plain = c; prefix = shows c, inserts alias.c (several tables in play); full = shows and inserts alias.c
    const colOpts = (r: Ref, mode: "plain" | "prefix" | "full"): Completion[] =>
      colsOf(r.table).map(({ c, ty }) => {
        const q = `${r.alias || r.table}.${c}`;
        return { label: mode === "full" ? q : c, apply: mode === "plain" ? c : q, type: "property", detail: `${r.table}${ty ? ` · ${ty}` : ""}`, boost: 3 };
      });

    // alias.col / table.col
    const dot = ctx.matchBefore(/[\w$"`]+\.[\w$]*$/);
    if (dot) {
      const i = dot.text.lastIndexOf("."), owner = unq(dot.text.slice(0, i)), part = dot.text.slice(i + 1);
      const r = refs.find((x) => x.alias === owner) ?? refs.find((x) => x.table === owner) ?? (schema.has(owner) ? { table: owner, alias: "" } : null);
      return r ? { from: dot.to - part.length, options: colOpts(r, "plain"), validFor: /^[\w$]*$/ } : null;
    }

    const w = ctx.matchBefore(/[\w$]*$/)!;
    const where = contextAt(doc.slice(base, w.from));
    if (where === "none") return null;
    // Pops up by itself while typing a word, or right after FROM/JOIN/ON; Ctrl+Space anywhere.
    if (!ctx.explicit && !w.text && where !== "table" && where !== "on") return null;

    const tables = (): Completion[] => [...schema.keys()].map((t) => ({ label: t, type: "class", detail: `${schema.get(t)!.length} cols`, boost: 2 }));
    const funcs = (): Completion[] => [...FUNCS.all, ...(FUNCS[dialect] ?? [])].map((f) => ({
      label: kw(f, w.text), type: "function", apply: kw(f, w.text) + "()", detail: "fn", boost: -1,
    }));
    const keywords = (ks: string[], boost = 0): Completion[] => ks.map((k) => ({ label: kw(k, w.text), type: "keyword", apply: kw(k, w.text) + " ", boost }));
    let options: Completion[] = [];
    if (where === "table") options = tables();
    else if (where === "on") options = [
      ...joinConds(refs, (t) => colsOf(t).map((x) => x.c)).map((j) => ({ label: j, type: "text", detail: "join", boost: 5 })),
      ...refs.flatMap((r) => colOpts(r, "full")),
    ];
    else if (where === "column") {
      const refCols = refs.flatMap((r) => colOpts(r, refs.length > 1 ? "prefix" : "plain"));
      // No FROM yet: every distinct column name in the database.
      const all = refs.length ? [] : [...new Map([...schema].flatMap(([t, cs]) => cs.map((x) => [x.c, t] as const))).entries()]
        .map(([c, t]) => ({ label: c, type: "property", detail: t }));
      const names = refs.map((r) => ({ label: r.alias || r.table, type: "variable", detail: r.alias ? r.table : "table", boost: 1 }));
      options = [...refCols, ...all, ...names, ...funcs(), ...keywords(NEXT_KW.column, -2)];
    } else if (where === "after") options = [...keywords(NEXT_KW.after, 1), ...funcs()];
    else options = [
      snippetCompletion("SELECT * FROM ${table} WHERE ${condition};", { label: kw("SELECT", w.text) + " * FROM …", type: "keyword", detail: "snippet", boost: 3 }),
      snippetCompletion("SELECT COUNT(*) FROM ${table};", { label: kw("SELECT COUNT(*)", w.text) + " …", type: "keyword", detail: "snippet" }),
      snippetCompletion("INSERT INTO ${table} (${columns}) VALUES (${values});", { label: kw("INSERT INTO", w.text) + " …", type: "keyword", detail: "snippet" }),
      snippetCompletion("UPDATE ${table} SET ${column} = ${value} WHERE ${condition};", { label: kw("UPDATE", w.text) + " … SET … WHERE", type: "keyword", detail: "snippet" }),
      snippetCompletion("DELETE FROM ${table} WHERE ${condition};", { label: kw("DELETE FROM", w.text) + " … WHERE", type: "keyword", detail: "snippet" }),
      ...keywords(NEXT_KW.start),
    ];
    return { from: w.from, options, validFor: /^[\w$]*$/ }; // no ".": typing alias. asks again for its columns
  }

  const lang = new Compartment();
  const runKeys = (all: boolean) => (v: EditorView) => {
    const sel = v.state.selection.main, doc = v.state.doc.toString();
    const s = all ? null : sel.empty ? statementAt(doc, sel.head) : sel;
    const sql = all ? doc : s ? doc.slice(s.from, s.to) : "";
    if (!all && s && sel.empty) v.dispatch({ selection: { anchor: s.from, head: s.to } }); // show what ran
    if (sql.trim()) run(sql);
    return true;
  };
  const extensions = () => [
    basicSetup,
    Prec.highest(keymap.of([{ key: "Mod-Enter", run: runKeys(false) }, { key: "Shift-Mod-Enter", run: runKeys(true) }])),
    keymap.of([indentWithTab]),
    lang.of(LANGS[dialect]),
    LANGS.sqlite.data.of({ autocomplete: complete }),
    LANGS.postgres.data.of({ autocomplete: complete }),
    LANGS.mysql.data.of({ autocomplete: complete }),
    syntaxHighlighting(highlight),
    theme,
    EditorView.updateListener.of((u) => u.docChanged && save()),
  ];

  // Tabs: one EditorState each (keeps undo history per tab); text survives restarts via localStorage.
  type Tab = { name: string; state: EditorState };
  let saved: { name: string; text: string }[] = [];
  try { saved = JSON.parse(localStorage.bcTabs ?? "[]"); } catch {} // corrupt → start fresh
  if (!saved.length) saved = [{ name: "Query 1", text: "" }];
  const tabs: Tab[] = saved.map((t) => ({ name: t.name, state: EditorState.create({ doc: t.text, extensions: extensions() }) }));
  let cur = 0;
  const view = new EditorView({ parent, state: tabs[0].state });
  function save() {
    tabs[cur].state = view.state;
    try { localStorage.bcTabs = JSON.stringify(tabs.map((t) => ({ name: t.name, text: t.state.doc.toString() }))); } catch {}
  }
  const show = (i: number) => {
    tabs[cur].state = view.state;
    cur = i;
    view.setState(tabs[i].state);
    view.dispatch({ effects: lang.reconfigure(LANGS[dialect]) });
    draw();
    view.focus();
  };
  const draw = () => {
    tabsBar.innerHTML = tabs.map((t, i) => `<span data-i="${i}" class="group flex cursor-pointer items-center gap-1 rounded-t-lg border border-b-0 px-3 py-1 text-xs ${i === cur ? "border-zinc-700 bg-zinc-900 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-200"}">
        ${t.name.replace(/[&<>"]/g, "")}${tabs.length > 1 ? `<button data-x title="Close tab" class="ml-1 rounded px-1 text-zinc-500 opacity-0 hover:text-red-400 group-hover:opacity-100">×</button>` : ""}</span>`).join("") +
      `<button data-new title="New query tab" class="px-2 text-sm text-zinc-500 hover:text-amber-400">+</button>`;
  };
  function newTab(text: string) {
    const n = Math.max(0, ...tabs.map((x) => +(/^Query (\d+)$/.exec(x.name)?.[1] ?? 0))) + 1;
    tabs.push({ name: `Query ${n}`, state: EditorState.create({ doc: text, extensions: extensions() }) });
    show(tabs.length - 1);
    save();
  }
  tabsBar.onclick = (e) => {
    const t = e.target as HTMLElement, i = +(t.closest<HTMLElement>("[data-i]")?.dataset.i ?? -1);
    if (t.closest("[data-new]")) newTab("");
    else if (t.closest("[data-x]")) {
      tabs[cur].state = view.state;
      tabs.splice(i, 1);
      cur = Math.min(cur > i ? cur - 1 : cur, tabs.length - 1);
      view.setState(tabs[cur].state);
      view.dispatch({ effects: lang.reconfigure(LANGS[dialect]) });
      draw();
      save();
    } else if (i >= 0 && i !== cur) show(i);
  };
  draw();

  return {
    setDialect(d) {
      dialect = d;
      view.dispatch({ effects: lang.reconfigure(LANGS[d]) });
    },
    setSchema(cols) {
      schema = new Map();
      for (const { t, c, ty } of cols) {
        if (!schema.has(t)) schema.set(t, []);
        schema.get(t)!.push({ c, ty: ty ?? "" });
      }
    },
    focus: () => view.focus(),
    runCurrent: () => void runKeys(false)(view),
    runAll: () => void runKeys(true)(view),
    newTab,
  };
}
