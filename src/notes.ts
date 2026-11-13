// Calendar note helpers.
import { Marked } from "marked";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Notes are typed by the user: no raw HTML, and only http(s)/mailto links (the webview can reach invoke()).
const md = new Marked({ gfm: true, breaks: true, renderer: {
  html: ({ text }) => esc(text),
  link: ({ href, text }) => (/^(https?:|mailto:)/i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text)),
} });
export const safeMd = (s: string) => md.parse(s, { async: false });

/** Flip the n-th Markdown task box (`- [ ]` / `- [x]`), counted in source order like the rendered checkboxes.
 * ponytail: a task-looking line inside a fenced code block is counted too; marked doesn't render it, so later boxes shift by one. */
export const toggleTask = (src: string, n: number) => {
  let k = -1;
  return src.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/gm, (m, head, mark) => (++k === n ? `${head}${mark === " " ? "x" : " "}]` : m));
};
