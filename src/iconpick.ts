// Every Lucide icon by kebab-case name + a centered search popup to pick one. Reusable anywhere.
import { icons, type IconNode } from "lucide";

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();

/** name -> nodes; aliases share one node object, so only the first name of each is listed. */
const ALL = new Map<string, IconNode>();
const seen = new Set<IconNode>();
for (const [k, v] of Object.entries(icons)) if (!seen.has(v)) (seen.add(v), ALL.set(kebab(k), v));
export const iconNames = [...ALL.keys()];

const attrs = (a: Record<string, unknown>) => Object.entries(a).map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`).join(" ");

/** SVG markup of a Lucide icon ("" when the name is unknown). */
export function lucide(name: string, cls = "h-4 w-4"): string {
  const n = ALL.get(name);
  if (!n) return "";
  return `<svg class="${cls} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${n.map(([t, a]) => `<${t} ${attrs(a)}/>`).join("")}</svg>`;
}

const MAX = 240; // ponytail: render cap per search keeps the grid snappy; virtual scroll if people want to browse all
let dlg: HTMLDialogElement | null = null;
let done: ((v: string | null) => void) | null = null;

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "fixed inset-0 m-auto h-[70vh] w-[34rem] max-w-[92vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70";
  dlg.innerHTML = `
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-2 border-b border-zinc-800 p-3">
        <input data-q type="search" placeholder="Search ${iconNames.length} icons…" class="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-amber-500" />
        <button data-none class="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">No icon</button>
      </div>
      <div data-grid class="grid flex-1 auto-rows-[2.75rem] grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] content-start gap-1 overflow-auto p-3"></div>
      <p data-info class="border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-500"></p>
    </div>`;
  document.body.append(dlg);
  const q = dlg.querySelector<HTMLInputElement>("[data-q]")!;
  const grid = dlg.querySelector<HTMLElement>("[data-grid]")!;
  const info = dlg.querySelector<HTMLElement>("[data-info]")!;
  const finish = (v: string | null) => (dlg!.close(), done?.(v), (done = null));
  q.oninput = () => {
    const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = iconNames.filter((n) => words.every((w) => n.includes(w)));
    grid.innerHTML = hits
      .slice(0, MAX)
      .map((n) => `<button data-n="${n}" title="${n}" class="grid place-items-center rounded-lg text-zinc-300 hover:bg-zinc-800 hover:text-amber-400 focus-visible:bg-zinc-800">${lucide(n, "h-5 w-5")}</button>`)
      .join("");
    info.textContent = hits.length > MAX ? `${hits.length} matches, showing ${MAX} - type more to narrow` : `${hits.length} matches`;
  };
  q.onkeydown = (e) => e.key === "Enter" && grid.querySelector<HTMLElement>("[data-n]")?.click();
  grid.onclick = (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-n]");
    if (b) finish(b.dataset.n!);
  };
  dlg.querySelector<HTMLElement>("[data-none]")!.onclick = () => finish("");
  dlg.addEventListener("cancel", (e) => (e.preventDefault(), finish(null)));
  dlg.onclick = (e) => e.target === dlg && finish(null); // click on the backdrop
}

/** Opens the picker. Resolves to an icon name, "" for "No icon", or null when cancelled. */
export function pickIcon(): Promise<string | null> {
  if (!dlg) build();
  done?.(null);
  const q = dlg!.querySelector<HTMLInputElement>("[data-q]")!;
  q.value = "";
  q.dispatchEvent(new Event("input"));
  dlg!.showModal();
  q.focus();
  return new Promise((res) => (done = res));
}
