// Format a code block's text by its language. Prettier (web languages) and sql-formatter load on first use.
// ponytail: no formatter for python/rust/go/bash etc. in the browser; those can be labelled but not formatted
type Fmt = (code: string) => Promise<string>;
const pretty = (parser: string, plugins: () => Promise<unknown>[]): Fmt => async (code) => {
  const [p, ...pl] = await Promise.all([import("prettier/standalone"), ...plugins()]);
  return p.format(code, { parser, plugins: pl as never[] });
};
const babel = () => [import("prettier/plugins/babel"), import("prettier/plugins/estree")];
const sql = (language: "sql" | "postgresql" | "mysql" | "sqlite"): Fmt => async (code) =>
  (await import("sql-formatter")).format(code, { language, keywordCase: "upper" });

/** [fence tag, label, formatter] — the tag goes after ``` */
export const CODE_LANGS: [string, string, Fmt | null][] = [
  ["", "Plain text", null],
  ["js", "JavaScript", pretty("babel", babel)],
  ["ts", "TypeScript", pretty("typescript", () => [import("prettier/plugins/typescript"), import("prettier/plugins/estree")])],
  ["json", "JSON", pretty("json", babel)],
  ["html", "HTML", pretty("html", () => [import("prettier/plugins/html"), import("prettier/plugins/postcss"), ...babel()])],
  ["css", "CSS", pretty("css", () => [import("prettier/plugins/postcss")])],
  ["scss", "SCSS", pretty("scss", () => [import("prettier/plugins/postcss")])],
  ["md", "Markdown", pretty("markdown", () => [import("prettier/plugins/markdown")])],
  ["yaml", "YAML", pretty("yaml", () => [import("prettier/plugins/yaml")])],
  ["graphql", "GraphQL", pretty("graphql", () => [import("prettier/plugins/graphql")])],
  ["sql", "SQL", sql("sql")],
  ["postgresql", "PostgreSQL", sql("postgresql")],
  ["mysql", "MySQL", sql("mysql")],
  ["sqlite", "SQLite", sql("sqlite")],
  ["python", "Python", null],
  ["rust", "Rust", null],
  ["go", "Go", null],
  ["bash", "Bash", null],
  ["powershell", "PowerShell", null],
];
const ALIAS: Record<string, string> = { javascript: "js", jsx: "js", typescript: "ts", tsx: "ts", markdown: "md", yml: "yaml", py: "python", rs: "rust", sh: "bash", shell: "bash", ps1: "powershell", postgres: "postgresql", text: "", txt: "" };
export const langOf = (tag: string) => CODE_LANGS.find((l) => l[0] === (ALIAS[tag.toLowerCase()] ?? tag.toLowerCase()));
