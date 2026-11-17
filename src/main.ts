import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { compile, draftName, FOLLOW_LOST, HEARTBEAT, LOG_MARK, parseManifest, parsePm2, parseMounts, QUEUE_SKIPPED, scripts, SHELL_CMD, TEMPLATE, type Manifest } from "./deploy";
import { createEditor } from "./editor";
import { createEasy } from "./easy";
import { createFlow } from "./flow";
import { marked } from "marked";
import { safeMd as calMd, toggleTask } from "./notes";
import { createMdEditor, setImageResolver } from "./mdedit";
import { createSqlEditor } from "./sqledit";
import manualMd from "./manual.md?raw";
import { fmtSize, joinPath, listScript, parentOf, parseListing, PREVIEW_BYTES, readScript, MEDIA_MAX, mimeFor, mediaScript, writeScript, sudoWriteScript, newFileScript, mkdirScript, modeFor, uploadScript, extractScript, isArchive, type Entry } from "./files";
import { arg, connUrl, countSql, createSql, dbsSql, DEFAULTS, deleteSql, fksSql, fromUrl, indexSql, insertSql, isRead, KIND_LABEL, objectsSql, qid, schemaSql, selectSql, statements, structSql, toCsv, toUrl, toXlsx, truncateSql, capRows, dur, tunnelOf, updateSql, viaLocal, withDb, withPw, withSchema, schemasSql, type Col, type ConnForm, type Dialect, type Kind, type NewCol, type Sort, type Src, selectFrom, editCols, builderSql, type Qb, type JoinType, FILTER_OPS, type QbFilter } from "./basecurves";
import { cdLine, CRON_READ, CRON_WRITE, parseCrontab, serializeCrontab, validSched, type CronLine } from "./cron";
import { parseStats, STATS_SCRIPT, type Cpu, type Stats } from "./stats";
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { paginate, renderLines } from "./mdlines";
import { parseHeaders, pretty, withScheme } from "./post";
import { lucide, pickIcon } from "./iconpick";
// Notepad fonts, bundled so they work offline
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "@fontsource/space-mono/400-italic.css";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/500.css";
import "@fontsource/roboto-mono/700.css";
import "@fontsource/roboto-mono/400-italic.css";
import "@fontsource/noto-sans-thai-looped/400.css";
import "@fontsource/noto-sans-thai-looped/500.css";
import "@fontsource/noto-sans-thai-looped/700.css";

// Notepad page setup, chosen per note when it is created (kept in sqlite: notepad_meta)
const NP_PAPERS = [["", "Plain"], ["ruled", "Lined + margin"], ["lined", "Lined"], ["dots", "Dots"]];
const NP_ORIENTS = [["portrait", "Portrait"], ["landscape", "Landscape"]];
// Notepad fonts (bundled via @fontsource, imported above); Thai falls back to Noto Sans Thai Looped. First = default.
const NP_FONTS = [
  ["space", "Space Mono", `"Space Mono", "Noto Sans Thai Looped", monospace`],
  ["roboto", "Roboto Mono", `"Roboto Mono", "Noto Sans Thai Looped", monospace`],
  ["noto", "Noto Sans Thai Looped", `"Noto Sans Thai Looped", sans-serif`],
];
type Conn = { id: number; name: string; host: string; port: number; user: string; key_path: string };
type Status = "connecting" | "live" | "closed";

const db = await Database.load("sqlite:suncurved.db");
await db.execute(`CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22, user TEXT NOT NULL, key_path TEXT NOT NULL DEFAULT '')`);
await db.execute("CREATE TABLE IF NOT EXISTS wallpapers (conn_id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
// BaseCurves query history (Main page). `result` = "12 rows" / "3 affected" / the error text; ok = 0 on error.
await db.execute("CREATE TABLE IF NOT EXISTS bc_history (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, conn TEXT NOT NULL, db TEXT NOT NULL, schema TEXT NOT NULL, sql TEXT NOT NULL, ms INTEGER NOT NULL, result TEXT NOT NULL, ok INTEGER NOT NULL)");
// Saved queries (Main page), optionally grouped in one level of folders; folder NULL = top level.
await db.execute("CREATE TABLE IF NOT EXISTS bc_folders (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
await db.execute("CREATE TABLE IF NOT EXISTS bc_saved (id INTEGER PRIMARY KEY, folder INTEGER, name TEXT NOT NULL, sql TEXT NOT NULL, at INTEGER NOT NULL)");

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const loadConns = () => db.select<Conn[]>("SELECT * FROM connections ORDER BY name");

async function saveConn(form: HTMLFormElement) {
  const d = Object.fromEntries(new FormData(form)) as Record<string, string>;
  const vals = [d.name, d.host.trim(), +d.port, d.user, d.key_path.trim()];
  if (d.id) {
    await db.execute("UPDATE connections SET name=$1, host=$2, port=$3, user=$4, key_path=$5 WHERE id=$6", [...vals, +d.id]);
    await invoke("set_secret", { id: +d.id, secretValue: d.secret }); // blank = remove saved password
  } else {
    const r = await db.execute("INSERT INTO connections (name, host, port, user, key_path) VALUES ($1, $2, $3, $4, $5)", vals);
    await invoke("set_secret", { id: r.lastInsertId, secretValue: d.secret });
  }
}

async function deleteConn(id: number) {
  await db.execute("DELETE FROM connections WHERE id = $1", [id]);
  await invoke("del_secret", { id });
  await db.execute("DELETE FROM wallpapers WHERE conn_id = $1", [id]);
}

// ---------- wallpaper (per server, stored locally as a downscaled JPEG data URL) ----------

const loadWall = async (id: number) =>
  (await db.select<{ data: string }[]>("SELECT data FROM wallpapers WHERE conn_id = $1", [id]))[0]?.data;

/** Native file picker -> image shrunk to fit 2560x1440, or null if cancelled. */
async function pickImage() {
  const inp = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
  const file = await new Promise<File | undefined>((res) => {
    inp.onchange = () => res(inp.files?.[0]);
    inp.oncancel = () => res(undefined);
    inp.click();
  });
  if (!file) return null;
  const img = await createImageBitmap(file);
  const k = Math.min(1, 2560 / img.width, 1440 / img.height);
  const cv = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.85);
}

/** Loads the saved background into `desk` and gives it a right-click Personalize menu. id 0 = main display. */
function wallpaper(desk: HTMLElement, id: number) {
  const setWall = (url?: string) => {
    desk.style.backgroundImage = url ? `url("${url}")` : "";
    desk.classList.toggle("has-wall", !!url);
  };
  loadWall(id).then(setWall);
  const pick = async () => {
    const url = await pickImage();
    if (!url) return;
    await db.execute("INSERT OR REPLACE INTO wallpapers (conn_id, data) VALUES ($1, $2)", [id, url]);
    setWall(url);
  };
  const remove = async () => {
    await db.execute("DELETE FROM wallpapers WHERE conn_id = $1", [id]);
    setWall();
  };
  const sizeKey = `iconSize:${id}`;
  const setSize = (s: string) => {
    localStorage[sizeKey] = s;
    desk.classList.remove("icons-sm", "icons-lg");
    if (s !== "md") desk.classList.add(`icons-${s}`);
  };
  setSize(localStorage[sizeKey] ?? "md");
  const sizeItem = (s: string, label: string): MenuItem =>
    [label, localStorage[sizeKey] === s ? "check" : "none", () => setSize(s)];
  desk.oncontextmenu = (e) => {
    if ((e.target as HTMLElement).closest("button")) return e.preventDefault(); // icons get their own menu later
    contextMenu(e, [
      sizeItem("lg", "Large icons"),
      sizeItem("md", "Medium icons"),
      sizeItem("sm", "Small icons"),
      ["Personalize", "image", pick],
      ...(desk.classList.contains("has-wall") ? [["Remove background", "x", remove] as MenuItem] : []),
    ]);
  };
  return { pick, remove };
}

// ---------- our own right-click menu ----------

type MenuItem = [label: string, ic: keyof typeof ICONS, run: () => void];
const hideMenu = () => $("#ctx").classList.add("hidden");

function contextMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  const m = $("#ctx");
  m.innerHTML = items
    .map(([label, ic], i) => `<button data-mi="${i}" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left hover:bg-amber-500 hover:text-black">${icon(ic)} ${esc(label)}</button>`)
    .join("");
  m.querySelectorAll<HTMLElement>("[data-mi]").forEach((b) => (b.onclick = () => (hideMenu(), items[+b.dataset.mi!][2]())));
  m.classList.remove("hidden");
  m.style.left = `${Math.min(e.clientX, innerWidth - m.offsetWidth - 4)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - m.offsetHeight - 4)}px`;
}

// ---------- icons (inline SVG, no emoji) ----------

// 2D line icons, 24x24, drawn with currentColor so they follow text colour and theme.
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54Z"/>',
  network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8"/>',
  list: '<path d="M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13"/>',
  none: "", // blank slot keeps menu labels aligned
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  arrowUp: '<path d="m5 12 7-7 7 7M12 19V5"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  corner: '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  minimize: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  logs: '<path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  navBack: '<path d="M15.5 6.2v11.6a1 1 0 0 1-1.6.8L6.8 12.8a1 1 0 0 1 0-1.6l7.1-5.8a1 1 0 0 1 1.6.8z"/>',
  navHome: '<circle cx="12" cy="12" r="6.8"/>',
  navApps: '<rect x="5.6" y="5.6" width="12.8" height="12.8" rx="3.2"/>',
  table: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M9 9v12"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  playAll: '<path d="m4 4 9 8-9 8z"/><path d="m13 4 9 8-9 8z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  unplug: '<path d="m19 5 3-3M2 22l3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="m18 12-6-6 2.3-2.3a2.4 2.4 0 0 1 3.4 0l2.6 2.6a2.4 2.4 0 0 1 0 3.4Z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
};
const icon = (name: keyof typeof ICONS, cls = "h-4 w-4") =>
  `<svg class="${cls} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** Desktop-style app icon for the machine home grid; `data-<key>` is the click hook. */
const appTile = (key: string, art: keyof typeof ART, label: string, disabled = false) => `
  <button data-${key} ${disabled ? "disabled" : ""} class="group flex flex-col items-center gap-2 rounded-2xl p-3 enabled:hover:bg-zinc-800/50 disabled:cursor-not-allowed disabled:opacity-40">
    <span class="transition-transform duration-200 group-enabled:group-hover:-translate-y-1 group-enabled:group-hover:scale-105">${appArt(art)}</span>
    <span class="text-sm font-medium">${label}</span>
  </button>`;

let artSeq = 0;
/** Hand-drawn 3D app illustrations, 64x64; `#{id}` is made unique per instance. */
const ART = {
  rocket: `
    <defs>
      <linearGradient id="{id}b" x1="0" x2="1"><stop offset="0" stop-color="#64748b"/><stop offset=".35" stop-color="#fff"/><stop offset=".7" stop-color="#e2e8f0"/><stop offset="1" stop-color="#475569"/></linearGradient>
      <linearGradient id="{id}f" x1="0" x2="1"><stop offset="0" stop-color="#fb923c"/><stop offset=".5" stop-color="#ef4444"/><stop offset="1" stop-color="#9f1239"/></linearGradient>
      <linearGradient id="{id}fl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef08a"/><stop offset=".45" stop-color="#f97316"/><stop offset="1" stop-color="#dc2626" stop-opacity="0"/></linearGradient>
      <radialGradient id="{id}g" cx=".35" cy=".3"><stop offset="0" stop-color="#bae6fd"/><stop offset=".6" stop-color="#0ea5e9"/><stop offset="1" stop-color="#1e3a8a"/></radialGradient>
      <radialGradient id="{id}h"><stop offset="0" stop-color="#fb923c" stop-opacity=".55"/><stop offset="1" stop-color="#fb923c" stop-opacity="0"/></radialGradient>
    </defs>
    <circle cx="22" cy="44" r="20" fill="url(#{id}h)"/>
    <g transform="rotate(45 32 32)">
      <path d="M26.5 46Q32 66 37.5 46Z" fill="url(#{id}fl)"><animate attributeName="d" values="M26.5 46Q32 66 37.5 46Z;M26.5 46Q32 60 37.5 46Z;M26.5 46Q32 66 37.5 46Z" dur=".5s" repeatCount="indefinite"/></path>
      <path d="M24 32 15 46l9-2Z" fill="url(#{id}f)"/><path d="M40 32l9 14-9-2Z" fill="url(#{id}f)"/>
      <path d="M32 5c8 8 10.5 21 8.5 39h-17C21.5 26 24 13 32 5Z" fill="url(#{id}b)"/>
      <path d="M32 5c3.6 3.6 6 7.6 7.4 12.5H24.6C26 12.6 28.4 8.6 32 5Z" fill="url(#{id}f)"/>
      <rect x="25.5" y="44" width="13" height="3.5" rx="1.2" fill="#334155"/>
      <path d="M31 36h2v12h-2Z" fill="url(#{id}f)"/>
      <circle cx="32" cy="26" r="5.6" fill="#cbd5e1"/><circle cx="32" cy="26" r="4.2" fill="url(#{id}g)"/>
      <circle cx="30.4" cy="24.4" r="1.3" fill="#fff" opacity=".9"/>
    </g>`,
  terminal: `
    <defs>
      <linearGradient id="{id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#64748b"/><stop offset="1" stop-color="#1e293b"/></linearGradient>
      <radialGradient id="{id}s" cx=".3" cy=".25" r="1"><stop offset="0" stop-color="#065f46"/><stop offset="1" stop-color="#020617"/></radialGradient>
      <linearGradient id="{id}st" x1="0" x2="1"><stop offset="0" stop-color="#334155"/><stop offset=".5" stop-color="#94a3b8"/><stop offset="1" stop-color="#334155"/></linearGradient>
      <filter id="{id}glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <path d="M25 46h14l4 9H21Z" fill="url(#{id}st)"/>
    <ellipse cx="32" cy="56" rx="14" ry="2.6" fill="#1e293b"/>
    <rect x="5" y="11" width="54" height="39" rx="7" fill="#020617"/>
    <rect x="5" y="8" width="54" height="39" rx="7" fill="url(#{id}b)"/>
    <rect x="5.6" y="8.6" width="52.8" height="37.8" rx="6.4" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="1.2"/>
    <circle cx="11" cy="12.5" r="1.3" fill="#f87171"/><circle cx="15" cy="12.5" r="1.3" fill="#fbbf24"/><circle cx="19" cy="12.5" r="1.3" fill="#34d399"/>
    <rect x="9" y="16" width="46" height="27" rx="3" fill="url(#{id}s)"/>
    <g fill="none" stroke="#4ade80" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" filter="url(#{id}glow)">
      <path d="m15 23 5 4-5 4"/>
    </g>
    <rect x="23" y="29.5" width="8" height="2.6" rx=".8" fill="#4ade80" filter="url(#{id}glow)"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;.5;.5;1" dur="1.1s" repeatCount="indefinite"/></rect>
    <rect x="15" y="36" width="22" height="1.6" rx=".8" fill="#4ade80" opacity=".35"/>
    <rect x="15" y="39.5" width="14" height="1.6" rx=".8" fill="#4ade80" opacity=".2"/>
    <path d="M9 16h18L15 43H9Z" fill="#fff" opacity=".06"/>`,
  folder: `
    <defs>
      <linearGradient id="{id}k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d4ed8"/><stop offset="1" stop-color="#172554"/></linearGradient>
      <linearGradient id="{id}fr" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset=".55" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e40af"/></linearGradient>
      <linearGradient id="{id}p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient>
    </defs>
    <path d="M7 16a3 3 0 0 1 3-3h13l4.5 4.5H54a3 3 0 0 1 3 3V50a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3Z" fill="url(#{id}k)"/>
    <g transform="rotate(-7 32 30)"><rect x="13" y="17" width="34" height="26" rx="2" fill="#e2e8f0"/></g>
    <g transform="rotate(5 32 30)">
      <rect x="16" y="15" width="34" height="26" rx="2" fill="url(#{id}p)"/>
      <rect x="20" y="20" width="18" height="2" rx="1" fill="#94a3b8"/><rect x="20" y="25" width="24" height="2" rx="1" fill="#cbd5e1"/><rect x="20" y="30" width="14" height="2" rx="1" fill="#cbd5e1"/>
    </g>
    <path d="M5 29.5A3 3 0 0 1 8 26.3h48a3 3 0 0 1 3 3.4l-2.6 20.6A3.2 3.2 0 0 1 53.2 53H10.8a3.2 3.2 0 0 1-3.2-2.7Z" fill="url(#{id}fr)"/>
    <path d="M8 27.6h48" stroke="#fff" stroke-opacity=".6" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M9 30h46l-1 7c-14 3-30 3-44 0Z" fill="#fff" opacity=".12"/>`,
  file: `
    <defs><linearGradient id="{id}p" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient></defs>
    <path d="M14 6h24l14 14v36a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" fill="#334155" opacity=".45" transform="translate(2.5 3)"/>
    <path d="M14 6h24l14 14v36a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" fill="url(#{id}p)"/>
    <path d="M38 6v11a3 3 0 0 0 3 3h11Z" fill="#94a3b8"/>
    <rect x="17" y="25" width="22" height="3" rx="1.5" fill="#cbd5e1"/><rect x="17" y="31" width="16" height="3" rx="1.5" fill="#cbd5e1"/>
    <rect x="11" y="40" width="41" height="11" fill="{c}"/><rect x="11" y="40" width="41" height="3" fill="#fff" opacity=".3"/>`,
  devops: `
    <defs>
      <linearGradient id="{id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#334155"/><stop offset="1" stop-color="#0f172a"/></linearGradient>
      <linearGradient id="{id}l" x1="0" x2="1"><stop offset="0" stop-color="#38bdf8"/><stop offset=".5" stop-color="#a78bfa"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>
      <filter id="{id}glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect x="4" y="7" width="56" height="54" rx="14" fill="#020617"/>
    <rect x="4" y="4" width="56" height="54" rx="14" fill="url(#{id}bg)"/>
    <rect x="4.6" y="4.6" width="54.8" height="52.8" rx="13.4" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="1.2"/>
    <path d="M32 31c-4-5-7-8-11.5-8a8 8 0 0 0 0 16c4.5 0 7.5-3 11.5-8s7-8 11.5-8a8 8 0 0 1 0 16c-4.5 0-7.5-3-11.5-8Z" fill="none" stroke="#020617" stroke-opacity=".6" stroke-width="7" transform="translate(0 2)"/>
    <path d="M32 31c-4-5-7-8-11.5-8a8 8 0 0 0 0 16c4.5 0 7.5-3 11.5-8s7-8 11.5-8a8 8 0 0 1 0 16c-4.5 0-7.5-3-11.5-8Z" fill="none" stroke="url(#{id}l)" stroke-width="6" stroke-linecap="round" filter="url(#{id}glow)"/>
    <path d="M32 31c-4-5-7-8-11.5-8a8 8 0 0 0 0 16c4.5 0 7.5-3 11.5-8s7-8 11.5-8a8 8 0 0 1 0 16c-4.5 0-7.5-3-11.5-8Z" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1.6" stroke-dasharray="6 58" pathLength="64"><animate attributeName="stroke-dashoffset" values="0;-64" dur="2.4s" repeatCount="indefinite"/></path>
    <path d="M8 18a14 14 0 0 1 14-10h20a14 14 0 0 1 14 10Z" fill="#fff" opacity=".07"/>`,
  settings: `
    <defs>
      <linearGradient id="{id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#52525b"/><stop offset="1" stop-color="#18181b"/></linearGradient>
      <linearGradient id="{id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f4f5"/><stop offset=".5" stop-color="#a1a1aa"/><stop offset="1" stop-color="#52525b"/></linearGradient>
    </defs>
    <rect x="4" y="7" width="56" height="54" rx="14" fill="#09090b"/>
    <rect x="4" y="4" width="56" height="54" rx="14" fill="url(#{id}bg)"/>
    <rect x="4.6" y="4.6" width="54.8" height="52.8" rx="13.4" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="1.2"/>
    <g transform="translate(0 2)" opacity=".5"><circle cx="32" cy="31" r="13" fill="none" stroke="#000" stroke-width="7" stroke-dasharray="5.1 5.1"/></g>
    <g>
      <animateTransform attributeName="transform" type="rotate" from="0 32 31" to="360 32 31" dur="12s" repeatCount="indefinite"/>
      <circle cx="32" cy="31" r="15" fill="none" stroke="url(#{id}g)" stroke-width="6" stroke-dasharray="5.9 5.9"/>
      <circle cx="32" cy="31" r="12.5" fill="url(#{id}g)"/>
      <circle cx="32" cy="31" r="5" fill="#27272a"/>
      <circle cx="32" cy="31" r="5" fill="none" stroke="#000" stroke-opacity=".4" stroke-width="1"/>
    </g>
    <path d="M8 18a14 14 0 0 1 14-10h20a14 14 0 0 1 14 10Z" fill="#fff" opacity=".07"/>`,
  clock: `
    <defs>
      <linearGradient id="{id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#0f172a"/></linearGradient>
      <linearGradient id="{id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset=".5" stop-color="#f59e0b"/><stop offset="1" stop-color="#b45309"/></linearGradient>
    </defs>
    <rect x="4" y="7" width="56" height="54" rx="14" fill="#020617"/>
    <rect x="4" y="4" width="56" height="54" rx="14" fill="url(#{id}bg)"/>
    <rect x="4.6" y="4.6" width="54.8" height="52.8" rx="13.4" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="1.2"/>
    <g>
      <animateTransform attributeName="transform" type="rotate" from="0 32 31" to="360 32 31" dur="10s" repeatCount="indefinite"/>
      <circle cx="32" cy="31" r="17" fill="none" stroke="url(#{id}g)" stroke-width="6" stroke-dasharray="3.4 3.28"/>
      <circle cx="32" cy="31" r="14.5" fill="url(#{id}g)"/>
    </g>
    <circle cx="32" cy="31" r="10.5" fill="#0f172a"/>
    <g stroke="#fde68a" stroke-width="2.4" stroke-linecap="round"><path d="M32 31v-7"/><path d="M32 31l5 3"/></g>
    <circle cx="32" cy="31" r="1.8" fill="#fde68a"/>
    <path d="M8 18a14 14 0 0 1 14-10h20a14 14 0 0 1 14 10Z" fill="#fff" opacity=".07"/>`,
  post: `
    <defs>
      <linearGradient id="{id}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fb923c"/><stop offset="1" stop-color="#c2410c"/></linearGradient>
      <radialGradient id="{id}s" cx=".35" cy=".3"><stop offset="0" stop-color="#fef9c3"/><stop offset=".6" stop-color="#fde047"/><stop offset="1" stop-color="#f59e0b"/></radialGradient>
    </defs>
    <rect x="4" y="7" width="56" height="54" rx="14" fill="#7c2d12"/>
    <rect x="4" y="4" width="56" height="54" rx="14" fill="url(#{id}bg)"/>
    <g stroke="#fef3c7" stroke-width="2.4" stroke-linecap="round" opacity=".85">
      <animateTransform attributeName="transform" type="rotate" from="0 32 31" to="360 32 31" dur="12s" repeatCount="indefinite"/>
      <path d="M32 11v5M32 46v5M12 31h5M47 31h5M18 17l3.5 3.5M42.5 41.5 46 45M18 45l3.5-3.5M42.5 20.5 46 17"/>
    </g>
    <circle cx="32" cy="31" r="11" fill="url(#{id}s)"/>
    <path d="M26 31h12m-4-4 4 4-4 4" fill="none" stroke="#9a3412" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M8 18a14 14 0 0 1 14-10h20a14 14 0 0 1 14 10Z" fill="#fff" opacity=".1"/>`,
  database: `
    <defs><linearGradient id="{id}s" x1="0" x2="1"><stop offset="0" stop-color="#0e7490"/><stop offset=".4" stop-color="#22d3ee"/><stop offset="1" stop-color="#155e75"/></linearGradient></defs>
    <rect x="4" y="7" width="56" height="54" rx="14" fill="#020617"/>
    <rect x="4" y="4" width="56" height="54" rx="14" fill="#0f172a"/>
    <path d="M16 16v28c0 4 7 7 16 7s16-3 16-7V16Z" fill="url(#{id}s)"/>
    <g fill="none" stroke="#0f172a" stroke-opacity=".5" stroke-width="1.5"><path d="M16 26c0 4 7 7 16 7s16-3 16-7"/><path d="M16 35c0 4 7 7 16 7s16-3 16-7"/></g>
    <ellipse cx="32" cy="16" rx="16" ry="6" fill="#a5f3fc"/>
    <path d="M22 44c4-10 10-2 14-12s6-4 8-6" fill="none" stroke="#fbbf24" stroke-width="2.4" stroke-linecap="round"/>`,
  notepad: `
    <defs><linearGradient id="{id}p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef9c3"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs>
    <rect x="4" y="7" width="56" height="54" rx="14" fill="#a16207"/>
    <rect x="4" y="4" width="56" height="54" rx="14" fill="url(#{id}p)"/>
    <path d="M4 16a12 12 0 0 1 12-12h32a12 12 0 0 1 12 12v2H4Z" fill="#facc15"/>
    <g stroke="#ca8a04" stroke-opacity=".45" stroke-width="1.6" stroke-linecap="round"><path d="M14 28h36M14 36h36M14 44h24"/></g>
    <g transform="rotate(40 44 40)"><rect x="41" y="22" width="6" height="24" rx="1.5" fill="#f97316"/><path d="M41 46l3 6 3-6Z" fill="#fde68a"/><path d="M43.2 50.4 44 52l.8-1.6Z" fill="#27272a"/><rect x="41" y="20" width="6" height="4" rx="1.5" fill="#f472b6"/></g>`,
  // ponytail: date baked in at launch; goes stale if the app stays open past midnight.
  calendar: `
    <defs><linearGradient id="{id}t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f87171"/><stop offset="1" stop-color="#b91c1c"/></linearGradient></defs>
    <rect x="4" y="7" width="56" height="54" rx="14" fill="#52525b"/>
    <rect x="4" y="4" width="56" height="54" rx="14" fill="#fafafa"/>
    <path d="M4 18a14 14 0 0 1 14-14h28a14 14 0 0 1 14 14v2H4Z" fill="url(#{id}t)"/>
    <text x="32" y="16" text-anchor="middle" font-size="8" font-weight="700" fill="#fff" font-family="system-ui">${new Date().toLocaleString("en", { weekday: "short" }).toUpperCase()}</text>
    <text x="32" y="48" text-anchor="middle" font-size="26" font-weight="700" fill="#18181b" font-family="system-ui">${new Date().getDate()}</text>`,
};
/** `{c}` in the art is an accent colour (file type band). */
const appArt = (name: keyof typeof ART, cls = "h-20 w-20 drop-shadow-[0_8px_10px_rgb(0_0_0/0.45)]", c = "#94a3b8") =>
  `<svg class="app-art ${cls} shrink-0 overflow-visible" viewBox="0 0 64 64" aria-hidden="true">${ART[name].replace(/\{id\}/g, `a${++artSeq}`).replace(/\{c\}/g, c)}</svg>`;

// App art stays still until hovered: pause each one as it lands in the DOM, play while the pointer is on its button.
const arts = (n: Node) => (n instanceof Element ? [...(n.matches(".app-art") ? [n] : []), ...n.querySelectorAll(".app-art")] : []) as SVGSVGElement[];
// `.live` art (app headers) always plays, unless the OS asks for reduced motion.
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => arts(n).forEach((s) => (s.classList.contains("live") && !stillMotion) || s.pauseAnimations()))))
  .observe(document.body, { childList: true, subtree: true });
const hoverArt = (play: boolean) => (e: MouseEvent) => {
  const b = (e.target as Element).closest("button");
  if (!b || b.contains(e.relatedTarget as Node)) return; // moving between children of the same button
  arts(b).forEach((s) => s.classList.contains("live") || (play ? s.unpauseAnimations() : s.pauseAnimations()));
};

/** Amber ring spinner. */
const spinner = (cls = "h-4 w-4") => `<span class="${cls} inline-block shrink-0 animate-spin rounded-full border-2 border-amber-500/25 border-t-amber-500"></span>`;
/** Connection · database · schema selects (prefix q = Query view, b = Builder view). */
const ctxBar = (p: string) => [[`bc-${p}-conn`, "plug", "text-sky-400"], [`bc-${p}-db`, "database", "text-amber-400"], [`bc-${p}-schema`, "network", "text-emerald-400"]].map(([id, ic, color]) =>
  `<label data-for="${id}" class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 pl-2 focus-within:border-amber-500"><span class="${color}">${icon(ic as keyof typeof ICONS, "h-3.5 w-3.5")}</span>
    <select id="${id}" class="w-44 bg-transparent py-1 pr-1 text-zinc-100 outline-none disabled:text-zinc-600 [&>option]:bg-zinc-900"></select></label>`).join("");
/** Pending-edits bar for an editable grid (prefix bc-d = table data, bc-q = query results); hidden until a cell is changed. */
const updBar = (p: string) => `<span id="${p}-pend" class="hidden shrink-0 items-center gap-1.5">
  <button id="${p}-apply" title="Write the changed cells to the database (Ctrl+S)" class="flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1 font-semibold text-black ring-2 ring-amber-500/30 hover:bg-amber-400">${icon("check", "h-3.5 w-3.5")}Update<span id="${p}-n" class="rounded bg-black/20 px-1.5 font-mono text-[11px]"></span></button>
  <button id="${p}-discard" title="Throw away the changes" class="rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Discard</button></span>`;
/** Small icon+label toolbar button (BaseCurves view toolbars). */
const tb = (id: string, ic: keyof typeof ICONS, label: string) =>
  `<button id="${id}" class="flex items-center gap-1.5 rounded-md px-2 py-1 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-35">${icon(ic, "h-3.5 w-3.5")}${label}</button>`;

/** App header pieces: back arrow, then the app's art (always moving) with its name and a subtitle. */
const backBtn = (attrs: string, title: string) =>
  `<button ${attrs} title="${esc(title)}" aria-label="${esc(title)}" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("chevronLeft", "h-5 w-5")}</button>`;
const appTitle = (art: keyof typeof ART, title: string, sub: string) => `
  <span class="app-live art-${art}">${appArt(art, "live h-10 w-10 drop-shadow-[0_4px_6px_rgb(0_0_0/0.4)]")}</span>
  <div class="min-w-0 leading-tight"><p class="font-semibold">${title}</p><p class="truncate text-xs text-zinc-500">${sub}</p></div>`;
addEventListener("mouseover", hoverArt(true));
addEventListener("mouseout", hoverArt(false));
// Reload only on F5: Ctrl+R / Ctrl+Shift+R are swallowed. Bubble phase, so the terminal (bash reverse-search) still gets Ctrl+R first.
addEventListener("keydown", (e) => void ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r" && e.preventDefault()));

// Colour band on file icons, by extension.
const FILE_COLORS: [RegExp, string][] = [
  [/\.(ts|tsx|js|jsx|mjs|py|go|rs|java|c|cpp|h|php|rb|sh|bash|zsh)$/i, "#8b5cf6"],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i, "#ec4899"],
  [/\.(zip|gz|tgz|tar|xz|bz2|7z|rar|deb|rpm)$/i, "#f59e0b"],
  [/\.(json|ya?ml|toml|ini|conf|cfg|env|xml)$|^\.|rc$/i, "#10b981"],
  [/\.(md|txt|log|csv|pdf|docx?)$/i, "#3b82f6"],
  [/\.(db|sqlite3?|sql)$/i, "#ef4444"],
];
const fileColor = (name: string) => FILE_COLORS.find(([re]) => re.test(name))?.[1];

let logoSeq = 0;
/** 3D-shaded sun with a curved horizon ring: the Sun Curved mark. */
function logo(cls: string) {
  const n = ++logoSeq; // gradient ids must be unique per instance
  return `<svg class="${cls} shrink-0" viewBox="0 0 64 64" aria-label="Sun Curved">
    <defs>
      <radialGradient id="sc-body${n}" cx="36%" cy="30%" r="75%">
        <stop offset="0" stop-color="#fef3c7"/><stop offset=".3" stop-color="#fbbf24"/>
        <stop offset=".72" stop-color="#ea580c"/><stop offset="1" stop-color="#7c2d12"/>
      </radialGradient>
      <linearGradient id="sc-gloss${n}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="sc-ring${n}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fde68a" stop-opacity=".2"/><stop offset=".5" stop-color="#fff"/>
        <stop offset="1" stop-color="#fde68a" stop-opacity=".2"/>
      </linearGradient>
    </defs>
    <ellipse cx="32" cy="59" rx="17" ry="3" fill="#000" opacity=".22"/>
    <circle cx="32" cy="30" r="23" fill="url(#sc-body${n})"/>
    <ellipse cx="25.5" cy="18.5" rx="11" ry="6.5" fill="url(#sc-gloss${n})" opacity=".75"/>
    <path d="M4 37c11 9 45 9 56 0" fill="none" stroke="url(#sc-ring${n})" stroke-width="3.2" stroke-linecap="round"/>
  </svg>`;
}

// ---------- day / night ----------

const terms = new Set<Terminal>();
const isLight = () =>
  localStorage.theme ? localStorage.theme === "light" : matchMedia("(prefers-color-scheme: light)").matches;
/** Presets: accent + a hue blended into every zinc surface/border/text shade. */
type Theme = { accent: string; tint?: string; parts?: { light?: Parts; dark?: Parts } };
const THEMES: Record<string, Theme> = {
  Classic: { accent: "#f59e0b" },
  Ocean: { accent: "#0ea5e9", tint: "#0ea5e9" },
  Forest: { accent: "#10b981", tint: "#10b981" },
  Sakura: { accent: "#f43f5e", tint: "#f43f5e" },
  Grape: { accent: "#8b5cf6", tint: "#8b5cf6" },
};
const ZINC_STEPS = [950, 900, 800, 700, 600, 500, 400, 300, 200, 100];
const ZINC = {
  dark: ["#09090b", "#18181b", "#27272a", "#3f3f46", "#52525b", "#71717a", "#a1a1aa", "#d4d4d8", "#e4e4e7", "#f4f4f5"],
  light: ["#ffffff", "#f4f4f5", "#e4e4e7", "#d4d4d8", "#a1a1aa", "#71717a", "#52525b", "#3f3f46", "#27272a", "#18181b"],
};
const PARTS = [["accent", "Accent"], ["bg", "Background"], ["panel", "Panel"], ["text", "Text"]] as const;
type Parts = Partial<Record<(typeof PARTS)[number][0], string>>;
/** Custom per-part colors, kept separately for day and night. */
const partsKey = () => `themeParts:${isLight() ? "light" : "dark"}`;
const parts = (): Parts => {
  try { return JSON.parse(localStorage[partsKey()] ?? "{}"); } catch { return {}; }
};
/** Themes the user saved with "+ New theme". */
const userThemes = (): Record<string, Theme> => {
  try { return JSON.parse(localStorage.userThemes ?? "{}"); } catch { return {}; }
};
const allThemes = (): Record<string, Theme> => ({ ...THEMES, ...userThemes() });
const themeName = (): string => (localStorage.themeName in allThemes() ? localStorage.themeName : "Classic");
const curTheme = () => allThemes()[themeName()];
const accent = (): string => parts().accent ?? curTheme().accent;
const baseZinc = () => ZINC[isLight() ? "light" : "dark"];
const termTheme = () => ({
  background: parts().bg ?? baseZinc()[0],
  foreground: parts().text ?? (isLight() ? "#18181b" : "#e4e4e7"),
  cursor: accent(),
  selectionBackground: accent() + "55",
});

/** The UI is written with zinc + amber classes; a theme just repoints those tokens. */
function applyAccent() {
  const c = accent(), s = document.documentElement.style, p = parts(), tint = curTheme().tint;
  const mix = (a: string, b: string, pct: number) => `color-mix(in oklab, ${b} ${pct}%, ${a})`;
  const z = baseZinc().map((x) => (tint ? mix(x, tint, isLight() ? 6 : 10) : x));
  if (p.bg) z[0] = p.bg;
  if (p.panel) z[1] = p.panel;
  if (p.text) z[9] = p.text;
  // Borders and muted text sit between panel and text, so they follow custom colors.
  if (p.panel || p.text) [10, 20, 35, 48, 62, 78, 90].forEach((pct, i) => (z[i + 2] = mix(z[1], z[9], pct)));
  ZINC_STEPS.forEach((n, i) => s.setProperty(`--color-zinc-${n}`, z[i]));
  s.setProperty("--color-amber-500", c);
  s.setProperty("--color-amber-400", `color-mix(in oklab, ${c} 75%, ${isLight() ? "black" : "white"})`);
  s.setProperty("--code-cursor", c);
}

/** Applies day/night; `save` remembers the choice, otherwise the OS setting is followed. */
function setTheme(light: boolean, save = false) {
  if (save) localStorage.theme = light ? "light" : "dark";
  document.documentElement.classList.toggle("light", light);
  applyAccent();
  terms.forEach((t) => (t.options.theme = termTheme()));
  const b = $("#theme");
  b.innerHTML = icon(light ? "moon" : "sun", "h-[18px] w-[18px]");
  b.title = light ? "Switch to night mode" : "Switch to day mode";
}

// ---------- remote workspace setup ----------

// ponytail: fixed path; make it a per-connection setting if machines differ.
const REMOTE_DIR = "~/EndFroZen/SunCurved";
const REMOTE_DB = "suncurved.db";
// An empty file is a valid (empty) SQLite database, so no sqlite3 binary is needed on the machine.
const SETUP_SCRIPT = `d="$HOME/${REMOTE_DIR.slice(2)}"; f="$d/${REMOTE_DB}"
if [ -d "$d" ]; then echo dir=exists; else mkdir -p "$d" && echo dir=created; fi
if [ -f "$f" ]; then echo db=exists; else : > "$f" && echo db=created; fi`;

type LogLevel = "info" | "step" | "ok" | "warn" | "err" | "note";
const LOG_COLOR: Record<LogLevel, string> = { info: "text-zinc-400", step: "font-semibold text-zinc-100", ok: "text-emerald-400", warn: "text-amber-400", err: "text-red-400", note: "font-medium text-sky-400" };

// ---------- auth popup (password / 2FA asked by the server) ----------

type AuthPrompt = { req: number; sid: number; instructions: string; prompts: [string, boolean][] };
const authQueue: AuthPrompt[] = [];

function showAuth() {
  const dlg = $<HTMLDialogElement>("#auth");
  const a = authQueue[0];
  if (dlg.open || !a) return;
  const tab = tabs.find((t) => t.sid === a.sid);
  $("#auth-title").textContent = tab ? `Sign in to ${tab.conn.name}` : "Sign in";
  $("#auth-sub").textContent = a.instructions || (tab ? `${tab.conn.user}@${tab.conn.host}` : "");
  $("#auth-fields").innerHTML = a.prompts
    .map(([text, echo], i) => {
      const otp = /code|token|otp/i.test(text);
      return `<label class="block text-xs text-zinc-400">${esc(text.replace(/^\(.*?\)\s*/, ""))}
        <input data-i="${i}" type="${echo || otp ? "text" : "password"}" ${otp ? 'inputmode="numeric" autocomplete="one-time-code"' : 'autocomplete="off"'}
          class="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 ${otp ? "font-mono tracking-[0.3em]" : ""} text-sm text-zinc-100 outline-none focus:border-amber-500" />
      </label>`;
    })
    .join("");
  dlg.showModal();
  $<HTMLInputElement>("#auth-fields input").focus();
}

function answerAuth(answers: string[] | null) {
  const a = authQueue.shift();
  $<HTMLDialogElement>("#auth").close();
  if (a) invoke("auth_answer", { req: a.req, answers });
  showAuth();
}

/** Drop pending prompts of a session that's going away. */
function cancelAuth(sid: number) {
  if (authQueue[0]?.sid === sid) answerAuth(null);
  for (let i = authQueue.length - 1; i >= 0; i--)
    if (authQueue[i].sid === sid) invoke("auth_answer", { req: authQueue.splice(i, 1)[0].req, answers: null });
}

// ---------- new UI ----------

type Tab = { key: number; sid: number; conn: Conn; pane: HTMLElement; status: Status; close: () => void; where: string };
let sidSeq = 0;
const tabs: Tab[] = [];
let activeKey = 0;
let tabSeq = 0;
let conns: Conn[] = [];

const dot = (s: Status | undefined) =>
  `<span class="inline-block h-2 w-2 shrink-0 rounded-full ${
    s === "live" ? "bg-emerald-400" : s === "connecting" ? "animate-pulse bg-amber-400" : s === "closed" ? "bg-red-500" : "bg-zinc-600"
  }"></span>`;

async function app() {
  document.body.className = "bg-zinc-950 text-zinc-100 antialiased";
  document.body.innerHTML = `
    <div class="flex h-screen">
      <aside class="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
        <div class="flex items-center gap-3 px-3 py-4">
          ${backBtn('id="home"', "Main display")}
          ${appTitle("devops", "DevOps", "SSH workspace")}
          <button id="manual-open" title="Deploy YAML manual" class="ml-auto rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("book")}</button>
          <button id="theme" class=" rounded-lg px-2 py-1 text-base hover:bg-zinc-800"></button>
        </div>
        <div class="px-3">
          <input id="q" placeholder="Search servers…" class="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500" />
        </div>
        <div class="flex items-center justify-between px-5 pb-2 pt-5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Servers
          <button id="add" class="rounded-md px-2 py-0.5 normal-case tracking-normal text-amber-400 hover:bg-zinc-800">+ New</button>
        </div>
        <nav id="list" class="flex-1 space-y-0.5 overflow-auto px-3 pb-3"></nav>
      </aside>
      <main class="flex min-w-0 flex-1 flex-col">
        <div id="tabs" class="flex h-11 shrink-0 items-end gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900 px-2"></div>
        <div id="stage" class="relative flex-1"></div>
      </main>
    </div>
    <div id="launcher" class="fixed inset-0 z-40 flex flex-col bg-zinc-950 bg-cover bg-center p-8">
      <div class="flex items-center gap-3">
        ${logo("h-10 w-10")}
        <p class="font-semibold">Sun Curved</p>
      </div>
      <div class="tiles mt-8 flex-1">
        ${appTile("devops", "devops", "DevOps")}
        ${appTile("settings", "settings", "Settings")}
        ${appTile("calendar", "calendar", "Calendar")}
        ${appTile("basecurves", "database", "BaseCurves")}
        ${appTile("post", "post", "Sun Post")}
        ${appTile("notepad", "notepad", "Notepad")}
      </div>
    </div>
    <!-- Current path, bottom-left on every screen -->
    <button id="path" title="Click to copy" class="fixed bottom-2 left-3 z-[70] max-w-[22rem] truncate rounded-md border border-transparent px-2 py-0.5 text-left font-mono text-[11px] leading-5 text-zinc-500 transition-colors hover:max-w-[calc(100vw-1.5rem)] hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 hover:shadow-lg [&.copied]:text-emerald-400"></button>
    <!-- Floating ball (like iPhone AssistiveTouch): drag anywhere, snaps to the nearest side; tap opens Back / Home / Apps. -->
    <nav id="navbar" aria-label="Navigation" class="group/nav fixed z-[75] h-12 w-12 select-none" style="right:12px;bottom:96px">
      <button id="nav-ball" title="Navigation (drag to move)" aria-label="Navigation" class="relative grid h-12 w-12 touch-none place-items-center rounded-full border border-white/10 bg-zinc-900/60 opacity-70 shadow-[0_8px_24px_rgb(0_0_0/0.35)] backdrop-blur-md transition-[opacity,transform] hover:opacity-100 active:scale-95 group-[.open]/nav:opacity-100">
        <span class="h-7 w-7 rounded-full bg-white/70 ring-[5px] ring-white/25"></span>
        <span id="sw-n" class="absolute -right-0.5 -top-0.5 hidden min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] font-bold leading-4 text-black">0</span>
      </button>
      <div id="nav-menu" class="absolute top-1/2 hidden -translate-y-1/2 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900/90 p-1.5 text-zinc-300 shadow-2xl shadow-black/50 backdrop-blur-md group-[.open]/nav:flex">
        <button id="nav-back" title="Back" aria-label="Back" class="grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-700 hover:text-zinc-100 active:scale-90">${icon("navBack", "h-5 w-5")}</button>
        <button id="nav-home" title="Home" aria-label="Home" class="grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-700 hover:text-zinc-100 active:scale-90">${icon("navHome", "h-5 w-5")}</button>
        <button id="nav-apps" title="Running apps" aria-label="Running apps" class="grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-700 hover:text-zinc-100 active:scale-90 [&.on]:text-amber-400">${icon("navApps", "h-5 w-5")}</button>
      </div>
    </nav>
    <div id="switcher" class="fixed inset-0 z-[60] hidden flex-col bg-black/75 p-8 text-zinc-100 backdrop-blur-md">
      <div class="flex items-center gap-4">
        <h2 class="text-xl font-semibold">Running apps</h2>
        <span id="sw-mem" class="rounded-full border border-zinc-700 px-3 py-1 font-mono text-xs text-zinc-400"></span>
        <button id="sw-clear" class="ml-auto rounded-lg px-4 py-2 text-sm text-red-400 hover:bg-red-500/15 disabled:opacity-30">Clear all</button>
        <button id="sw-close" title="Close (Esc)" class="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("x", "h-5 w-5")}</button>
      </div>
      <p class="mt-1 text-sm text-zinc-500">Swipe a card up (or press ✕) to close the app and free its memory, connections and SSH sessions. Click a card to open it.</p>
      <div id="sw-cards" class="flex flex-1 touch-none items-center gap-8 overflow-x-auto px-4"></div>
    </div>
    <dialog id="dlg" class="fixed inset-0 m-auto h-fit w-[28rem] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <form id="f" class="space-y-3 p-6">
        <h2 id="dlg-title" class="text-lg font-semibold">New SSH connection</h2>
        <input type="hidden" name="id" />
        ${field("name", "Name", "Production web")}
        <div class="flex gap-3">
          <div class="flex-1">${field("host", "Host / IP", "192.168.1.10")}</div>
          <div class="w-24">${field("port", "Port", "", 'type="number" value="22" min="1" max="65535"')}</div>
        </div>
        ${field("user", "Username", "root")}
        ${field("key_path", "Private key path", "optional, e.g. C:\\Users\\me\\.ssh\\id_ed25519", "", false)}
        <div class="relative">
          ${field("secret", "Password / key passphrase", "saved in Windows Credential Manager", 'type="password" autocomplete="off"', false)}
          <button type="button" id="eye" class="absolute bottom-1.5 right-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Show</button>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" id="cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">Save</button>
        </div>
      </form>
    </dialog>
    <dialog id="run" class="fixed inset-0 m-auto h-fit w-[34rem] max-w-[92vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <form id="run-form" class="space-y-4 p-6">
        <div class="flex items-center gap-3">
          <div class="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/15 text-amber-400">${icon("rocket", "h-[18px] w-[18px]")}</div>
          <h2 id="run-title" class="font-semibold"></h2>
        </div>
        <label id="run-tag-wrap" class="block text-xs text-zinc-400">Version (tag)
          <select id="run-tag" class="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-amber-500"></select>
        </label>
        <div id="run-dirty" class="space-y-3"></div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" id="run-cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button id="run-go" class="flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">${icon("rocket")} Deploy</button>
        </div>
      </form>
    </dialog>
    <dialog id="confirm" class="fixed inset-0 m-auto h-fit w-96 rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <form method="dialog" class="space-y-3 p-6 [&>[data-inonly]+*]:!mt-1">
        <div class="flex items-center gap-3">
          <div id="confirm-icon" class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-400"></div>
          <h2 id="confirm-title" class="min-w-0 truncate font-semibold"></h2>
        </div>
        <p class="hidden text-[11px] font-medium uppercase tracking-wider text-zinc-500" data-inonly>Location</p>
        <p id="confirm-text" class="text-sm text-zinc-400"></p>
        <label for="confirm-input" class="hidden text-[11px] font-medium uppercase tracking-wider text-zinc-500" data-inonly>Name</label>
        <input id="confirm-input" spellcheck="false" autocomplete="off" class="hidden w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20" />
        <div class="flex justify-end gap-2 pt-2">
          <button value="" class="rounded-lg px-4 py-2 text-sm text-zinc-400 outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-amber-500/50">Cancel</button>
          <button value="ok" id="confirm-ok" class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black outline-none hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-amber-500 focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"></button>
        </div>
      </form>
    </dialog>
    <div id="settings" class="fixed inset-0 z-50 hidden flex-col bg-zinc-950 p-8 text-zinc-100">
      <div class="flex items-center gap-1">
        ${backBtn('id="set-close"', "Main display")}
        ${appTitle("settings", "Settings", "Preferences")}
      </div>
      <div class="mt-6 flex min-h-0 flex-1 gap-6">
      <nav class="w-56 shrink-0 space-y-1">
        <button aria-current="page" class="flex w-full items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-left text-sm font-medium text-zinc-100">${icon("image")} Personalize</button>
      </nav>
      <section class="min-w-0 flex-1">
      <h2 class="mb-4 text-xl font-semibold">Personalize</h2>
      <div id="set-preview" aria-hidden="true" class="relative mb-5 aspect-video w-full max-w-md overflow-hidden rounded-xl border-4 border-zinc-800 bg-zinc-950 bg-cover bg-center shadow-xl">
        <div class="absolute left-[12%] top-[12%] w-[60%] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-lg">
          <div class="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
            <span class="h-1.5 w-1.5 rounded-full bg-zinc-600"></span><span class="h-1.5 w-1.5 rounded-full bg-zinc-600"></span><span class="h-1.5 w-1.5 rounded-full bg-zinc-600"></span>
            <span class="ml-2 h-1.5 w-12 rounded bg-zinc-700"></span>
          </div>
          <div class="space-y-1.5 p-2.5">
            <div class="h-1.5 w-3/4 rounded bg-zinc-700"></div>
            <div class="h-1.5 w-1/2 rounded bg-zinc-800"></div>
            <div class="h-1.5 w-2/3 rounded bg-zinc-800"></div>
            <div class="flex justify-end gap-1.5 pt-1.5">
              <span class="h-3.5 w-9 rounded bg-zinc-800"></span>
              <span class="h-3.5 w-9 rounded bg-amber-500"></span>
            </div>
          </div>
        </div>
        <div class="absolute inset-x-0 bottom-0 flex h-[11%] items-center justify-center gap-1.5 bg-zinc-900/90">
          <span class="h-2.5 w-2.5 rounded bg-amber-500"></span><span class="h-2.5 w-2.5 rounded bg-zinc-600"></span><span class="h-2.5 w-2.5 rounded bg-zinc-600"></span>
        </div>
      </div>
      <div class="w-full max-w-2xl space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm">Theme</span>
          <div class="flex gap-1 rounded-lg border border-zinc-800 p-1 text-sm">
            <button data-theme-set="light" class="flex items-center gap-1.5 rounded-md px-3 py-1">${icon("sun")} Light</button>
            <button data-theme-set="dark" class="flex items-center gap-1.5 rounded-md px-3 py-1">${icon("moon")} Dark</button>
          </div>
        </div>
        <div>
          <span class="text-sm">Theme</span>
          <div id="set-themes" class="mt-2 grid grid-cols-5 gap-2"></div>
        </div>
        <div id="set-parts">
          <div class="flex items-center justify-between">
            <span class="text-sm">Custom colors <span id="set-parts-for" class="text-xs text-zinc-500"></span></span>
            <button id="set-parts-x" class="rounded-lg px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Reset</button>
          </div>
          <div class="mt-2 grid grid-cols-4 gap-2">
            ${PARTS.map(([k, l]) => `<label class="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-zinc-800 p-2 text-xs text-zinc-400 hover:bg-zinc-800">
              <input data-part="${k}" type="color" class="h-8 w-full cursor-pointer rounded border-0 bg-transparent p-0" />${l}</label>`).join("")}
          </div>
        </div>
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm">Main display background</span>
          <div class="flex gap-2 text-sm">
            <button id="set-wall" class="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 font-medium text-black hover:bg-amber-400">${icon("image")} Choose</button>
            <button id="set-wall-x" class="rounded-lg px-3 py-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Remove</button>
          </div>
        </div>
      </div>
      </section>
      </div>
    </div>
    <dialog id="theme-dlg" class="fixed inset-0 m-auto h-fit w-96 max-w-[92vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <form id="theme-form" class="space-y-3 p-6">
        <h2 id="theme-dlg-title" class="text-lg font-semibold">New theme</h2>
        <p id="theme-dlg-sub" class="text-sm text-zinc-400"></p>
        <input id="theme-name" required maxlength="24" placeholder="My theme" class="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500" />
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" id="theme-cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">Save</button>
        </div>
      </form>
    </dialog>
    <div id="bc" class="fixed inset-0 z-50 hidden flex-col bg-zinc-950 text-zinc-100">
      <header class="flex shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
        ${backBtn('id="bc-close"', "Main display")}
        ${appTitle("database", "BaseCurves", "SQLite · PostgreSQL · MySQL")}
        <div class="mx-3 h-10 w-px bg-zinc-800"></div>
        <nav class="flex items-stretch gap-1">
          ${[
            ["bc-v-main", "navHome", "Main", "Dashboard", "text-amber-400"],
            ["bc-new", "plug", "Connection", "New connection", "text-sky-400"],
            ["bc-newq", "code", "New Query", "New query tab", "text-amber-400"],
            ["bc-newb", "network", "New Builder", "New query builder tab", "text-emerald-400"],
            ["bc-v-objects", "table", "Table", "Tables of the current database", "text-emerald-400"],
            ["bc-v-query", "play", "Query", "SQL editor", "text-violet-400"],
            ["bc-refresh", "refresh", "Refresh", "Reload tables and data", "text-zinc-300"],
            ["bc-disconnect", "unplug", "Disconnect", "Close the current connection", "text-rose-400"],
          ].map(([id, ic, label, title, color]) => `<button id="${id}" title="${title}" class="group flex w-[4.5rem] flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-35 [&.on]:bg-zinc-800 [&.on]:text-zinc-100">
              <span class="${color} transition-transform group-hover:-translate-y-0.5">${icon(ic as keyof typeof ICONS, "h-6 w-6")}</span>${label}</button>`).join("")}
        </nav>
        <div id="bc-badge" class="ml-auto flex items-center gap-2 rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-500">${icon("unplug", "h-3.5 w-3.5")} Not connected</div>
      </header>
      <div class="flex min-h-0 flex-1">
        <aside class="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60">
          <div class="flex items-center gap-2 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            ${icon("plug", "h-3.5 w-3.5")} My Connections
            <button id="bc-new2" title="New connection" class="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-amber-400">${icon("plus", "h-3.5 w-3.5")}</button>
          </div>
          <div class="px-2 pb-2">
            <label class="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-500 focus-within:border-amber-500">${icon("search", "h-3.5 w-3.5")}
              <input id="bc-tree-q" placeholder="Filter tables…" class="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600" /></label>
          </div>
          <nav id="bc-tree" class="min-h-0 flex-1 overflow-auto px-1.5 pb-3 text-sm"></nav>
        </aside>
        <main class="flex min-w-0 flex-1 flex-col">
          <div id="bc-views" class="flex shrink-0 items-end gap-0.5 border-b border-zinc-800 bg-zinc-900/60 px-2 pt-1.5 text-sm">
            ${[["objects", "grid", "Objects"], ["data", "table", ""], ["query", "code", "Query"], ["builder", "network", "Builder"], ["er", "network", "ER Diagram"]].map(([v, ic, label]) =>
              `<button data-v="${v}" class="flex max-w-56 items-center gap-1.5 truncate rounded-t-lg border border-b-0 border-transparent px-3 py-1.5 text-zinc-400 hover:text-zinc-100 [&.on]:border-zinc-800 [&.on]:bg-zinc-950 [&.on]:text-zinc-100 ${v === "data" ? "hidden" : ""}">${icon(ic as keyof typeof ICONS, "h-3.5 w-3.5")}<span class="truncate">${label}</span>${v === "data" ? `<span data-close title="Close" class="-mr-1 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">${icon("x", "h-3 w-3")}</span>` : ""}</button>`).join("")}
          </div>

          <section data-view="main" class="hidden min-h-0 flex-1 flex-col overflow-auto">
            <div id="bc-main" class="flex flex-1 flex-col p-5"></div>
          </section>

          <section data-view="objects" class="flex min-h-0 flex-1 flex-col">
            <div class="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1 text-xs">
              ${tb("bc-o-open", "table", "Open Table")}${tb("bc-o-design", "list", "Design Table")}${tb("bc-o-new", "plus", "New Table")}${tb("bc-o-trunc", "x", "Empty Table")}${tb("bc-o-drop", "trash", "Delete Table")}${tb("bc-o-csv", "download", "Export Wizard")}
              <label class="ml-auto flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-zinc-500 focus-within:border-amber-500">${icon("search", "h-3.5 w-3.5")}
                <input id="bc-o-q" placeholder="Search" class="w-40 bg-transparent text-zinc-100 outline-none" /></label>
            </div>
            <div id="bc-objects" class="min-h-0 flex-1 overflow-auto"></div>
          </section>

          <section data-view="data" class="hidden min-h-0 flex-1 flex-col">
            <div class="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1 text-xs">
              <div id="bc-d-mode" class="mr-1 flex rounded-md border border-zinc-800 p-0.5">
                ${[["grid", "table", "Data"], ["struct", "list", "Structure"], ["er", "network", "ER Diagram"]].map(([m, ic, l]) =>
                  `<button data-m="${m}" class="flex items-center gap-1 rounded px-2 py-0.5 text-zinc-400 hover:text-zinc-100 [&.on]:bg-zinc-800 [&.on]:text-zinc-100 ${m === "grid" ? "on" : ""}">${icon(ic as keyof typeof ICONS, "h-3.5 w-3.5")}${l}</button>`).join("")}
              </div>
              <span data-mo="grid" class="flex items-center gap-1">${tb("bc-add", "plus", "Add Row")}${updBar("bc-d")}</span>
              <span data-mo="struct" class="hidden items-center gap-1">${tb("bc-s-addcol", "plus", "Add Column")}</span>
              ${tb("bc-d-refresh", "refresh", "Refresh")}${tb("bc-d-csv", "download", "Export")}
              <label data-mo="grid" title="SQL condition, e.g. status = 'open' AND id > 10 — Enter to apply, Esc to clear" class="ml-2 flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-zinc-500 focus-within:border-amber-500">${icon("filter", "h-3.5 w-3.5")}
                <span class="font-mono">WHERE</span><input id="bc-filter" placeholder="condition… (Enter)" class="min-w-0 flex-1 bg-transparent font-mono text-zinc-100 outline-none" /></label>
              <span data-mo="grid" class="ml-auto flex shrink-0 items-center gap-1">
                <button id="bc-prev" title="Previous page" class="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30">${icon("chevronLeft", "h-3.5 w-3.5")}</button>
                <span id="bc-page" class="min-w-24 text-center font-mono text-zinc-400"></span>
                <button id="bc-next" title="Next page" class="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30">${icon("chevronRight", "h-3.5 w-3.5")}</button>
              </span>
            </div>
            <div id="bc-grid" title="Edit cells, then press Update to save · click a header to sort · right-click a row for more" class="min-h-0 flex-1 overflow-auto"></div>
            <div id="bc-struct" class="hidden min-h-0 flex-1 overflow-auto"></div>
            <div id="bc-ter" title="" class="hidden min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle,rgb(113_113_122/0.18)_1px,transparent_1px)] [background-size:20px_20px]"></div>
          </section>

          <section data-view="er" class="hidden min-h-0 flex-1 flex-col">
            <div class="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1 text-xs">
              ${tb("bc-er-redraw", "refresh", "Re-layout")}
              <span class="ml-2 text-zinc-500">Drag a table by its title · double-click to open it · lines are foreign keys</span>
            </div>
            <div id="bc-er" class="min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle,rgb(113_113_122/0.18)_1px,transparent_1px)] [background-size:20px_20px]"></div>
          </section>

          <section data-view="query" class="hidden min-h-0 flex-1 flex-col">
            <div class="flex shrink-0 items-end gap-1 border-b border-zinc-800 px-2 pt-1 text-xs">
              <div id="bc-qtabs" class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"></div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs" title="Where this query runs">
              ${ctxBar("q")}
              <button id="bc-run" title="Run statement at cursor (Ctrl+Enter)" class="ml-1 flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-500">${icon("play", "h-3.5 w-3.5")} Run</button>
              <button id="bc-runall" title="Run the whole tab (Ctrl+Shift+Enter)" class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-zinc-300 hover:bg-zinc-800">${icon("playAll", "h-3.5 w-3.5")} Run all</button>
              <button id="bc-explain" title="Show the query plan of the statement at cursor" class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-zinc-300 hover:bg-zinc-800">${icon("network", "h-3.5 w-3.5")} Explain</button>
              <button id="bc-save" title="Save this tab to Main › Saved queries (Ctrl+S)" class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-zinc-300 hover:bg-zinc-800">${icon("file", "h-3.5 w-3.5")} Save</button>
            </div>
            <div id="bc-editor" class="h-64 shrink-0 overflow-hidden"></div>
            <div id="bc-split" data-split="bc-editor" title="Drag to resize" class="h-1.5 shrink-0 cursor-row-resize border-y border-zinc-800 bg-zinc-900 hover:bg-amber-500/40"></div>
            <div class="flex shrink-0 items-center border-b border-zinc-800 px-2 py-0.5 text-xs"><span class="text-zinc-500">Results</span><span id="bc-q-info" class="ml-3 font-mono text-zinc-500"></span><span class="ml-auto flex items-center gap-2">${updBar("bc-q")}${tb("bc-q-csv", "download", "Export results")}</span></div>
            <div id="bc-qgrid" class="min-h-0 flex-1 overflow-auto"><p class="py-10 text-center text-sm text-zinc-600">Ctrl+Enter runs the statement under the cursor · Ctrl+Space suggests tables and columns</p></div>
          </section>
          <section data-view="builder" class="hidden min-h-0 flex-1 flex-col">
            <div class="flex shrink-0 items-end gap-1 border-b border-zinc-800 px-2 pt-1 text-xs">
              <div id="bc-btabs" class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"></div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs" title="Where this builder runs">${ctxBar("b")}
              <button id="bc-qb-conn" class="hidden items-center gap-1.5 rounded-md border border-amber-500/60 bg-amber-500/10 px-2 py-1 text-amber-300 hover:bg-amber-500/20"></button></div>
            <div id="bc-qb" class="flex h-[28rem] shrink-0 overflow-hidden">
              <aside class="flex w-52 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
                <input id="bc-qb-q" placeholder="Filter tables" spellcheck="false" class="m-2 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs outline-none focus:border-amber-500" />
                <div id="bc-qb-list" title="Click or drag onto the canvas" class="min-h-0 flex-1 overflow-y-auto px-1 pb-2 text-[13px]"></div>
              </aside>
              <div class="flex min-w-0 flex-1 flex-col">
                <div id="bc-qb-wrap" class="relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle,rgb(63_63_70/.5)_1px,transparent_1px)] [background-size:18px_18px]"><div id="bc-qb-size" class="relative"><div id="bc-qb-cv" class="absolute left-0 top-0 origin-top-left"><svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible"></svg></div></div></div>
                <div class="flex shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-xs">
                  <label class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-0.5 focus-within:border-amber-500"><span class="font-mono text-zinc-500">WHERE</span><input id="bc-qb-where" spellcheck="false" placeholder="condition (optional)" class="min-w-0 flex-1 bg-transparent font-mono text-zinc-100 outline-none" /></label>
                  <label class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-0.5 focus-within:border-amber-500"><span class="font-mono text-zinc-500">LIMIT</span><input id="bc-qb-limit" type="number" min="0" value="100" class="w-16 bg-transparent font-mono text-zinc-100 outline-none" /></label>
                  <span title="Zoom (Ctrl + mouse wheel)" class="flex items-center rounded-md border border-zinc-800"><button id="bc-qb-zout" title="Zoom out" class="px-2 py-0.5 text-zinc-300 hover:bg-zinc-800">−</button><button id="bc-qb-z" title="Reset to 100%" class="w-12 py-0.5 text-center font-mono text-zinc-400 hover:bg-zinc-800">100%</button><button id="bc-qb-zin" title="Zoom in" class="px-2 py-0.5 text-zinc-300 hover:bg-zinc-800">+</button></span>
                  <button id="bc-qb-filter" title="Add a value box; drag its dot onto a column to filter by it (WHERE)" class="flex items-center gap-1.5 rounded-md px-2 py-1 text-violet-300 hover:bg-zinc-800">${icon("filter", "h-3.5 w-3.5")} Filter</button>
                  <button id="bc-qb-clear" class="rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Clear</button>
                  <button id="bc-qb-edit" title="Open the SQL in a new query tab" class="disabled:pointer-events-none disabled:opacity-40 flex items-center gap-1.5 rounded-md px-2 py-1 text-zinc-300 hover:bg-zinc-800">${icon("code", "h-3.5 w-3.5")} To editor</button>
                  <button id="bc-qb-run" class="disabled:pointer-events-none disabled:opacity-40 flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-500">${icon("play", "h-3.5 w-3.5")} Run</button>
                </div>
                <pre id="bc-qb-sql" class="max-h-24 shrink-0 overflow-auto border-t border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-400"></pre>
              </div>
            </div>
            <div data-split="bc-qb" title="Drag to resize" class="h-1.5 shrink-0 cursor-row-resize border-y border-zinc-800 bg-zinc-900 hover:bg-amber-500/40"></div>
            <div class="flex shrink-0 items-center border-b border-zinc-800 px-2 py-0.5 text-xs"><span class="text-zinc-500">Results</span><span id="bc-b-info" class="ml-3 font-mono text-zinc-500"></span><span class="ml-auto flex items-center gap-2">${updBar("bc-b")}${tb("bc-b-csv", "download", "Export results")}</span></div>
            <div id="bc-bgrid" class="min-h-0 flex-1 overflow-auto"><p class="py-10 text-center text-sm text-zinc-600">Link a table to Result, then Run</p></div>
          </section>
        </main>
      </div>
      <!-- full-width status bar; the global #path sits in its left end, so the message starts after it (--path-w) -->
      <footer class="flex h-9 shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-900 pr-3 font-mono text-[11px] text-zinc-500" style="padding-left:calc(var(--path-w, 0px) + 1.5rem)">
        <span class="h-3.5 w-px shrink-0 bg-zinc-800"></span>
        <span id="bc-spin" class="hidden">${spinner("h-3 w-3")}</span><span id="bc-msg" class="min-w-0 flex-1 truncate" title=""></span>
      </footer>
      <dialog id="bc-dlg" class="fixed inset-0 m-auto h-fit w-[36rem] max-w-[94vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
        <form id="bc-form" class="p-6">
          <h2 id="bc-dlg-title" class="text-lg font-semibold">New Connection</h2>
          <input type="hidden" name="id" />
          <input type="hidden" name="kind" />
          <div id="bc-kinds" class="mt-4 grid grid-cols-4 gap-2">
            ${(["postgres", "mysql", "mariadb", "sqlite"] as const).map((k) => `<button type="button" data-kind="${k}" class="rounded-xl border border-zinc-800 px-2 py-2.5 text-sm hover:bg-zinc-800 [&.on]:border-amber-500 [&.on]:bg-amber-500/10 [&.on]:text-amber-400">${KIND_LABEL[k]}</button>`).join("")}
          </div>
          <div id="bc-tabs" data-kinds="net" class="mt-4 flex gap-1 border-b border-zinc-800 text-sm">
            ${["General", "SSH"].map((t) => `<button type="button" data-tab="${t}" class="-mb-px border-b-2 border-transparent px-4 py-1.5 text-zinc-400 hover:text-zinc-100 [&.on]:border-amber-500 [&.on]:text-zinc-100">${t}</button>`).join("")}
          </div>
          <div data-pane="SSH" class="hidden">
            <div class="my-5 flex items-center justify-center gap-3 text-xs text-zinc-400">
              <span class="flex flex-col items-center gap-1">${logo("h-9 w-9")}Sun Curved</span>
              <span class="h-px w-14 bg-zinc-700"></span>
              <span class="flex flex-col items-center gap-1">${appArt("terminal", "h-9 w-9")}SSH Server</span>
              <span class="h-px w-14 bg-zinc-700"></span>
              <span class="flex flex-col items-center gap-1">${appArt("database", "h-9 w-9")}Database</span>
            </div>
            <div class="grid grid-cols-[9rem_1fr] items-center gap-x-4 gap-y-2.5 text-sm">
              <span></span>
              <label class="flex items-center gap-2 text-zinc-400"><input id="bc-ssh-on" type="checkbox" class="accent-amber-500" /> Use SSH Tunnel</label>
              <label for="bc-ssh" class="text-zinc-400">SSH Server:</label>
              <select id="bc-ssh" name="ssh" class="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-zinc-100 outline-none focus:border-amber-500 disabled:opacity-40"></select>
              <span></span>
              <p class="text-xs text-zinc-500">Uses the host, user, key and saved password of a server from the DevOps app (add one there with + New). Host/Port on the General tab are then as seen from that SSH server, e.g. <span class="font-mono">localhost</span>.</p>
            </div>
          </div>
          <div data-pane="General">
          <div class="my-5 flex items-center justify-center gap-4 text-xs text-zinc-400">
            <span class="flex flex-col items-center gap-1">${logo("h-9 w-9")}Sun Curved</span>
            <span class="h-px w-24 bg-zinc-700"></span>
            <span class="flex flex-col items-center gap-1">${appArt("database", "h-9 w-9")}Database</span>
          </div>
          <div class="grid grid-cols-[9rem_1fr] items-center gap-x-4 gap-y-2.5 text-sm">
            ${[
              ["name", "Connection Name", "", "all", ""],
              ["host", "Host", "localhost", "net", ""],
              ["port", "Port", "", "net", 'type="number" min="1" max="65535" class="!w-28"'],
              ["database", "Initial Database", "optional", "net", ""],
              ["user", "User Name", "", "net", ""],
              ["file", "Database File", "C:\path\data.db (relative = app data folder)", "sqlite", ""],
            ].map(([n, l, ph, kinds, attrs]) => `<label for="bc-f-${n}" data-kinds="${kinds}" class="text-zinc-400">${l}:</label>
              <input id="bc-f-${n}" name="${n}" data-kinds="${kinds}" placeholder="${esc(ph)}" ${n === "database" ? "" : "required"} spellcheck="false" ${attrs.replace(/class="[^"]*"/, "")}
                class="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500 ${/class="([^"]*)"/.exec(attrs)?.[1] ?? ""}" />`).join("")}
            <label for="bc-f-secret" data-kinds="net" class="text-zinc-400">Password:</label>
            <input id="bc-f-secret" name="secret" data-kinds="net" type="password" autocomplete="off" class="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-zinc-100 outline-none focus:border-amber-500" />
            <span data-kinds="net"></span>
            <label data-kinds="net" class="flex items-center gap-2 text-zinc-400"><input type="checkbox" name="savepw" checked class="accent-amber-500" /> Save password</label>
          </div>
          </div>
          <p id="bc-test-msg" class="mt-4 min-h-4 font-mono text-xs text-zinc-500"></p>
          <div class="mt-2 flex items-center gap-2">
            <button type="button" id="bc-test" class="mr-auto rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800">Test Connection</button>
            <button type="button" id="bc-cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
            <button class="rounded-lg bg-amber-500 px-5 py-2 text-sm font-medium text-black hover:bg-amber-400">OK</button>
          </div>
        </form>
      </dialog>
      <dialog id="bc-pw" class="fixed inset-0 m-auto h-fit w-80 rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
        <form method="dialog" class="space-y-3 p-6">
          <h2 id="bc-pw-title" class="font-semibold"></h2>
          <input id="bc-pw-in" type="password" autocomplete="off" placeholder="Password" class="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
          <div class="flex justify-end gap-2">
            <button value="" formnovalidate class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
            <button value="ok" class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">Connect</button>
          </div>
        </form>
      </dialog>
      <dialog id="bc-nt" class="fixed inset-0 m-auto h-fit w-[46rem] max-w-[94vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
        <form id="bc-nt-form" class="space-y-3 p-6 text-sm">
          <h2 class="text-lg font-semibold">New Table</h2>
          <input name="table" required placeholder="Table name" autocomplete="off" class="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono outline-none focus:border-amber-500" />
          <div class="grid grid-cols-[1fr_10rem_2.5rem_2.5rem_2.5rem_9rem_1.5rem] items-center gap-x-2 gap-y-1.5 text-xs">
            <span class="text-zinc-500">Column</span><span class="text-zinc-500">Type</span><span class="text-center text-zinc-500" title="Primary key">PK</span>
            <span class="text-center text-zinc-500" title="NOT NULL">NN</span><span class="text-center text-zinc-500" title="Auto increment">Auto</span><span class="text-zinc-500">Default</span><span></span>
            <div id="bc-nt-cols" class="contents"></div>
          </div>
          <button type="button" id="bc-nt-add" class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-amber-400 hover:bg-zinc-800">${icon("plus", "h-3.5 w-3.5")} Add column</button>
          <datalist id="bc-types"></datalist>
          <pre id="bc-nt-sql" class="max-h-40 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-400"></pre>
          <p id="bc-nt-msg" class="min-h-4 font-mono text-xs text-red-400"></p>
          <div class="flex justify-end gap-2">
            <button type="button" id="bc-nt-cancel" class="rounded-lg px-4 py-2 text-zinc-400 hover:bg-zinc-800">Cancel</button>
            <button type="button" id="bc-nt-query" class="rounded-lg px-4 py-2 text-zinc-300 hover:bg-zinc-800">Open in Query</button>
            <button class="rounded-lg bg-amber-500 px-4 py-2 font-medium text-black hover:bg-amber-400">Create</button>
          </div>
        </form>
      </dialog>
    </div>
    <div id="cal" class="fixed inset-0 z-50 hidden flex-col bg-zinc-950 p-8 text-zinc-100">
      <div class="flex items-center gap-1">
        ${backBtn('id="cal-close"', "Main display")}
        ${appTitle("calendar", "Calendar", "Notes by day")}
        <h2 id="cal-title" class="ml-8 mr-auto text-2xl font-semibold"></h2>
        <button id="cal-prev" class="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("chevronLeft", "h-5 w-5")}</button>
        <button id="cal-today" class="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Today</button>
        <button id="cal-next" class="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("chevronRight", "h-5 w-5")}</button>
      </div>
      <div class="mt-6 grid min-h-0 flex-1 grid-cols-[3fr_2fr] gap-6">
        <div id="cal-grid" class="grid grid-cols-7 gap-2 [grid-template-rows:auto_repeat(6,1fr)] text-lg"></div>
        <aside class="flex min-h-0 flex-col rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
          <p id="cal-dow" class="text-sm text-zinc-400"></p>
          <h3 id="cal-day" class="text-2xl font-semibold"></h3>
          <ul id="cal-list" class="mt-4 min-h-0 flex-1 space-y-1 overflow-auto border-t border-zinc-800 pt-4"></ul>
          <button id="cal-add" title="Add item" aria-label="Add item" class="mt-4 ml-auto grid h-11 w-11 place-items-center rounded-full bg-amber-500 text-2xl font-bold text-black shadow-lg hover:bg-amber-400">+</button>
        </aside>
      </div>
      <dialog id="cal-dlg" class="fixed inset-0 m-auto h-[85vh] w-[85vw] max-h-none max-w-none rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
        <form id="cal-form" class="flex h-full flex-col gap-3 p-6">
          <div class="flex items-end gap-4">
            <div class="mr-auto">
              <h2 id="cal-dlg-title" class="text-lg font-semibold">New item</h2>
              <p id="cal-dlg-day" class="text-sm text-zinc-400"></p>
            </div>
            <label class="text-xs text-zinc-400">Time (optional)
              <input name="t" type="time" class="mt-1 block rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500" />
            </label>
          </div>
          <div id="cal-editor" class="min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 px-3 focus-within:border-amber-500"></div>
          <div class="flex items-center justify-end gap-2 pt-1">
            <span class="mr-auto text-xs text-zinc-500">Markdown · Ctrl+Enter to save</span>
            <button type="button" id="cal-cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Cancel</button>
            <button class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-400">Save</button>
          </div>
        </form>
      </dialog>
    </div>
    <div id="post" class="fixed inset-0 z-50 hidden flex-col bg-zinc-950 p-8 text-zinc-100">
      <div class="flex items-center gap-1">
        ${backBtn('id="post-close"', "Main display")}
        ${appTitle("post", "Sun Post", "HTTP requests")}
      </div>
      <div class="mt-6 grid min-h-0 flex-1 grid-cols-[14rem_1fr] gap-6">
        <aside class="flex min-h-0 flex-col rounded-2xl border border-zinc-800 bg-zinc-900 p-3">
          <div class="flex items-center justify-between px-2 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">History
            <button id="post-clear" class="rounded-md px-2 py-0.5 normal-case tracking-normal text-zinc-400 hover:bg-zinc-800">Clear</button></div>
          <ul id="post-hist" class="min-h-0 flex-1 space-y-0.5 overflow-auto"></ul>
        </aside>
        <form id="post-form" class="flex min-h-0 flex-col gap-3">
          <div class="flex gap-2">
            <select name="m" class="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm font-semibold text-amber-400 outline-none focus:border-amber-500">${["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => `<option>${m}</option>`).join("")}</select>
            <input name="u" required placeholder="https://api.example.com/users" class="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500" />
            <button id="post-send" class="rounded-lg bg-amber-500 px-5 py-2 text-sm font-semibold text-black hover:bg-amber-400 disabled:opacity-40">Send</button>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-xs text-zinc-400">Headers <span class="text-zinc-600">(Key: Value per line)</span>
              <textarea name="h" rows="5" spellcheck="false" placeholder="Content-Type: application/json&#10;Authorization: Bearer ..." class="mt-1 block w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500"></textarea></label>
            <label class="text-xs text-zinc-400">Body
              <textarea name="b" rows="5" spellcheck="false" placeholder='{"name": "sun"}' class="mt-1 block w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500"></textarea></label>
          </div>
          <div class="flex min-h-0 flex-1 flex-col rounded-2xl border border-zinc-800 bg-zinc-900">
            <div class="flex items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
              <span class="font-semibold">Response</span><span id="post-meta" class="font-mono text-xs text-zinc-400"></span>
              <button type="button" id="post-tab" class="ml-auto rounded-md px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800">Headers</button>
            </div>
            <pre id="post-out" class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-sm"></pre>
          </div>
        </form>
      </div>
    </div>
    <div id="notepad" class="fixed inset-0 z-50 hidden flex-col bg-zinc-950 p-8 text-zinc-100">
      <div class="flex items-center gap-1">
        ${backBtn('id="np-close"', "Main display")}
        ${appTitle("notepad", "Notepad", "Plain text, saved automatically")}
        <!-- the open note's name, big, next to the app title; details underneath -->
        <div id="np-info" class="ml-10 min-w-0">
          <p id="np-title" class="truncate text-2xl font-semibold leading-tight"></p>
          <p id="np-meta" class="truncate font-mono text-xs text-zinc-500"></p>
        </div>
        <span class="flex-1"></span>
        <!-- one tools button; zoom, images as picture / code and font live in its dropdown -->
        <span id="np-tools" class="relative ml-3 hidden">
          <button id="np-tools-btn" title="View options" class="grid h-9 w-9 place-items-center rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 aria-expanded:border-amber-500 aria-expanded:text-amber-400" aria-expanded="false">${lucide("settings2", "h-[18px] w-[18px]")}</button>
          <div id="np-tools-menu" class="absolute right-0 top-11 z-[60] hidden w-64 space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm text-zinc-300 shadow-2xl shadow-black/40">
            <div class="flex items-center justify-between">
              <span class="text-xs text-zinc-500">Zoom</span>
              <span class="flex h-8 items-center rounded-lg border border-zinc-700">
                <button id="np-zout" title="Zoom out (Ctrl + wheel)" class="h-full rounded-l-lg px-2.5 hover:bg-zinc-800">−</button>
                <button id="np-zoom" title="Reset zoom" class="h-full w-14 font-mono text-xs hover:bg-zinc-800">100%</button>
                <button id="np-zin" title="Zoom in (Ctrl + wheel)" class="h-full rounded-r-lg px-2.5 hover:bg-zinc-800">+</button>
              </span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-zinc-500">Images</span>
              <span id="np-imgmode" class="flex items-center gap-0.5 rounded-lg border border-zinc-700 p-0.5">
                <button data-img="pic" title="Images as pictures" class="grid h-7 w-9 place-items-center rounded-md">${icon("image")}</button>
                <button data-img="src" title="Images as Markdown code" class="grid h-7 w-9 place-items-center rounded-md">${icon("code")}</button>
              </span>
            </div>
            <div id="np-paperset" class="space-y-3">
              <div>
                <span class="text-xs text-zinc-500">Paper</span>
                <div class="mt-1.5 grid grid-cols-4 gap-1.5">
                  ${NP_PAPERS.map(([v, l]) => `<button data-paper="${v}" title="${l}" class="np-paperopt grid place-items-center rounded-lg p-1.5 hover:bg-zinc-800"><span class="np-swatch" data-paper="${v}"></span></button>`).join("")}
                </div>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-xs text-zinc-500">Orientation</span>
                <span class="flex items-center gap-0.5 rounded-lg border border-zinc-700 p-0.5">
                  ${NP_ORIENTS.map(([v, l]) => `<button data-orient="${v}" title="${l}" class="np-paperopt grid h-7 w-9 place-items-center rounded-md"><span class="${v === "portrait" ? "h-4 w-3" : "h-3 w-4"} rounded-[2px] border-[1.5px] border-current"></span></button>`).join("")}
                </span>
              </div>
            </div>
            <div>
              <span class="text-xs text-zinc-500">Font</span>
              <div id="np-font" class="mt-1.5 space-y-0.5">
                ${NP_FONTS.map(([id, l, f]) => `<button data-font="${id}" style='font-family: ${f}' class="np-fontopt flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left hover:bg-zinc-800">${l}<span class="np-fontchk text-amber-400">${icon("check")}</span></button>`).join("")}
              </div>
            </div>
            <button id="np-pdf" class="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 font-medium text-black hover:bg-amber-400">${lucide("file-down", "h-4 w-4")} Export PDF</button>
          </div>
        </span>
        <button id="np-newdir" title="New folder" class="ml-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">${icon("folder")} Folder</button>
        <button id="np-new" title="New note" class="ml-3 flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-amber-400">${icon("plus")} New</button>
      </div>
      <div class="mt-6 flex min-h-0 flex-1 gap-6">
        <aside id="np-side" class="w-[15%] min-w-40 shrink-0 overflow-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-3"></aside>
        <div class="flex min-w-0 flex-1 flex-col">
      <div id="np-list" class="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,7.5rem)] content-start gap-2 overflow-auto p-1"></div>
      <div id="np-peek" class="np-peek pointer-events-none fixed z-[70] hidden w-[30rem]"></div>
      <div id="np-desk" class="hidden min-h-0 flex-1 overflow-auto px-4 py-6">
        <div id="np-text" class="np-paper" spellcheck="false"></div>
      </div>
      <dialog id="np-newdlg" class="fixed inset-0 m-auto h-fit w-[32rem] max-w-[94vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
        <form method="dialog" class="space-y-3 p-6">
          <div class="flex items-center gap-3">
            <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-400">${icon("file", "h-[18px] w-[18px]")}</div>
            <h2 class="font-semibold">New note</h2>
          </div>
          <p class="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Paper</p>
          <div class="grid grid-cols-4 gap-2">${NP_PAPERS.map(([v, l]) => `
            <label class="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-zinc-800 p-2 text-xs has-[:checked]:border-amber-500 has-[:checked]:bg-amber-500/10">
              <input type="radio" name="paper" value="${v}" class="sr-only" />
              <span class="grid h-24 place-items-center"><span class="np-paper np-mini" data-paper="${v}"></span></span>${l}</label>`).join("")}
          </div>
          <p class="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Orientation</p>
          <div class="grid grid-cols-2 gap-2">${NP_ORIENTS.map(([v, l]) => `
            <label class="flex cursor-pointer items-center justify-center gap-2.5 rounded-xl border border-zinc-800 p-2.5 text-sm has-[:checked]:border-amber-500 has-[:checked]:bg-amber-500/10">
              <input type="radio" name="orient" value="${v}" class="sr-only" />
              <span class="${v === "portrait" ? "h-6 w-[17px]" : "h-[17px] w-6"} rounded-[3px] border-2 border-current"></span>${l}</label>`).join("")}
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button value="" class="rounded-lg px-4 py-2 text-sm text-zinc-400 outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-amber-500/50">Cancel</button>
            <button value="ok" class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black outline-none hover:bg-amber-400 focus-visible:ring-2 focus-visible:ring-amber-500/50">Create</button>
          </div>
        </form>
      </dialog>
        </div>
      </div>
    </div>
    <dialog id="manual"class="fixed inset-0 m-auto h-[90vh] w-[60rem] max-w-[94vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <div class="flex h-full flex-col">
        <div class="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <span class="text-amber-400">${icon("book")}</span>
          <h2 class="font-semibold">Deploy YAML manual</h2>
          <button id="manual-close" class="ml-auto rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("x")}</button>
        </div>
        <article id="manual-body" class="manual min-h-0 flex-1 overflow-auto px-8 py-6"></article>
      </div>
    </dialog>
    <dialog id="picker" class="fixed inset-0 m-auto h-[70vh] w-[36rem] max-w-[92vw] rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <div class="flex h-full flex-col">
        <div class="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <span class="text-amber-400">${icon("folder")}</span>
          <h2 id="pick-title" class="font-semibold"></h2>
        </div>
        <form id="pick-bar" class="flex items-center gap-1 border-b border-zinc-800 px-4 py-2">
          <button type="button" id="pick-up" title="Up one folder" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("arrowUp")}</button>
          <input id="pick-path" spellcheck="false" class="ml-1 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-sm outline-none focus:border-amber-500" />
        </form>
        <div id="pick-list" class="min-h-0 flex-1 overflow-auto p-2"></div>
        <div class="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button type="button" id="pick-cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button type="button" id="pick-ok" class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">Choose this folder</button>
        </div>
      </div>
    </dialog>
    <div id="ctx" class="fixed z-[80] hidden min-w-48 rounded-xl border border-zinc-700 bg-zinc-900/95 p-1 text-sm text-zinc-100 shadow-2xl shadow-black/50 backdrop-blur"></div>
    <dialog id="auth" class="fixed inset-0 m-auto h-fit w-96 rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70">
      <form id="auth-form" class="space-y-3 p-6">
        <div class="mb-1 flex items-center gap-3">
          <div class="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/15 text-amber-400">${icon("lock", "h-[18px] w-[18px]")}</div>
          <div class="min-w-0">
            <h2 id="auth-title" class="truncate font-semibold"></h2>
            <p id="auth-sub" class="truncate font-mono text-xs text-zinc-500"></p>
          </div>
        </div>
        <div id="auth-fields" class="space-y-3"></div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" id="auth-cancel" class="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">Continue</button>
        </div>
      </form>
    </dialog>`;

  const dlg = $<HTMLDialogElement>("#dlg");
  const form = $<HTMLFormElement>("#f");
  $("#add").onclick = () => openForm();
  $("#cancel").onclick = () => dlg.close();
  $("#eye").onclick = () => {
    const pw = form.elements.namedItem("secret") as HTMLInputElement;
    pw.type = pw.type === "password" ? "text" : "password";
    $("#eye").textContent = pw.type === "password" ? "Show" : "Hide";
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    await saveConn(form);
    dlg.close();
    await refreshList();
    // Open tabs pick up the new name now; new host/user/etc. apply on reconnect.
    tabs.forEach((t) => (t.conn = conns.find((c) => c.id === t.conn.id) ?? t.conn));
    renderTabs();
  };
  $("#q").oninput = renderList;
  $("#manual-open").onclick = openManual;
  $("#manual-close").onclick = () => $<HTMLDialogElement>("#manual").close();
  $("#theme").onclick = () => setTheme(!isLight(), true);
  // Main display: a launcher over everything; the existing workspace is its DevOps app.
  $("#home").onclick = () => ($("#launcher").classList.replace("hidden", "flex"), swMark());
  $("[data-devops]").onclick = () => $("#launcher").classList.replace("flex", "hidden");
  const mainWall = wallpaper($("#launcher"), 0);
  setTheme(isLight());

  // Settings app.
  const setDlg = $("#settings");
  const markTheme = () => {
    setDlg.querySelectorAll<HTMLElement>("[data-theme-set]").forEach((b) => {
      const on = (b.dataset.themeSet === "light") === isLight();
      b.classList.toggle("bg-amber-500", on);
      b.classList.toggle("text-black", on);
    });
    setDlg.querySelectorAll<HTMLElement>("[data-theme-name]").forEach((b) => b.classList.toggle("ring-2", b.dataset.themeName === themeName()));
    const p = parts(), z = baseZinc();
    const shown = { accent: accent(), bg: p.bg ?? z[0], panel: p.panel ?? z[1], text: p.text ?? z[9] };
    setDlg.querySelectorAll<HTMLInputElement>("[data-part]").forEach((i) => (i.value = shown[i.dataset.part as keyof typeof shown]));
    $("#set-preview").style.backgroundImage = $("#launcher").style.backgroundImage;
    const mode = isLight() ? "Light" : "Dark";
    $("#set-parts-for").textContent = themeName() in THEMES ? `(${mode} mode)` : `editing "${themeName()}" · ${mode} mode, saved automatically`;
  };
  const retheme = () => (setTheme(isLight()), markTheme());
  const pickTheme = (n: string) => {
    localStorage.themeName = n;
    const t = allThemes()[n];
    for (const m of ["light", "dark"] as const) {
      if (t?.parts?.[m]) localStorage[`themeParts:${m}`] = JSON.stringify(t.parts[m]);
      else localStorage.removeItem(`themeParts:${m}`);
    }
    retheme();
  };
  const drawThemes = () => {
    const box = $("#set-themes"), m = isLight() ? "light" : "dark";
    box.innerHTML = Object.entries(allThemes()).map(([n, t]) => {
      const p = t.parts?.[m] ?? {};
      const bg = p.panel ?? (t.tint ? `color-mix(in oklab, ${t.tint} 18%, #18181b)` : "#18181b");
      return `<button data-theme-name="${esc(n)}" class="flex min-w-0 flex-col items-center gap-1.5 rounded-xl border border-zinc-800 p-2 text-xs ring-amber-500 hover:bg-zinc-800">
        <span class="relative h-10 w-full rounded-md border border-zinc-700" style="background:${bg}">
          <span class="absolute bottom-1 right-1 h-3 w-3 rounded-full" style="background:${p.accent ?? t.accent}"></span>
        </span><span class="w-full truncate text-center">${esc(n)}</span></button>`;
    }).join("") + `<button id="set-theme-new" class="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-zinc-700 p-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
        <span class="grid h-10 w-full place-items-center">${icon("plus", "h-5 w-5")}</span>New theme</button>`;
    box.querySelectorAll<HTMLElement>("[data-theme-name]").forEach((b) => {
      const n = b.dataset.themeName!;
      b.onclick = () => pickTheme(n);
      if (!(n in THEMES)) b.oncontextmenu = (e) => contextMenu(e, [["Edit colors", "pencil", () => {
        pickTheme(n);
        $("#set-parts").scrollIntoView({ behavior: "smooth" });
      }], ["Rename", "pencil", () => openThemeDlg(n)], ["Delete theme", "trash", async () => {
        if (!(await confirmBox(`Delete "${n}"?`, "This saved theme will be removed.", "Delete"))) return;
        const u = userThemes();
        delete u[n];
        localStorage.userThemes = JSON.stringify(u);
        if (themeName() === n || !(themeName() in allThemes())) pickTheme("Classic");
        drawThemes();
      }]]);
    });
    $("#set-theme-new").onclick = () => openThemeDlg();
    markTheme();
  };
  let renaming: string | undefined;
  const openThemeDlg = (old?: string) => {
    renaming = old;
    $<HTMLFormElement>("#theme-form").reset();
    $("#theme-dlg-title").textContent = old ? "Rename theme" : "New theme";
    $("#theme-dlg-sub").textContent = old ? `Current name: ${old}` : "Saves the current colors (Light and Dark) as a theme.";
    $<HTMLInputElement>("#theme-name").value = old ?? "";
    $<HTMLDialogElement>("#theme-dlg").showModal();
  };
  $("#theme-cancel").onclick = () => $<HTMLDialogElement>("#theme-dlg").close();
  $<HTMLFormElement>("#theme-form").onsubmit = (e) => {
    e.preventDefault();
    const inp = $<HTMLInputElement>("#theme-name");
    const n = inp.value.trim();
    if (n in THEMES) return inp.setCustomValidity("That name is a built-in theme"), inp.reportValidity();
    if (renaming) {
      const u = userThemes();
      if (n !== renaming && n in u) return inp.setCustomValidity("A theme with that name exists"), inp.reportValidity();
      // Rebuild to keep the card in the same spot.
      localStorage.userThemes = JSON.stringify(Object.fromEntries(Object.entries(u).map(([k, v]) => [k === renaming ? n : k, v])));
      if (themeName() === renaming || localStorage.themeName === renaming) localStorage.themeName = n;
      $<HTMLDialogElement>("#theme-dlg").close();
      return drawThemes();
    }
    const read = (m: string) => { try { return JSON.parse(localStorage[`themeParts:${m}`] ?? "{}"); } catch { return {}; } };
    const base = curTheme();
    // Snapshot what's on screen: current base theme + custom colors for both modes.
    localStorage.userThemes = JSON.stringify({ ...userThemes(), [n]: { accent: accent(), tint: base.tint, parts: { light: read("light"), dark: read("dark") } } });
    $<HTMLDialogElement>("#theme-dlg").close();
    pickTheme(n);
    drawThemes();
  };
  $("#theme-name").oninput = () => $<HTMLInputElement>("#theme-name").setCustomValidity("");
  /** A selected user theme is edited live: custom colors are written back into it. */
  const saveUser = () => {
    const n = themeName();
    if (n in THEMES) return retheme();
    const u = userThemes(), read = (m: string) => { try { return JSON.parse(localStorage[`themeParts:${m}`] ?? "{}"); } catch { return {}; } };
    u[n] = { ...u[n], parts: { light: read("light"), dark: read("dark") } };
    localStorage.userThemes = JSON.stringify(u);
    setTheme(isLight());
    drawThemes();
  };
  setDlg.querySelectorAll<HTMLInputElement>("[data-part]").forEach((i) => (i.oninput = () => {
    localStorage[partsKey()] = JSON.stringify({ ...parts(), [i.dataset.part!]: i.value });
    saveUser();
  }));
  $("#set-parts-x").onclick = () => (localStorage.removeItem(partsKey()), saveUser());
  setDlg.querySelectorAll<HTMLElement>("[data-theme-set]").forEach((b) =>
    (b.onclick = () => (setTheme(b.dataset.themeSet === "light", true), drawThemes())));
  $("[data-settings]").onclick = () => (drawThemes(), setDlg.classList.replace("hidden", "flex"));
  $("#set-close").onclick = () => setDlg.classList.replace("flex", "hidden");
  $("#set-wall").onclick = async () => (await mainWall.pick(), markTheme());
  $("#set-wall-x").onclick = async () => {
    if (!(await confirmBox("Remove background?", "The main display wallpaper will be removed.", "Remove"))) return;
    await mainWall.remove();
    markTheme();
  };

  // Sun Post: Postman-style HTTP client. Requests go through tauri-plugin-http (Rust), so no CORS.
  type PostReq = { m: string; u: string; h: string; b: string };
  const postPage = $("#post"), postForm = $<HTMLFormElement>("#post-form");
  let postHist: PostReq[] = [];
  try { postHist = JSON.parse(localStorage.postHist ?? "[]"); } catch {} // corrupt → start empty
  let postRes = { body: "", heads: "" }, postShowHeads = false;
  const postField = (n: string) => postForm.elements.namedItem(n) as HTMLInputElement;
  postForm.addEventListener("input", showWhere); // path shows the method + URL being edited
  postForm.addEventListener("change", showWhere);
  const drawPostOut = () => {
    $("#post-out").textContent = postShowHeads ? postRes.heads : postRes.body;
    $("#post-tab").textContent = postShowHeads ? "Body" : "Headers";
  };
  const drawHist = () => {
    $("#post-hist").innerHTML = postHist.map((r, i) => `<li data-h="${i}" title="${esc(r.u)}" class="flex cursor-pointer gap-2 rounded-lg px-2 py-1.5 font-mono text-xs hover:bg-zinc-800">
      <span class="w-12 shrink-0 font-semibold text-amber-400">${esc(r.m)}</span><span class="truncate text-zinc-300">${esc(r.u.replace(/^https?:\/\//, ""))}</span></li>`).join("")
      || `<li class="py-6 text-center text-sm text-zinc-600">No requests yet</li>`;
  };
  $("[data-post]").onclick = () => (drawHist(), postPage.classList.replace("hidden", "flex"), postField("u").focus());
  $("#post-close").onclick = () => postPage.classList.replace("flex", "hidden");
  $("#post-tab").onclick = () => ((postShowHeads = !postShowHeads), drawPostOut());
  $("#post-clear").onclick = () => ((postHist = []), (localStorage.postHist = "[]"), drawHist());
  $("#post-hist").onclick = (e) => {
    const r = postHist[+((e.target as HTMLElement).closest<HTMLElement>("[data-h]")?.dataset.h ?? -1)];
    if (r) (["m", "u", "h", "b"] as const).forEach((k) => (postField(k).value = r[k])), showWhere();
  };
  postForm.onsubmit = async (e) => {
    e.preventDefault();
    const r: PostReq = { m: postField("m").value, u: withScheme(postField("u").value), h: postField("h").value, b: postField("b").value };
    postField("u").value = r.u;
    postHist = [r, ...postHist.filter((x) => JSON.stringify(x) !== JSON.stringify(r))].slice(0, 50);
    localStorage.postHist = JSON.stringify(postHist);
    drawHist();
    const send = $<HTMLButtonElement>("#post-send"), meta = $("#post-meta"), t0 = performance.now();
    send.disabled = true;
    meta.textContent = "Sending…";
    try {
      const res = await httpFetch(r.u, { method: r.m, headers: parseHeaders(r.h), body: ["GET", "HEAD"].includes(r.m) || !r.b ? undefined : r.b });
      const text = await res.text();
      meta.innerHTML = `<span class="${res.ok ? "text-emerald-400" : "text-red-400"}">${res.status} ${esc(res.statusText)}</span> · ${Math.round(performance.now() - t0)} ms · ${fmtSize(new Blob([text]).size)}`;
      postRes = { body: pretty(text), heads: [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n") };
    } catch (err) {
      meta.innerHTML = `<span class="text-red-400">Error</span>`;
      postRes = { body: String(err), heads: "" };
    }
    send.disabled = false;
    postShowHeads = false;
    drawPostOut();
  };

  // Calendar app: month grid (Sunday first) | selected day's items, kept in localStorage by YYYY-MM-DD.
  const calPage = $("#cal");
  let calM = new Date(), calSel = new Date();
  type CalItem = { t: string; x: string };
  let calNotes: Record<string, CalItem[]> = {};
  try { calNotes = JSON.parse(localStorage.calNotes ?? "{}"); } catch {} // corrupt → start empty
  const calKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const drawDay = () => {
    const items = calNotes[calKey(calSel)] ?? [];
    $("#cal-dow").textContent = calSel.toLocaleString(undefined, { weekday: "long" });
    $("#cal-day").textContent = calSel.toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric" });
    $("#cal-list").innerHTML = items.length
      ? items.map((it, i) => `<li data-edit="${i}" title="Click to edit" class="group flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-zinc-800">
          <span class="w-12 shrink-0 pt-0.5 font-mono text-sm text-amber-400">${esc(it.t)}</span>
          <div class="manual cal-md min-w-0 flex-1 break-words">${calMd(it.x)}</div>
          <button data-del="${i}" title="Delete" class="rounded p-1 text-zinc-500 opacity-0 hover:text-red-400 group-hover:opacity-100">${icon("x", "h-4 w-4")}</button>
        </li>`).join("")
      : `<li class="py-6 text-center text-sm text-zinc-600">No items</li>`;
    $("#cal-list").querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((c) => (c.disabled = false)); // marked renders task boxes disabled
  };
  const saveDay = (items: CalItem[]) => {
    const k = calKey(calSel);
    if (items.length) calNotes[k] = items.sort((a, b) => a.t.localeCompare(b.t)); // untimed ("") first
    else delete calNotes[k];
    localStorage.calNotes = JSON.stringify(calNotes);
    drawCal();
  };
  const drawCal = () => {
    const y = calM.getFullYear(), m = calM.getMonth(), now = new Date();
    $("#cal-title").textContent = calM.toLocaleString(undefined, { month: "long", year: "numeric" });
    const lead = new Date(y, m, 1).getDay();
    const wk = (i: number) => (i % 7 === 0 || i % 7 === 6 ? "text-rose-400" : "text-zinc-400");
    $("#cal-grid").innerHTML =
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => `<span class="pb-1 text-center text-sm font-semibold ${wk(i)}">${d}</span>`).join("") +
      // 6 full weeks; Date() rolls day 0 / day 32 over into the neighbouring months.
      Array.from({ length: 42 }, (_, i) => {
        const d = new Date(y, m, i - lead + 1), out = d.getMonth() !== m;
        const today = d.toDateString() === now.toDateString(), sel = d.toDateString() === calSel.toDateString();
        const num = today
          ? `<span class="grid h-9 w-9 place-items-center rounded-full bg-amber-500 font-bold text-black">${d.getDate()}</span>`
          : `<span class="grid h-9 w-9 place-items-center font-semibold ${out ? "" : i % 7 === 0 || i % 7 === 6 ? "text-rose-400" : "text-zinc-100"}">${d.getDate()}</span>`;
        const dot = calNotes[calKey(d)] ? `<span class="ml-3 block h-2 w-2 rounded-full bg-amber-400"></span>` : "";
        return `<button data-day="${i - lead + 1}" class="rounded-xl border p-2 text-left align-top hover:border-zinc-500 ${sel ? "border-amber-500 bg-zinc-800" : today ? "border-amber-500/50 bg-zinc-900" : "border-zinc-700 bg-zinc-900"} ${out ? "text-zinc-600 opacity-50" : ""}">${num}${dot}</button>`;
      }).join("");
    drawDay();
  };
  const calPick = (d: Date) => ((calSel = d), (calM = new Date(d.getFullYear(), d.getMonth(), 1)), drawCal(), showWhere());
  $("[data-calendar]").onclick = () => (calPick(new Date()), calPage.classList.replace("hidden", "flex"));
  $("#cal-prev").onclick = () => ((calM = new Date(calM.getFullYear(), calM.getMonth() - 1, 1)), drawCal());
  $("#cal-next").onclick = () => ((calM = new Date(calM.getFullYear(), calM.getMonth() + 1, 1)), drawCal());
  $("#cal-today").onclick = () => calPick(new Date());
  $("#cal-grid").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-day]");
    if (b) calPick(new Date(calM.getFullYear(), calM.getMonth(), +b.dataset.day!));
  };
  // One dialog for add (calEdit = -1) and edit; the editor renders Markdown in place as you type.
  const calForm = $<HTMLFormElement>("#cal-form");
  const calT = calForm.elements.namedItem("t") as HTMLInputElement;
  const calX = createMdEditor($("#cal-editor"), { placeholder: "## Deploy prod v2   - [ ] backup db   **bold**   `code`", onSubmit: () => calForm.requestSubmit() });
  let calEdit = -1;
  const calOpen = (i: number) => {
    const it = (calNotes[calKey(calSel)] ?? [])[i];
    calEdit = it ? i : -1;
    calT.value = it?.t ?? "";
    calX.set(it?.x ?? "");
    $("#cal-dlg-title").textContent = it ? "Edit item" : "New item";
    $("#cal-dlg-day").textContent = calSel.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    $<HTMLDialogElement>("#cal-dlg").showModal();
    calX.focus();
  };
  $("#cal-list").onclick = (e) => {
    const t = e.target as HTMLElement, del = t.closest<HTMLElement>("[data-del]"), row = t.closest<HTMLElement>("[data-edit]");
    if (del) saveDay((calNotes[calKey(calSel)] ?? []).filter((_, i) => i !== +del.dataset.del!));
    else if (row && t instanceof HTMLInputElement && t.type === "checkbox") {
      const items = [...(calNotes[calKey(calSel)] ?? [])], i = +row.dataset.edit!;
      items[i] = { ...items[i], x: toggleTask(items[i].x, [...row.querySelectorAll("input[type=checkbox]")].indexOf(t)) };
      saveDay(items);
    } else if (row && !t.closest("a, input")) calOpen(+row.dataset.edit!); // links and checkboxes keep their own click
  };
  calForm.onsubmit = (e) => {
    e.preventDefault();
    const x = calX.get().trim();
    if (!x) return calX.focus();
    const items = [...(calNotes[calKey(calSel)] ?? [])], it = { t: calT.value, x };
    if (calEdit >= 0) items[calEdit] = it;
    else items.push(it);
    saveDay(items);
    $<HTMLDialogElement>("#cal-dlg").close();
  };
  $("#cal-add").onclick = () => calOpen(-1);
  $("#cal-cancel").onclick = () => $<HTMLDialogElement>("#cal-dlg").close();
  $("#cal-close").onclick = () => calPage.classList.replace("flex", "hidden");

  // ----- Notepad: a list of plain-text notes (newest edit first); open one to edit, saved on every keystroke -----
  type Note = { id: number; name: string; text: string; t: number; folder?: string };
  // Files live in %APPDATA%\Sun Curved\notepad\[<folder>\]<name>.md (see np_* in lib.rs); id = file creation time.
  // ponytail: one level of folders (no folders inside folders), add nesting if people ask
  const npPage = $("#notepad"), npText = $("#np-text"), npList = $("#np-list");
  // live Markdown on the page: markup shows only on the line being edited (same editor as the calendar)
  let npLoading = false; // set() also fires onChange; that isn't an edit
  const npEd = createMdEditor(npText, { placeholder: "Type anything…  # heading  **bold**  - [ ] task", onSubmit: () => {}, onChange: () => npLoading || npEdited(),
    blocks: {
      menu: (e, items) => contextMenu(e, items.map(([l, run]): MenuItem => [l, l === "Delete" ? "trash" : l === "Duplicate" ? "plus" : "pencil", run])),
      // /image and Ctrl+V: bytes go to notepad/.assets/ (Rust), the note links .assets/<name>
      saveImage: async (f) => {
        const ext = (f.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
        const name = await invoke<string>("np_save_image", new Uint8Array(await f.arrayBuffer()), { headers: { "x-ext": ext } }).catch((e) => { npErr(e); throw e; });
        return `.assets/${name}`;
      },
    } });
  // show .assets/ pictures from disk (blob URLs, loaded once per file); web images load as they are
  const npImgs = new Map<string, Promise<string>>();
  const npImgSrc = (url: string) => {
    if (/^(https?|data|blob):/i.test(url)) return url;
    const name = url.split("/").pop() ?? "";
    if (!npImgs.has(name)) npImgs.set(name, invoke<ArrayBuffer>("np_image", { name }).then((b) => URL.createObjectURL(new Blob([b]))).catch(() => ""));
    return npImgs.get(name)!;
  };
  setImageResolver(npImgSrc);
  npText.onmousedown = (e) => void (e.target === npText && (e.preventDefault(), npEd.focus())); // click in the margins → keep typing
  const npErr = (e: unknown) => { $("#np-meta").textContent = `⚠ ${e}`; };
  const np = <T,>(cmd: string, a: Record<string, unknown>) => invoke<T>(cmd, a).catch((e) => { npErr(e); throw e; });
  const npWrite = (n: Note) => np<number>("np_write", { folder: n.folder ?? "", name: n.name, text: n.text });
  // a name Windows accepts as a file name (the UI name IS the file name)
  const npClean = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim().replace(/[. ]+$/, "") || "Note";
  let npDirs: string[] = [], notes: Note[] = [];
  const npUnique = (name: string, folder: string | undefined, skip?: Note) => {
    const taken = (s: string) => notes.some((n) => n !== skip && (n.folder ?? "") === (folder ?? "") && n.name.toLowerCase() === s.toLowerCase());
    let s = npClean(name);
    for (let i = 2; taken(s); i++) s = `${npClean(name)} (${i})`;
    return s;
  };
  try {
    ({ dirs: npDirs, notes } = await invoke<{ dirs: string[]; notes: Note[] }>("np_list"));
    notes.forEach((n) => n.folder ?? delete n.folder); // Rust sends null for top level
    npDirs.sort((a, b) => a.localeCompare(b));
  } catch (e) { console.error("notepad load", e); }
  // one-time move from the localStorage versions to files; pins/recent follow the new ids
  let old: Note[] = [];
  try { old = JSON.parse(localStorage.notepadFiles ?? "[]"); } catch {}
  if (localStorage.notepad) old.push({ id: 0, name: "Note", text: localStorage.notepad, t: Date.now() });
  if (old.length || localStorage.notepadFolders) {
    try {
      let oldDirs: string[] = [];
      try { oldDirs = JSON.parse(localStorage.notepadFolders ?? "[]"); } catch {}
      const dirMap = new Map(oldDirs.map((d) => [d, npClean(d)]));
      for (const d of new Set(dirMap.values())) if (!npDirs.includes(d)) await invoke("np_mkdir", { folder: d }), npDirs.push(d);
      const idMap = new Map<string, number>();
      for (const o of old) {
        const folder = o.folder && dirMap.get(o.folder);
        const n: Note = { id: 0, name: npUnique(o.name, folder), text: o.text, t: o.t, folder };
        notes.push(n);
        n.id = await invoke<number>("np_write", { folder: folder ?? "", name: n.name, text: n.text });
        idMap.set(`${o.id}`, n.id);
      }
      const pins: string[] = JSON.parse(localStorage.notepadPins ?? "[]"), rec: number[] = JSON.parse(localStorage.notepadRecent ?? "[]");
      localStorage.notepadPins = JSON.stringify(pins.map((p) => (p[0] === "n" ? `n:${idMap.get(p.slice(2))}` : `d:${dirMap.get(p.slice(2)) ?? p.slice(2)}`)));
      localStorage.notepadRecent = JSON.stringify(rec.map((id) => idMap.get(`${id}`)));
      ["notepad", "notepadFiles", "notepadFolders"].forEach((k) => localStorage.removeItem(k)); // only after every write succeeded
    } catch (e) { console.error("notepad migrate", e); } // old data stays in localStorage; next start tries again
  }
  let npDir: string | null = null; // folder being viewed, null = top level
  let npOpen: Note | null = null;
  const stamp = (t: number) => new Date(t).toLocaleString("sv").slice(0, 16).replace(":", "."); // 2026-11-12 15.30 (no ":" in file names)
  const npInfo = () => {
    showWhere();
    $("#np-title").textContent = npOpen ? npOpen.name : npDir ?? "";
    $("#np-meta").textContent = npOpen
      ? `${npOpen.folder ? `${npOpen.folder} · ` : ""}${npEd.get().split("\n").length} lines · ${npEd.get().length} chars`
      : `${npDir ? notes.filter((n) => n.folder === npDir).length : notes.length} notes`;
  };
  // sidebar: pinned notes/folders ("n:<id>" | "d:<name>") + the 10 most recently opened notes (ids, newest first)
  const npLoad = (k: string): (string | number)[] => {
    try { return JSON.parse(localStorage[k] ?? "[]"); } catch { return []; }
  };
  let npPins = npLoad("notepadPins") as string[];
  const npSaveSide = () => (localStorage.notepadPins = JSON.stringify(npPins));
  // Recent = the 10 most recently opened notes, kept in sqlite (id = note id, at = when opened)
  await db.execute("CREATE TABLE IF NOT EXISTS notepad_recent (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
  if (localStorage.notepadRecent) { // one-time move from localStorage (list is newest first)
    const old = npLoad("notepadRecent") as number[];
    for (const [i, id] of old.entries()) if (id) await db.execute("INSERT OR IGNORE INTO notepad_recent VALUES ($1, $2)", [id, Date.now() - i]);
    localStorage.removeItem("notepadRecent");
  }
  let npRecent = (await db.select<{ id: number }[]>("SELECT id FROM notepad_recent ORDER BY at DESC LIMIT 10")).map((r) => r.id);
  const npTouch = async (id: number) => {
    npRecent = [id, ...npRecent.filter((x) => x !== id)].slice(0, 10);
    await db.execute("INSERT OR REPLACE INTO notepad_recent VALUES ($1, $2)", [id, Date.now()]);
    await db.execute("DELETE FROM notepad_recent WHERE id NOT IN (SELECT id FROM notepad_recent ORDER BY at DESC LIMIT 10)");
  };
  // Page setup per note, picked in the New dialog and logged in sqlite (id = note id). Notes without a row: plain portrait.
  // Font is per note too, picked on the page (toolbar); a new note starts with the last font picked.
  type NpMeta = { paper: string; orient: string; font?: string };
  await db.execute("CREATE TABLE IF NOT EXISTS notepad_meta (id INTEGER PRIMARY KEY, paper TEXT NOT NULL, orient TEXT NOT NULL, created INTEGER NOT NULL)");
  try { await db.execute("ALTER TABLE notepad_meta ADD COLUMN font TEXT"); } catch {} // already there
  const npMeta = new Map((await db.select<(NpMeta & { id: number })[]>("SELECT id, paper, orient, font FROM notepad_meta"))
    .map((r): [number, NpMeta] => [r.id, { paper: r.paper, orient: r.orient, font: r.font ?? undefined }]));
  const npMetaOf = (n: Note): NpMeta => npMeta.get(n.id) ?? { paper: "", orient: "portrait" };
  const npSetMeta = (id: number, m: NpMeta) => (npMeta.set(id, m), db.execute(
    "INSERT INTO notepad_meta (id, paper, orient, font, created) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(id) DO UPDATE SET paper = excluded.paper, orient = excluded.orient, font = excluded.font",
    [id, m.paper, m.orient, m.font ?? null, Date.now()]).catch(npErr));
  const npFontList = $("#np-font");
  const npApply = (m: NpMeta) => {
    const f = NP_FONTS.find((x) => x[0] === m.font) ?? NP_FONTS[0];
    npText.dataset.paper = m.paper;
    npText.dataset.orient = m.orient;
    npText.style.setProperty("--np-font", f[2]);
    npFontList.querySelectorAll<HTMLElement>("[data-font]").forEach((b) => b.classList.toggle("on", b.dataset.font === f[0]));
    $("#np-paperset").querySelectorAll<HTMLElement>("button").forEach((b) =>
      b.classList.toggle("on", b.dataset.paper !== undefined ? b.dataset.paper === m.paper : b.dataset.orient === m.orient));
  };
  // paper style / orientation of the open note, changed from the tools dropdown (logged in notepad_meta)
  $("#np-paperset").onclick = (e) => {
    const b = (e.target as Element).closest<HTMLElement>("button");
    if (!b || !npOpen) return;
    const m = { ...npMetaOf(npOpen), ...(b.dataset.paper !== undefined ? { paper: b.dataset.paper } : { orient: b.dataset.orient! }) };
    npApply(m);
    npSetMeta(npOpen.id, m);
  };
  npFontList.onclick = (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-font]");
    if (!b || !npOpen) return;
    const m = { ...npMetaOf(npOpen), font: b.dataset.font };
    localStorage.notepadFont = m.font;
    npApply(m);
    npSetMeta(npOpen.id, m);
  };
  // New dialog: resolves to the chosen setup (starts from the last one used), or null on cancel
  const npAskMeta = () => {
    const dlg = $<HTMLDialogElement>("#np-newdlg"), f = dlg.querySelector("form")!;
    let last: NpMeta = { paper: "", orient: "portrait" };
    try { last = { ...last, ...JSON.parse(localStorage.notepadLast ?? "{}") }; } catch {}
    const minis = () => dlg.querySelectorAll<HTMLElement>(".np-mini").forEach((s) => (s.dataset.orient = (f.elements.namedItem("orient") as RadioNodeList).value));
    (f.elements.namedItem("paper") as RadioNodeList).value = last.paper;
    (f.elements.namedItem("orient") as RadioNodeList).value = last.orient;
    f.onchange = minis;
    minis();
    dlg.returnValue = "";
    dlg.showModal();
    return new Promise<NpMeta | null>((res) => dlg.addEventListener("close", () => {
      if (dlg.returnValue !== "ok") return res(null);
      const m = { paper: (f.elements.namedItem("paper") as RadioNodeList).value, orient: (f.elements.namedItem("orient") as RadioNodeList).value };
      localStorage.notepadLast = JSON.stringify(m);
      res(m);
    }, { once: true }));
  };
  const npForget = (id: number) => ((npRecent = npRecent.filter((x) => x !== id)), db.execute("DELETE FROM notepad_recent WHERE id = $1", [id]));
  const npKey = (x: Note | string) => (typeof x === "string" ? `d:${x}` : `n:${x.id}`);
  const npTogglePin = (x: Note | string) => {
    const k = npKey(x);
    npPins = npPins.includes(k) ? npPins.filter((p) => p !== k) : [...npPins, k];
    npSaveSide();
    npSideDraw();
  };
  const npPinItem = (x: Note | string): MenuItem => npPins.includes(npKey(x)) ? ["Unpin", "x", () => npTogglePin(x)] : ["Pin to sidebar", "plus", () => npTogglePin(x)];
  const npSideDraw = () => {
    const byId = new Map(notes.map((n) => [n.id, n]));
    npPins = npPins.filter((p) => (p[0] === "d" ? npDirs.includes(p.slice(2)) : byId.has(+p.slice(2)))); // drop deleted ones
    npRecent = npRecent.filter((id) => byId.has(id));
    const row = (attr: string, ic: string, name: string, sub: string, on: boolean) =>
      `<button ${attr} class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left ${on ? "bg-amber-500/15 text-amber-400" : "hover:bg-zinc-800"}">
        ${icon(ic as keyof typeof ICONS, `h-4 w-4 shrink-0 ${ic === "folder" ? "text-amber-400" : "text-zinc-400"}`)}
        <span class="min-w-0 flex-1 truncate text-sm">${esc(name)}</span>${sub ? `<span class="shrink-0 font-mono text-[10px] text-zinc-500">${sub}</span>` : ""}</button>`;
    const head = (t: string) => `<p class="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">${t}</p>`;
    const pins = npPins.map((p) =>
      p[0] === "d"
        ? row(`data-sdir="${esc(p.slice(2))}"`, "folder", p.slice(2), "", npDir === p.slice(2) && !npOpen)
        : row(`data-sn="${p.slice(2)}"`, "file", byId.get(+p.slice(2))!.name, "", npOpen?.id === +p.slice(2)));
    const recent = npRecent.map((id) => byId.get(id)!).map((n) => row(`data-sn="${n.id}"`, "file", n.name, new Date(n.t).toLocaleTimeString("sv").slice(0, 5), npOpen?.id === n.id));
    $("#np-side").innerHTML =
      head("Pinned") + (pins.join("") || `<p class="px-2.5 py-1 text-xs text-zinc-600">Right-click a note or folder → Pin</p>`) +
      `<div class="my-2 border-t border-zinc-800"></div>` +
      head("Recent") + (recent.join("") || `<p class="px-2.5 py-1 text-xs text-zinc-600">Notes you open show up here</p>`);
  };
  $("#np-side").onclick = (e) => {
    const t = e.target as Element, n = t.closest<HTMLElement>("[data-sn]"), d = t.closest<HTMLElement>("[data-sdir]");
    if (n) npShow(notes.find((x) => x.id === +n.dataset.sn!) ?? null);
    else if (d) (npDir = d.dataset.sdir!), npShow(null);
  };
  $("#np-side").oncontextmenu = (e) => {
    const t = e.target as Element, n = t.closest<HTMLElement>("[data-sn]"), d = t.closest<HTMLElement>("[data-sdir]")?.dataset.sdir;
    const note = n && notes.find((x) => x.id === +n.dataset.sn!);
    if (note) contextMenu(e, [["Open", "file", () => npShow(note)], npPinItem(note), ...(npRecent.includes(note.id) ? [["Remove from recent", "x", () => (npForget(note.id), npSideDraw())] as MenuItem] : [])]);
    else if (d) contextMenu(e, [["Open", "folder", () => ((npDir = d), npShow(null))], npPinItem(d)]);
    else e.preventDefault();
  };
  const npShow = (n: Note | null) => {
    npOpen = n;
    npList.classList.toggle("hidden", !!n);
    $("#np-desk").classList.toggle("hidden", !n);
    $("#np-new").classList.toggle("hidden", !!n);
    $("#np-tools").classList.toggle("hidden", !n);
    $("#np-tools").classList.toggle("flex", !!n);
    if (n) npApply(npMetaOf(n));
    $("#np-newdir").classList.toggle("hidden", !!n || !!npDir);
    if (n) npTouch(n.id).catch(console.error);
    npSideDraw();
    if (n) (npLoading = true), npEd.set(n.text), (npLoading = false), npEd.focus();
    else npDraw();
    npInfo();
  };
  // 3D-ish icons for the Notepad grid; gradient ids must be unique per instance (hidden duplicates break url(#id))
  let npSeq = 0;
  const npPaper = (x: number, r: number) =>
    `<g transform="rotate(${r} ${x + 14} 40)"><rect x="${x}" y="9" width="28" height="36" rx="2" fill="#fff" stroke="#d4d4d8" stroke-width=".6"/>
     <path d="M${x + 5} 16h18M${x + 5} 21h14M${x + 5} 26h18M${x + 5} 31h11" stroke="#a1a1aa" stroke-width="1.6" stroke-linecap="round"/></g>`;
  const npFolderSvg = (count: number) => {
    const k = ++npSeq;
    return `<svg viewBox="0 0 64 56" class="h-20 w-20 drop-shadow-[0_6px_8px_rgb(0_0_0/0.18)]" aria-hidden="true">
      <defs>
        <linearGradient id="npfb${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5c542"/><stop offset="1" stop-color="#d99a0b"/></linearGradient>
        <linearGradient id="npff${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe9a3"/><stop offset=".55" stop-color="#fcd25a"/><stop offset="1" stop-color="#f0b429"/></linearGradient>
      </defs>
      <path d="M5 6a3 3 0 0 1 3-3h15l5 5h28a3 3 0 0 1 3 3v38a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Z" fill="url(#npfb${k})"/>
      ${count > 1 ? npPaper(26, 7) : ""}${count > 0 ? npPaper(16, -4) : ""}
      <path d="M3 22a3 3 0 0 1 3-3h52a3 3 0 0 1 3 3.3l-2.6 26.4A3 3 0 0 1 55.4 51H8.6a3 3 0 0 1-3-2.7Z" fill="url(#npff${k})"/>
      <path d="M6.5 20.5h51" stroke="#fff" stroke-opacity=".75" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`;
  };
  const npNoteSvg = () => {
    const k = ++npSeq;
    return `<svg viewBox="0 0 64 64" class="h-20 w-20 drop-shadow-[0_6px_8px_rgb(0_0_0/0.18)]" aria-hidden="true">
      <defs>
        <linearGradient id="npn${k}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e7e5e4"/></linearGradient>
        <linearGradient id="npc${k}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>
      </defs>
      <path d="M14 4h26l12 12v42a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" fill="url(#npn${k})" stroke="#d6d3d1" stroke-width=".8"/>
      <rect x="11.4" y="4.4" width="28" height="7" rx="2.6" fill="#fbbf24" opacity=".9"/>
      <path d="M40 4v9a3 3 0 0 0 3 3h9Z" fill="url(#npc${k})"/>
      <path d="M18 24h22M18 30h26M18 36h20M18 42h26M18 48h14" stroke="#a8a29e" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  };
  const npDraw = () => {
    notes.sort((a, b) => b.t - a.t);
    const dirs = npDir ? [] : npDirs;
    const here = notes.map((n, i) => [n, i] as const).filter(([n]) => (n.folder ?? null) === npDir);
    npList.innerHTML = dirs.length || here.length
      ? dirs.map((d) => {
          const k = notes.filter((n) => n.folder === d).length;
          return `<button data-dir="${esc(d)}" title="${esc(d)} · ${k} notes" class="flex flex-col items-center gap-1 rounded-xl border border-transparent p-2 text-center transition hover:border-amber-500/40 hover:bg-amber-500/10 focus-visible:border-amber-500/60 focus-visible:outline-none">
            ${npFolderSvg(k)}
            <span class="line-clamp-2 w-full break-words text-xs">${esc(d)}</span></button>`;
        }).join("") +
        here.map(([n, i]) => `<button data-n="${i}" class="flex flex-col items-center gap-1 rounded-xl border border-transparent p-2 text-center transition hover:border-amber-500/40 hover:bg-amber-500/10 focus-visible:border-amber-500/60 focus-visible:outline-none">
            ${npNoteSvg()}
            <span class="line-clamp-2 w-full break-words text-xs">${esc(n.name)}</span></button>`).join("")
      : `<p class="col-span-full grid h-60 place-items-center text-sm text-zinc-500">${npDir ? "Empty folder. Press New to add a note here." : "No notes yet. Press New or right-click → New note."}</p>`;
    npSideDraw(); // names/moves/deletes show in the sidebar too
  };
  const npNew = async () => {
    const meta = await npAskMeta();
    if (!meta) return;
    const folder = npDir ?? undefined;
    const n: Note = { id: 0, name: npUnique(stamp(Date.now()), folder), text: "", t: Date.now(), folder };
    n.id = await npWrite(n);
    await npSetMeta(n.id, { ...meta, font: localStorage.notepadFont ?? NP_FONTS[0][0] });
    notes.push(n);
    npShow(n);
  };
  const npOpenDir = (d: string | null) => ((npDir = d), npShow(null));
  const npNewDir = async () => {
    const raw = await inputBox("New folder", "Notepad", "Create", "folder", "Folder name");
    const name = raw && npClean(raw);
    if (!name || npDirs.some((x) => x.toLowerCase() === name.toLowerCase())) return;
    await np("np_mkdir", { folder: name });
    npDirs.push(name);
    npDirs.sort((a, b) => a.localeCompare(b));
    npDraw();
    npInfo();
  };
  const npRenameDir = async (d: string) => {
    const ask = inputBox("Rename folder", d, "Rename", "folder", "Folder name");
    $<HTMLInputElement>("#confirm-input").value = d;
    $<HTMLButtonElement>("#confirm-ok").disabled = false;
    const raw = await ask;
    const name = raw && npClean(raw);
    if (!name || name === d || npDirs.some((x) => x !== d && x.toLowerCase() === name.toLowerCase())) return;
    await np("np_move", { folder: d, name: null, toFolder: name, toName: null });
    npDirs = npDirs.map((x) => (x === d ? name : x));
    notes.forEach((n) => n.folder === d && (n.folder = name));
    npPins = npPins.map((p) => (p === `d:${d}` ? `d:${name}` : p));
    npSaveSide();
    npDraw();
  };
  // move and/or rename a note's file; the name gets " (2)" if the target folder already has it
  const npMove = async (n: Note, folder: string | undefined, name = n.name) => {
    const to = npUnique(name, folder, n);
    await np("np_move", { folder: n.folder ?? "", name: n.name, toFolder: folder ?? "", toName: to });
    n.folder = folder;
    n.name = to;
  };
  const npMoveItems = (n: Note): MenuItem[] => [
    ...npDirs.filter((d) => d !== n.folder).map((d): MenuItem => [`Move to ${d}`, "folder", async () => (await npMove(n, d), npDraw(), npInfo())]),
    ...(n.folder ? [[`Move out of ${n.folder}`, "folder", async () => (await npMove(n, undefined), npDraw(), npInfo())] as MenuItem] : []),
  ];
  const npRename = async (n: Note) => {
    const ask = inputBox("Rename note", n.name, "Rename", "file", "Note name");
    $<HTMLInputElement>("#confirm-input").value = n.name; // start from the current name
    $<HTMLButtonElement>("#confirm-ok").disabled = false;
    const name = await ask;
    if (name && name !== n.name) await npMove(n, n.folder, name), npDraw();
  };
  const npEdited = () => {
    if (!npOpen) return;
    npOpen.text = npEd.get();
    npOpen.t = Date.now();
    npInfo();
    npWrite(npOpen).catch(() => {}); // ponytail: a write per keystroke (small files, ordered by Tauri); debounce if notes get huge
  };
  // hover a note → the top of its page (real paper, font and Markdown, scaled down) below-right of it;
  // shown only once its pictures have loaded, so it never pops in half-drawn
  const npPeek = $("#np-peek");
  let npPeekT = 0, npPeekSeq = 0; // seq: a newer hover (or leaving) cancels a preview still loading
  const npPeekHide = () => (clearTimeout(npPeekT), npPeekSeq++, npPeek.classList.add("hidden"), delete npPeek.dataset.n);
  npList.onmouseover = (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-n]");
    if (!b) return npPeekHide();
    if (npPeek.dataset.n === b.dataset.n) return; // already showing / loading this one
    npPeekHide();
    npPeek.dataset.n = b.dataset.n;
    const seq = npPeekSeq;
    npPeekT = setTimeout(async () => {
      const n = notes[+b.dataset.n!];
      if (!n) return;
      const m = npMetaOf(n);
      const page = Object.assign(document.createElement("div"), { className: "np-paper np-ink np-peek-page" });
      Object.assign(page.dataset, { paper: m.paper, orient: m.orient });
      page.style.fontFamily = (NP_FONTS.find((x) => x[0] === m.font) ?? NP_FONTS[0])[2];
      // drawn like the editor (and Export PDF): a row per line, pictures loaded before it shows
      const rows = n.text.trim() ? await renderLines(n.text, npImgSrc, npPageW(m)) : [Object.assign(document.createElement("div"), { className: "mdl-row", textContent: "Empty note", style: "color:#a1a1aa" })];
      page.append(...rows);
      if (seq !== npPeekSeq) return; // moved on meanwhile
      const clip = Object.assign(document.createElement("div"), { className: "np-peek-clip" });
      clip.append(page);
      npPeek.replaceChildren(clip);
      // fit the page's width to the preview (portrait or landscape), then place it below-right of the icon, on screen
      npPeek.classList.remove("hidden");
      page.style.zoom = String(clip.clientWidth / page.offsetWidth);
      const r = b.getBoundingClientRect(), p = npPeek.getBoundingClientRect();
      npPeek.style.left = `${Math.max(8, Math.min(r.right - 16, innerWidth - p.width - 8))}px`;
      npPeek.style.top = `${r.bottom + 8 + p.height > innerHeight - 8 ? Math.max(8, r.top - p.height - 8) : r.bottom + 8}px`;
    }, 300);
  };
  npList.onmouseleave = npPeekHide;
  npList.addEventListener("scroll", npPeekHide);
  npList.addEventListener("mousedown", npPeekHide);
  npList.onclick = (e) => {
    const t = e.target as Element, b = t.closest<HTMLElement>("[data-n]"), d = t.closest<HTMLElement>("[data-dir]");
    if (b) npShow(notes[+b.dataset.n!]);
    else if (d) npOpenDir(d.dataset.dir!);
  };
  npList.oncontextmenu = (e) => {
    const t = e.target as Element, b = t.closest<HTMLElement>("[data-n]"), d = t.closest<HTMLElement>("[data-dir]")?.dataset.dir;
    const n = b && notes[+b.dataset.n!];
    const blank: MenuItem[] = [["New note", "plus", npNew], ...(npDir ? [] : [["New folder", "folder", npNewDir] as MenuItem])];
    contextMenu(e, n
      ? [
          ["Open", "file", () => npShow(n)],
          npPinItem(n),
          ["Rename…", "pencil", () => npRename(n)],
          ...npMoveItems(n),
          ["New note", "plus", npNew],
          ["Delete", "trash", async () => {
            if (!(await confirmBox("Delete note?", n.name, "Delete"))) return;
            await np("np_remove", { folder: n.folder ?? "", name: n.name });
            notes = notes.filter((x) => x !== n);
            npForget(n.id);
            npShow(null);
          }],
        ]
      : d
        ? [
            ["Open", "folder", () => npOpenDir(d)],
            npPinItem(d),
            ["Rename…", "pencil", () => npRenameDir(d)],
            ["Delete folder", "trash", async () => {
              const k = notes.filter((n) => n.folder === d).length;
              if (!(await confirmBox("Delete folder?", `${d}${k ? ` (its ${k} notes move to the top level)` : ""}`, "Delete"))) return;
              try {
                for (const n of notes.filter((n) => n.folder === d)) await npMove(n, undefined); // keep the notes, just unfile them
                await np("np_remove", { folder: d, name: null }); // only removes an empty folder
                npDirs = npDirs.filter((x) => x !== d);
                npDraw();
                npInfo();
              } catch { npDraw(); } // np() already showed the error
            }],
          ]
        : blank);
  };
  // Zoom: one level for all notes (−/+, Ctrl + wheel, click the % to reset), remembered per machine
  let npZoom = 1;
  const npSetZoom = (z: number) => {
    npZoom = Math.min(3, Math.max(0.3, Math.round(z * 10) / 10));
    npText.style.zoom = String(npZoom);
    $("#np-zoom").textContent = `${Math.round(npZoom * 100)}%`;
    localStorage.notepadZoom = npZoom;
  };
  npSetZoom(+localStorage.notepadZoom || 1);

  // Export PDF: ask where to save, lay the note out on A4 sheets exactly as the editor draws it (mdlines.ts:
  // a row per line, same paper / font / pictures), then Rust has WebView2 render those sheets into the file (np_pdf).
  // ponytail: a row never splits across two sheets (a tall picture or code block moves whole to the next one)
  const npPageW = (m: NpMeta) => (m.orient === "landscape" ? 978 : 650); // text width inside the 72px margins
  $("#np-pdf").onclick = async () => {
    if (!npOpen) return;
    npTools(false);
    const note = npOpen, m = npMetaOf(note), font = (NP_FONTS.find((x) => x[0] === m.font) ?? NP_FONTS[0])[2];
    const path = await saveDialog({ title: "Export PDF", defaultPath: `${note.name}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!path) return;
    const btn = $<HTMLButtonElement>("#np-pdf");
    btn.disabled = true;
    $("#np-meta").textContent = "Exporting PDF…";
    const out = Object.assign(document.createElement("div"), { id: "np-print" });
    const size = Object.assign(document.createElement("style"), { textContent: `@page { size: A4 ${m.orient}; margin: 0; }` });
    try {
      const rows = await renderLines(npEd.get(), npImgSrc, npPageW(m));
      document.body.append(out); // laid out (off screen) so heights can be measured
      paginate(rows, () => {
        const s = Object.assign(document.createElement("div"), { className: "np-paper np-ink np-sheet" });
        Object.assign(s.dataset, { paper: m.paper, orient: m.orient });
        s.style.fontFamily = font;
        return out.appendChild(s);
      });
      document.head.append(size);
      await invoke("np_pdf", { path, landscape: m.orient === "landscape" });
      $("#np-meta").textContent = `PDF saved · ${path}`;
      revealItemInDir(path).catch(() => {}); // show it in Explorer
    } catch (e) {
      npErr(e);
    } finally {
      out.remove();
      size.remove();
      btn.disabled = false;
    }
  };
  $("#np-zin").onclick = () => npSetZoom(npZoom + 0.1);
  $("#np-zout").onclick = () => npSetZoom(npZoom - 0.1);
  $("#np-zoom").onclick = () => npSetZoom(1);
  // tools dropdown: the button opens it; a click outside or Esc closes it
  const npToolsBtn = $("#np-tools-btn"), npToolsMenu = $("#np-tools-menu");
  const npTools = (open: boolean) => (npToolsMenu.classList.toggle("hidden", !open), npToolsBtn.setAttribute("aria-expanded", String(open)));
  npToolsBtn.onclick = () => npTools(npToolsMenu.classList.contains("hidden"));
  addEventListener("mousedown", (e) => $("#np-tools").contains(e.target as Node) || npTools(false));
  addEventListener("keydown", (e) => e.key === "Escape" && npTools(false));
  // Images: pictures (default) or their ![](...) Markdown, for every note; remembered per machine
  const npImgMode = (src: boolean) => {
    npEd.imageSource(src);
    try { localStorage.notepadImgSource = src ? "1" : ""; } catch {}
    $("#np-imgmode").querySelectorAll<HTMLElement>("[data-img]").forEach((b) => {
      const on = (b.dataset.img === "src") === src;
      b.classList.toggle("bg-amber-500", on);
      b.classList.toggle("text-black", on);
    });
  };
  $("#np-imgmode").onclick = (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-img]");
    if (b) npImgMode(b.dataset.img === "src");
  };
  npImgMode(localStorage.notepadImgSource === "1");
  $("#np-desk").addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault(); // instead of zooming the whole window
    npSetZoom(npZoom + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });

  $("#np-new").onclick = npNew;
  $("#np-newdir").onclick = npNewDir;
  $("[data-notepad]").onclick = () => ((npDir = null), npShow(null), npPage.classList.replace("hidden", "flex"));
  // Back: note → its list, folder → top level, top level → main display
  $("#np-close").onclick = () => (npOpen ? npShow(null) : npDir ? npOpenDir(null) : npPage.classList.replace("flex", "hidden"));

  // BaseCurves app (Navicat-style): toolbar · connection tree · Objects / table Data / Query views.
  const bc = $("#bc");
  type Row = Record<string, unknown>;
  type DbConn = { id: number; name: string; url: string };
  let bcDb: Database = db, bcOn = false, bcD: Dialect = "sqlite", bcTable = "", bcCols: Col[] = [], bcKeys: Col[] = [];
  let bcCid = 0, bcCollapsed = false, bcDbOpen = false, bcDbList: string[] = [], bcCurDb = "", bcObjs: Row[] = [], bcSel = "", bcQRows: Row[] = [], bcDataRows: Row[] = [];
  let bcUrl = ""; // current connection URL, with password, for switching databases
  let bcSchemas: string[] = [], bcCurSchema = ""; // Postgres only
  let dbConns: DbConn[] = [];
  // Several connections can be open at once. The selected one lives in the bc* variables above (what Objects / Data /
  // Query / ER use); the others wait in `sessions` with their pools still open, so switching back needs no reconnect.
  type Sess = { db: Database; d: Dialect; url: string; curDb: string; dbList: string[]; objs: Row[]; schemas: string[]; curSchema: string; collapsed: boolean; dbOpen: boolean };
  const sessions = new Map<number, Sess>();
  const snap = (): Sess => ({ db: bcDb, d: bcD, url: bcUrl, curDb: bcCurDb, dbList: bcDbList, objs: bcObjs, schemas: bcSchemas, curSchema: bcCurSchema, collapsed: bcCollapsed, dbOpen: bcDbOpen });
  const sess = (id: number) => (bcOn && id === bcCid ? snap() : sessions.get(id));
  const isOpen = (id: number) => !!sess(id);
  /** Make an already-open connection the selected one (no reconnect). */
  const bcActivate = (id: number) => {
    const s = sessions.get(id);
    if (!s || (bcOn && id === bcCid)) return;
    if (bcOn) sessions.set(bcCid, snap());
    sessions.delete(id);
    (bcDb = s.db), (bcD = s.d), (bcUrl = s.url), (bcCurDb = s.curDb), (bcDbList = s.dbList), (bcObjs = s.objs), (bcSchemas = s.schemas), (bcCurSchema = s.curSchema);
    (bcCid = id), (bcOn = true), (bcCollapsed = false), (bcDbOpen = s.dbOpen), (bcSel = ""), (bcErDirty = true);
    if (bcTable) { // the open table belonged to the other connection; stay in Query if that's where we are
      bcTable = "";
      dataTab().classList.add("hidden");
      if (bcV === "data") bcView("objects");
    }
    bcEditor.setDialect(bcD);
    bcSchema();
    if (bcV === "er") bcEr();
    bcDrawObjects();
    bcTree();
    bcStatus();
    bcMsg(`Using ${[bcConn()?.name, bcCurDb, bcCurSchema].filter(Boolean).join(" › ")}`);
  };
  const bcMsg = (s: string, bad = false) => (($("#bc-msg").textContent = $("#bc-msg").title = s), $("#bc-msg").classList.toggle("text-red-400", bad));
  // Loading feedback: spinner in the status bar while anything runs, and a centred one in the pane being filled.
  let bcBusyN = 0, bcConnecting = 0;
  const bcBusy = (d: 1 | -1) => $("#bc-spin").classList.toggle("hidden", (bcBusyN = Math.max(0, bcBusyN + d)) === 0);
  const loading = (el: HTMLElement, text: string) =>
    (el.innerHTML = `<div class="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-sm text-zinc-500">${spinner("h-8 w-8")}<span class="animate-pulse">${esc(text)}</span></div>`);
  const bcConn = () => dbConns.find((c) => c.id === bcCid);
  const kindOf = (c: DbConn) => fromUrl(c.url).kind;
  const KIND_COLOR: Record<Kind, string> = { postgres: "#336791", mysql: "#00758f", mariadb: "#c0765a", sqlite: "#0f80cc" };
  // DB brand marks (Simple Icons, CC0), white on the brand colour; greyed out until that connection is open.
  const DB_LOGO: Record<Kind, string> = {
    postgres: "M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z",
    mysql: "M16.405 5.501c-.115 0-.193.014-.274.033v.013h.014c.054.104.146.18.214.273.054.107.1.214.154.32l.014-.015c.094-.066.14-.172.14-.333-.04-.047-.046-.094-.08-.14-.04-.067-.126-.1-.18-.153zM5.77 18.695h-.927a50.854 50.854 0 00-.27-4.41h-.008l-1.41 4.41H2.45l-1.4-4.41h-.01a72.892 72.892 0 00-.195 4.41H0c.055-1.966.192-3.81.41-5.53h1.15l1.335 4.064h.008l1.347-4.064h1.095c.242 2.015.384 3.86.428 5.53zm4.017-4.08c-.378 2.045-.876 3.533-1.492 4.46-.482.716-1.01 1.073-1.583 1.073-.153 0-.34-.046-.566-.138v-.494c.11.017.24.026.386.026.268 0 .483-.075.647-.222.197-.18.295-.382.295-.605 0-.155-.077-.47-.23-.944L6.23 14.615h.91l.727 2.36c.164.536.233.91.205 1.123.4-1.064.678-2.227.835-3.483zm12.325 4.08h-2.63v-5.53h.885v4.85h1.745zm-3.32.135l-1.016-.5c.09-.076.177-.158.255-.25.433-.506.648-1.258.648-2.253 0-1.83-.718-2.746-2.155-2.746-.704 0-1.254.232-1.65.697-.43.508-.646 1.256-.646 2.245 0 .972.19 1.686.574 2.14.35.41.877.615 1.583.615.264 0 .506-.033.725-.098l1.325.772.36-.622zM15.5 17.588c-.225-.36-.337-.94-.337-1.736 0-1.393.424-2.09 1.27-2.09.443 0 .77.167.977.5.224.362.336.936.336 1.723 0 1.404-.424 2.108-1.27 2.108-.445 0-.77-.167-.978-.5zm-1.658-.425c0 .47-.172.856-.516 1.156-.344.3-.803.45-1.384.45-.543 0-1.064-.172-1.573-.515l.237-.476c.438.22.833.328 1.19.328.332 0 .593-.073.783-.22a.754.754 0 00.3-.615c0-.33-.23-.61-.648-.845-.388-.213-1.163-.657-1.163-.657-.422-.307-.632-.636-.632-1.177 0-.45.157-.81.47-1.085.315-.278.72-.415 1.22-.415.512 0 .98.136 1.4.41l-.213.476a2.726 2.726 0 00-1.064-.23c-.283 0-.502.068-.654.206a.685.685 0 00-.248.524c0 .328.234.61.666.85.393.215 1.187.67 1.187.67.433.305.648.63.648 1.168zm9.382-5.852c-.535-.014-.95.04-1.297.188-.1.04-.26.04-.274.167.055.053.063.14.11.214.08.134.218.313.346.407.14.11.28.216.427.31.26.16.555.255.81.416.145.094.293.213.44.313.073.05.12.14.214.172v-.02c-.046-.06-.06-.147-.105-.214-.067-.067-.134-.127-.2-.193a3.223 3.223 0 00-.695-.675c-.214-.146-.682-.35-.77-.595l-.013-.014c.146-.013.32-.066.46-.106.227-.06.435-.047.67-.106.106-.027.213-.06.32-.094v-.06c-.12-.12-.21-.283-.334-.395a8.867 8.867 0 00-1.104-.823c-.21-.134-.476-.22-.697-.334-.08-.04-.214-.06-.26-.127-.12-.146-.19-.34-.275-.514a17.69 17.69 0 01-.547-1.163c-.12-.262-.193-.523-.34-.763-.69-1.137-1.437-1.826-2.586-2.5-.247-.14-.543-.2-.856-.274-.167-.008-.334-.02-.5-.027-.11-.047-.216-.174-.31-.235-.38-.24-1.364-.76-1.644-.072-.18.434.267.862.422 1.082.115.153.26.328.34.5.047.116.06.235.107.356.106.294.207.622.347.897.073.14.153.287.247.413.054.073.146.107.167.227-.094.136-.1.334-.154.5-.24.757-.146 1.693.194 2.25.107.166.362.534.703.393.3-.12.234-.5.32-.835.02-.08.007-.133.048-.187v.015c.094.188.188.367.274.555.206.328.566.668.867.895.16.12.287.328.487.402v-.02h-.015c-.043-.058-.1-.086-.154-.133a3.445 3.445 0 01-.35-.4 8.76 8.76 0 01-.747-1.218c-.11-.21-.202-.436-.29-.643-.04-.08-.04-.2-.107-.24-.1.146-.247.273-.32.453-.127.288-.14.642-.188 1.01-.027.007-.014 0-.027.014-.214-.052-.287-.274-.367-.46-.2-.475-.233-1.238-.06-1.785.047-.14.247-.582.167-.716-.042-.127-.174-.2-.247-.303a2.478 2.478 0 01-.24-.427c-.16-.374-.24-.788-.414-1.162-.08-.173-.22-.354-.334-.513-.127-.18-.267-.307-.368-.52-.033-.073-.08-.194-.027-.274.014-.054.042-.075.094-.09.088-.072.335.022.422.062.247.1.455.194.662.334.094.066.195.193.315.226h.14c.214.047.455.014.655.073.355.114.675.28.962.46a5.953 5.953 0 012.085 2.286c.08.154.115.295.188.455.14.33.313.663.455.982.14.315.275.636.476.897.1.14.502.213.682.286.133.06.34.115.46.188.23.14.454.3.67.454.11.076.443.243.463.378z",
    mariadb: "M23.157 4.412c-.676.284-.79.31-1.673.372-.65.045-.757.057-1.212.209-.75.246-1.395.75-2.02 1.59-.296.398-1.249 1.913-1.249 1.988 0 .057-.65.998-.915 1.32-.574.713-1.08 1.079-2.14 1.59-.77.36-1.224.524-4.102 1.477-1.073.353-2.133.738-2.367.864-.852.449-1.515 1.036-2.203 1.938-1.003 1.32-.972 1.313-3.042.947a12.264 12.264 0 00-.675-.063c-.644-.05-1.023.044-1.332.334L0 17.193l.177.088c.094.05.353.234.561.398.215.17.461.347.55.391.088.044.17.088.183.101.012.013-.089.17-.228.353-.435.581-.593.871-.574 1.048.019.164.032.17.43.17.517-.006.826-.056 1.261-.208.65-.233 2.058-.94 2.784-1.4.776-.5 1.717-.998 1.956-1.042.082-.02.354-.07.594-.114.58-.107 1.464-.095 2.587.05.108.013.373.045.6.064.227.025.43.057.454.076.026.012.474.037.998.056.934.026 1.104.007 1.3-.189.126-.133.385-.631.498-.985.209-.643.417-.921.366-.492-.113.966-.322 1.692-.713 2.411-.259.499-.663 1.092-.934 1.395-.322.347-.315.36.088.315.619-.063 1.471-.397 2.096-.82.827-.562 1.647-1.691 2.19-3.03.107-.27.22-.22.183.083-.013.094-.038.315-.057.498l-.031.328.353-.202c.833-.48 1.414-1.262 2.127-2.884.227-.518.877-2.922 1.073-3.976a9.64 9.64 0 01.271-1.042c.127-.429.196-.555.48-.858.183-.19.625-.555.978-.808.72-.505.953-.75 1.187-1.205.208-.417.284-1.13.132-1.357-.132-.202-.284-.196-.763.006Z",
    sqlite: "M21.678.521c-1.032-.92-2.28-.55-3.513.544a8.71 8.71 0 0 0-.547.535c-2.109 2.237-4.066 6.38-4.674 9.544.237.48.422 1.093.544 1.561a13.044 13.044 0 0 1 .164.703s-.019-.071-.096-.296l-.05-.146a1.689 1.689 0 0 0-.033-.08c-.138-.32-.518-.995-.686-1.289-.143.423-.27.818-.376 1.176.484.884.778 2.4.778 2.4s-.025-.099-.147-.442c-.107-.303-.644-1.244-.772-1.464-.217.804-.304 1.346-.226 1.478.152.256.296.698.422 1.186.286 1.1.485 2.44.485 2.44l.017.224a22.41 22.41 0 0 0 .056 2.748c.095 1.146.273 2.13.5 2.657l.155-.084c-.334-1.038-.47-2.399-.41-3.967.09-2.398.642-5.29 1.661-8.304 1.723-4.55 4.113-8.201 6.3-9.945-1.993 1.8-4.692 7.63-5.5 9.788-.904 2.416-1.545 4.684-1.931 6.857.666-2.037 2.821-2.912 2.821-2.912s1.057-1.304 2.292-3.166c-.74.169-1.955.458-2.362.629-.6.251-.762.337-.762.337s1.945-1.184 3.613-1.72C21.695 7.9 24.195 2.767 21.678.521m-18.573.543A1.842 1.842 0 0 0 1.27 2.9v16.608a1.84 1.84 0 0 0 1.835 1.834h9.418a22.953 22.953 0 0 1-.052-2.707c-.006-.062-.011-.141-.016-.2a27.01 27.01 0 0 0-.473-2.378c-.121-.47-.275-.898-.369-1.057-.116-.197-.098-.31-.097-.432 0-.12.015-.245.037-.386a9.98 9.98 0 0 1 .234-1.045l.217-.028c-.017-.035-.014-.065-.031-.097l-.041-.381a32.8 32.8 0 0 1 .382-1.194l.2-.019c-.008-.016-.01-.038-.018-.053l-.043-.316c.63-3.28 2.587-7.443 4.8-9.791.066-.069.133-.128.198-.194Z",
  };
  const badge = (k: Kind, on = true, box = "h-5 w-5 rounded-md", svg = "h-3.5 w-3.5") => `<span title="${KIND_LABEL[k]}${on ? "" : " · not connected"}" class="grid ${box} shrink-0 place-items-center text-white shadow transition ${on ? "" : "opacity-45 grayscale"}" style="background:${KIND_COLOR[k]}"><svg viewBox="0 0 24 24" class="${svg}" fill="currentColor"><path d="${DB_LOGO[k]}"/></svg></span>`;
  const caret = (open: boolean) => `<span class="w-3 shrink-0 text-zinc-500">${icon(open ? "arrowDown" : "chevronRight", "h-3 w-3")}</span>`;

  // ----- views -----
  type View = "main" | "objects" | "data" | "query" | "builder" | "er";
  let bcV: View = "objects"; // shown in the bottom-left path
  let bcStale = false, bcErDirty = true; // table / diagram changed by a query; redraw when shown again
  const bcView = (v: View) => {
    bcV = v;
    if (v === "data" && bcStale && bcTable) return (bcStale = false), void bcLoad(bcTable);
    if (v === "er" && bcErDirty) bcEr();
    if (v === "main") bcMain();
    if (v === "builder") qbSwitch(qbCur);
    bc.querySelectorAll<HTMLElement>("[data-view]").forEach((s) => (s.classList.toggle("hidden", s.dataset.view !== v), s.classList.toggle("flex", s.dataset.view === v)));
    $("#bc-views").querySelectorAll<HTMLElement>("[data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    $("#bc-v-objects").classList.toggle("on", v === "objects");
    $("#bc-v-query").classList.toggle("on", v === "query");
    $("#bc-v-main").classList.toggle("on", v === "main");
    if (v === "query") bcEditor.focus();
  };
  $("#bc-views").onclick = (e) => {
    if ((e.target as HTMLElement).closest("[data-close]")) return bcCloseData();
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-v]");
    if (b) bcView(b.dataset.v as View);
  };
  // Drag a bar between an editor (SQL / builder) and its results to resize both; double-click resets.
  for (const split of bc.querySelectorAll<HTMLElement>("[data-split]")) {
    const ed = $(`#${split.dataset.split}`);
    split.onpointerdown = (e) => {
      const y0 = e.clientY, h0 = ed.offsetHeight, max = ed.parentElement!.clientHeight - 80; // keep some of the results visible
      split.setPointerCapture(e.pointerId);
      split.onpointermove = (m) => ((ed.style.height = `${Math.max(48, Math.min(max, h0 + m.clientY - y0))}px`), split.dataset.split === "bc-qb" && qbDraw());
      split.onpointerup = () => (split.onpointermove = null);
    };
    split.ondblclick = () => (ed.style.height = "");
  }
  $("#bc-v-objects").onclick = () => bcView("objects");
  $("#bc-v-query").onclick = () => bcView("query");
  $("#bc-v-main").onclick = () => bcView("main");
  const bcStatus = () => {
    const c = bcConn();
    $("#bc-badge").innerHTML = bcOn && c
      ? `${badge(kindOf(c))}<span class="text-zinc-200">${esc(c.name)}</span><span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>`
      : `${icon("unplug", "h-3.5 w-3.5")} Not connected`;
    for (const id of ["#bc-v-objects", "#bc-refresh", "#bc-disconnect"]) $<HTMLButtonElement>(id).disabled = !bcOn;
    bcQBar();
  };
  // Query bar (Navicat-style): connection · database · schema the editor runs against; changing one reconnects there.
  const opt = (v: string, label: string, on: boolean) => `<option value="${esc(v)}" ${on ? "selected" : ""}>${esc(label)}</option>`;
  const qSel = (id: string) => $<HTMLSelectElement>(id);
  const bcQBar = () => {
    if (bcV === "builder") void qbSync(false); // refresh the builder for the now-selected connection
    for (const p of ["q", "b"]) {
      qSel(`#bc-${p}-conn`).innerHTML = (bcOn ? "" : opt("", "Not connected", true)) + dbConns.map((x) => opt(String(x.id), `${isOpen(x.id) ? "● " : ""}${x.name}`, bcOn && x.id === bcCid)).join("");
      qSel(`#bc-${p}-db`).innerHTML = bcOn && bcD !== "sqlite" ? bcDbList.map((n) => opt(n, n, n === bcCurDb)).join("") : opt("", bcOn ? "main" : "Database", true);
      qSel(`#bc-${p}-db`).disabled = !bcOn || bcD === "sqlite";
      qSel(`#bc-${p}-schema`).innerHTML = bcSchemas.map((n) => opt(n, n, n === bcCurSchema)).join("") + (bcCurSchema ? "" : opt("", "(no schema)", true));
      $(`[data-for="bc-${p}-schema"]`).classList.toggle("hidden", !(bcOn && bcD === "postgres"));
    }
  };
  // Same selects in Query and Builder; in Builder a change also re-binds the current builder tab to the new place.
  for (const p of ["q", "b"]) {
    const after = (run: Promise<unknown> | void) => Promise.resolve(run).finally(() => (p === "b" && bcOn && qbBind(), bcQBar()));
    qSel(`#bc-${p}-conn`).onchange = () => {
      const c = dbConns.find((x) => x.id === +qSel(`#bc-${p}-conn`).value);
      if (c) void after(bcOpenConn(c));
    };
    qSel(`#bc-${p}-db`).onchange = () => void after(bcConnect(withDb(bcUrl, qSel(`#bc-${p}-db`).value), bcCid, true));
    qSel(`#bc-${p}-schema`).onchange = () => void after(bcConnect(withSchema(bcUrl, qSel(`#bc-${p}-schema`).value), bcCid, true));
  }

  // ----- grid (table data, query results, objects) -----
  const fmt = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const TH = "sticky top-0 z-10 border-b border-r border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left text-xs font-semibold text-zinc-400 whitespace-nowrap overflow-hidden text-ellipsis";
  const TD = "border-b border-r border-zinc-800/70 px-2 py-1 font-mono text-[13px] whitespace-nowrap overflow-hidden text-ellipsis";
  // Column widths: start fitted to the first rows but capped (long text shows "…"); drag a header edge to resize,
  // double-click it to fit the whole column (up to GRID_FIT). Widths stick per grid + table across reloads and pages.
  const GRID_DEF = 240, GRID_FIT = 800, GRID_MIN = 48;
  const colW = new Map<string, number>(), gridRows = new WeakMap<HTMLElement, Row[]>();
  type Edit = { db: Database; d: Dialect; cols: Map<string, Src> }; // editable result columns → their table, column and key
  const gridEdit = new WeakMap<HTMLElement, Edit>();
  const pending = new Map<HTMLElement, Map<HTMLInputElement, string | null>>(); // staged cell edits per grid, written by Update
  const wKey = (el: HTMLElement, c: string) => `${el.id}|${el.id === "bc-grid" ? bcTable : ""}|${c}`;
  const pen = document.createElement("canvas").getContext("2d")!;
  const fontOf = (v: string, dflt: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || dflt;
  const fitW = (rows: Row[], c: string, cap: number) => {
    pen.font = `600 12px ${fontOf("--font-sans", "sans-serif")}`;
    let w = pen.measureText(c).width + 38; // padding + sort arrow
    pen.font = `13px ${fontOf("--font-mono", "monospace")}`;
    for (const r of rows) {
      w = Math.max(w, pen.measureText(r[c] === null ? "NULL" : fmt(r[c]).slice(0, 400)).width + 20);
      if (w >= cap) break;
    }
    return Math.round(Math.min(cap, Math.max(GRID_MIN, w)));
  };
  const rz = (c: string) => `<span data-rz="${esc(c)}" title="Drag to resize · double-click to fit" class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-amber-500/50"></span>`;
  /** `sort` given = headers are clickable sort toggles; `from` = row number offset (paging). */
  const bcGrid = (el: HTMLElement, rows: Row[], edit: Edit | null, { sort, from = 0 }: { sort?: Sort; from?: number } = {}) => {
    const th = (c: string) => sort === undefined ? `<th class="${TH}" title="${esc(c)}">${esc(c)}${rz(c)}</th>`
      : `<th data-sort="${esc(c)}" title="${esc(c)} · click to sort" class="${TH} cursor-pointer select-none hover:text-zinc-100 ${sort?.col === c ? "!text-amber-300" : ""}"><span class="inline-flex max-w-full items-center gap-1"><span class="truncate">${esc(c)}</span>${sort?.col === c ? icon(sort.desc ? "arrowDown" : "arrowUp", "h-3 w-3 shrink-0") : ""}</span>${rz(c)}</th>`;
    const cols = rows.length ? Object.keys(rows[0]).filter((c) => c !== "__rowid") : [];
    const IN = "w-full min-w-0 bg-transparent px-2 py-1 font-mono text-[13px] outline-none focus:bg-amber-500/10";
    const editable = (c: string) => !!edit?.cols.has(c); // only columns traced back to a keyed table (expressions, ambiguous names stay read-only)
    const cell = (r: Row, c: string) => r[c] === null
      ? editable(c) ? `<td class="border-b border-r border-zinc-800/70 p-0"><input data-c="${esc(c)}" placeholder="NULL" class="${IN} placeholder:italic placeholder:text-zinc-600" /></td>`
        : `<td class="${TD} italic text-zinc-600">NULL</td>`
      : editable(c) ? `<td class="border-b border-r border-zinc-800/70 p-0"><input data-c="${esc(c)}" value="${esc(fmt(r[c]))}" title="${esc(fmt(r[c]))}" class="${IN} text-ellipsis" /></td>`
      : `<td class="${TD}" title="${esc(fmt(r[c]))}">${esc(fmt(r[c]))}</td>`;
    gridRows.set(el, rows);
    if (edit) gridEdit.set(el, edit); else gridEdit.delete(el);
    if (pending.delete(el)) pendUi(el); // ponytail: re-rendering (reload, page, sort, new run) drops staged edits without asking
    const ws = cols.map((c) => colW.get(wKey(el, c)) ?? fitW(rows.slice(0, 100), c, GRID_DEF));
    el.innerHTML = rows.length
      ? `<table class="border-collapse" style="table-layout:fixed;width:${40 + ws.reduce((a, b) => a + b, 0)}px"><colgroup><col style="width:40px">${ws.map((w) => `<col style="width:${w}px">`).join("")}</colgroup><thead><tr><th class="${TH} text-right">#</th>${cols.map(th).join("")}</tr></thead><tbody>${rows
          .map((r, i) => `<tr data-i="${i}" class="group odd:bg-zinc-900/40 hover:bg-zinc-800/60">
            <td class="border-b border-r border-zinc-800/70 px-1 text-right font-mono text-[11px] text-zinc-600">${from + i + 1}</td>${cols.map((c) => cell(r, c)).join("")}</tr>`)
          .join("")}</tbody></table>`
      : `<p class="py-10 text-center text-sm text-zinc-600">No rows</p>`;
  };
  /** Set column `c` (header cell `h`) of a grid to `w` px; the table's own width follows so nothing else shifts. */
  const setColW = (h: HTMLElement, w: number) => {
    const table = h.closest("table")!, grid = table.parentElement!, i = [...h.closest("tr")!.children].indexOf(h.closest("th")!);
    const col = table.querySelectorAll<HTMLElement>("col")[i], old = parseFloat(col.style.width);
    w = Math.round(Math.max(GRID_MIN, w));
    col.style.width = `${w}px`;
    table.style.width = `${parseFloat(table.style.width) + w - old}px`;
    colW.set(wKey(grid, h.dataset.rz!), w);
  };
  bc.addEventListener("pointerdown", (e) => {
    const h = (e.target as HTMLElement).closest<HTMLElement>("[data-rz]");
    if (!h || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = h.closest("th")!.offsetWidth;
    h.setPointerCapture(e.pointerId);
    h.onpointermove = (m) => setColW(h, w0 + m.clientX - x0);
    h.onpointerup = () => (h.onpointermove = null);
  });
  bc.addEventListener("dblclick", (e) => {
    const h = (e.target as HTMLElement).closest<HTMLElement>("[data-rz]");
    if (h) setColW(h, fitW(gridRows.get(h.closest("table")!.parentElement!) ?? [], h.dataset.rz!, GRID_FIT));
  });
  // a resize grip sits inside the header: don't let its click sort the column
  bc.addEventListener("click", (e) => (e.target as HTMLElement).closest("[data-rz]") && e.stopPropagation(), true);
  const download = (name: string, text: string | Uint8Array<ArrayBuffer>, type = "text/csv") => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(type === "text/csv" ? ["﻿", text] : [text], { type })); // BOM so Excel reads CSV as UTF-8 (Thai)
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // ----- connection tree -----
  const bcTree = () => {
    const f = $<HTMLInputElement>("#bc-tree-q").value.trim().toLowerCase();
    const row = (lvl: number, attrs: string, inner: string, cls = "") =>
      `<div ${attrs} style="padding-left:${0.25 + lvl * 1}rem" class="group flex cursor-pointer select-none items-center gap-1.5 rounded-md py-1 pr-1.5 hover:bg-zinc-800 ${cls}">${inner}</div>`;
    const SEL = "bg-amber-500/15 text-amber-200";
    // child rows carry data-in = their connection id, so a click there first selects that connection
    const tables = (lvl: number, s: Sess, id: number) => {
      const ts = s.objs.filter((o) => String(o.name).toLowerCase().includes(f));
      return ts.map((o) => row(lvl, `data-t="${esc(o.name)}" data-in="${id}" title="${esc(o.name)}"`,
        `<span class="w-3"></span><span class="${o.type === "view" ? "text-sky-400" : "text-emerald-400"}">${icon(o.type === "view" ? "grid" : "table", "h-3.5 w-3.5")}</span><span class="truncate">${esc(o.name)}</span>`,
        id === bcCid && o.name === bcTable ? SEL : "")).join("")
        || `<p style="padding-left:${1.5 + lvl}rem" class="py-1 text-xs text-zinc-600">${f ? "No match" : "No tables"}</p>`;
    };
    $("#bc-tree").innerHTML = dbConns.map((c) => {
      const s = sess(c.id), cur = bcOn && c.id === bcCid, open = !!s && !s.collapsed, k = kindOf(c);
      let html = row(0, `data-cid="${c.id}" title="${esc(c.url)}${s && !cur ? " · click to use" : ""}"`,
        `${bcConnecting === c.id ? spinner("h-3 w-3") : caret(open)}${badge(k, !!s)}<span class="min-w-0 flex-1 truncate ${cur ? "font-semibold text-zinc-100" : s ? "text-zinc-200" : ""}">${esc(c.name)}</span>
         ${s ? `<span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>` : ""}`, cur ? "bg-zinc-800/70" : "");
      if (!s || !open) return html;
      if (s.d === "sqlite") return html + tables(1, s, c.id);
      for (const n of s.dbList) {
        const on = n === s.curDb, show = on && (s.dbOpen || !!f); // a filter unfolds the current database
        html += row(1, `data-db="${esc(n)}" data-in="${c.id}"`, `${caret(show)}<span class="text-amber-400">${icon("database", "h-3.5 w-3.5")}</span><span class="truncate ${on ? "text-zinc-100" : "text-zinc-400"}">${esc(n)}</span>`);
        if (show) html += tables(2, s, c.id);
      }
      return html;
    }).join("") || `<div class="px-3 py-6 text-center text-xs text-zinc-500">No connections yet<br><button id="bc-first" class="mt-3 rounded-lg bg-amber-500 px-3 py-1.5 font-medium text-black hover:bg-amber-400">+ New Connection</button></div>`;
    document.getElementById("bc-first")?.addEventListener("click", () => bcEdit());
  };
  $("#bc-tree-q").oninput = bcTree;
  const bcList = async () => {
    dbConns = await db.select<DbConn[]>("SELECT * FROM db_conns ORDER BY name");
    bcQBar();
    bcTree();
    if (bcV === "main") bcMain();
  };
  $("#bc-tree").onclick = async (e) => {
    const t = e.target as HTMLElement;
    const tb_ = t.closest<HTMLElement>("[data-t]"), dbr = t.closest<HTMLElement>("[data-db]"), cr = t.closest<HTMLElement>("[data-cid]");
    const owner = +(t.closest<HTMLElement>("[data-in]")?.dataset.in ?? 0);
    if (owner) bcActivate(owner); // no-op if it's already the selected one
    if (tb_) return bcLoad(tb_.dataset.t!);
    if (dbr) return dbr.dataset.db === bcCurDb ? ((bcDbOpen = !bcDbOpen), bcTree()) : bcConnect(withDb(bcUrl, dbr.dataset.db!), bcCid, true);
    const c = dbConns.find((x) => x.id === +cr?.dataset.cid!);
    if (!c) return;
    if (c.id === bcCid && bcOn) return (bcCollapsed = !bcCollapsed), bcTree();
    bcOpenConn(c).finally(bcQBar); // open → just selects it; closed → connects (others stay open)
  };
  const bcDelConn = async (c: DbConn) => {
    if (!(await confirmBox("Delete connection?", c.name, "Delete"))) return;
    if (isOpen(c.id)) await bcDisconnect(c.id);
    await db.execute("DELETE FROM db_conns WHERE id=$1", [c.id]);
    await invoke("del_secret", { id: dbSecret(c.id) });
    bcList();
  };
  const bcOpenConn = async (c: DbConn) => {
    if (isOpen(c.id)) return bcActivate(c.id);
    let pw = await invoke<string>("get_secret", { id: dbSecret(c.id) });
    if (!pw && kindOf(c) !== "sqlite") {
      const p = await askPw(c.name);
      if (p === null) return;
      pw = p;
    }
    return bcConnect(withPw(c.url, pw), c.id);
  };

  // ----- right-click menus (shared contextMenu) -----
  const tableMenu = (name: string): MenuItem[] => [
    ["Open Table", "table", () => bcLoad(name)],
    ["Design Table", "list", () => bcLoad(name, "struct")],
    ["ER Diagram", "network", () => bcLoad(name, "er")],
    ["Query Table", "code", () => (bcEditor.newTab(`SELECT * FROM ${qid(bcD, name)} LIMIT 100;`), bcView("query"))],
    ...exportItems(name, tableRows(name), "Export "),
    ["Copy Name", "file", () => navigator.clipboard.writeText(name)],
    ["Empty Table", "x", () => bcTruncate(name)],
    ["Delete Table", "trash", () => bcDrop(name)],
  ];
  $("#bc-tree").oncontextmenu = (e) => {
    const t = e.target as HTMLElement, tr = t.closest<HTMLElement>("[data-t]"), dbr = t.closest<HTMLElement>("[data-db]");
    const c = dbConns.find((x) => x.id === +t.closest<HTMLElement>("[data-cid]")?.dataset.cid!);
    const owner = +(t.closest<HTMLElement>("[data-in]")?.dataset.in ?? 0);
    if (owner) bcActivate(owner);
    if (tr) return contextMenu(e, tableMenu(tr.dataset.t!));
    if (dbr) {
      const name = dbr.dataset.db!, cur = name === bcCurDb;
      return contextMenu(e, [
        cur ? ["Refresh", "refresh", () => $("#bc-refresh").click()] : ["Open Database", "database", () => bcConnect(withDb(bcUrl, name), bcCid, true)],
        ["Copy Name", "file", () => navigator.clipboard.writeText(name)],
      ]);
    }
    if (!c) return e.preventDefault();
    connMenu(e, c);
  };
  const connMenu = (e: MouseEvent, c: DbConn) => {
    const on = isOpen(c.id);
    contextMenu(e, [
      on ? ["Close Connection", "unplug", () => bcDisconnect(c.id).then(() => void (bcV === "main" && bcMain()))] : ["Open Connection", "plug", () => bcOpenConn(c)],
      ...(on ? [["New Query", "code", () => (bcActivate(c.id), bcEditor.newTab(""), bcView("query"))] as MenuItem] : []),
      ["Edit Connection…", "pencil", () => bcEdit(c)],
      ["Delete Connection", "trash", () => bcDelConn(c)],
    ]);
  };
  $("#bc-objects").oncontextmenu = (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>("[data-o]");
    if (!r) return e.preventDefault();
    bcSel = r.dataset.o!;
    bcDrawObjects();
    contextMenu(e, tableMenu(bcSel));
  };
  const cellMenu = (e: MouseEvent, grid: HTMLElement) => {
    const t = e.target as HTMLElement, td = t.closest("td"), tr = t.closest("tr");
    if (!td || !tr || !tr.closest("tbody")) return e.preventDefault();
    const inp = td.querySelector<HTMLInputElement>("input[data-c]");
    const val = inp ? inp.value : td.textContent ?? "";
    const rowCsv = () => [...tr.querySelectorAll("td")].slice(1).map((c) => c.querySelector("input")?.value ?? c.textContent ?? "").join(",");
    contextMenu(e, [
      ["Copy Value", "file", () => navigator.clipboard.writeText(val)],
      ["Copy Row", "table", () => navigator.clipboard.writeText(rowCsv())],
      ...(inp && cellSrc(grid, inp) ? [
        ["Set NULL", "x", () => saveCell(grid, inp, null)] as MenuItem,
        [`Delete Row from ${cellSrc(grid, inp)!.src.t}`, "trash", () => bcDelRow(grid, inp)] as MenuItem,
      ] : []),
    ]);
  };
  /** The edit target of an input cell: connection, source table/column, row object and that row's key values. */
  const cellSrc = (grid: HTMLElement, i: HTMLInputElement) => {
    const ed = gridEdit.get(grid), tr = i.closest("tr")!, r = gridRows.get(grid)?.[Number(tr.dataset.i)], src = ed?.cols.get(i.dataset.c!);
    return ed && r && src ? { ed, r, tr, src, key: src.keys.map(([, n]) => r[n]), keyCols: src.keys.map(([k]) => k) } : null;
  };
  // Cell edits are staged (highlighted) and only written when Update is pressed; Discard puts the old values back.
  const DIRTY = "!bg-amber-500/25";
  const shown = (v: unknown) => (v === null ? "" : fmt(v));
  const pendUi = (g: HTMLElement) => {
    const n = pending.get(g)?.size ?? 0, p = ({ "bc-grid": "bc-d", "bc-qgrid": "bc-q", "bc-bgrid": "bc-b" } as Record<string, string>)[g.id];
    $(`#${p}-pend`).classList.toggle("hidden", !n);
    $(`#${p}-pend`).classList.toggle("flex", !!n);
    $(`#${p}-n`).textContent = String(n);
  };
  const saveCell = (g: HTMLElement, i: HTMLInputElement, v: string | null) => {
    const x = cellSrc(g, i);
    if (!x) return;
    const was = x.r[i.dataset.c!], same = v === null ? was === null : shown(was) === v;
    const m = pending.get(g) ?? new Map<HTMLInputElement, string | null>();
    pending.set(g, m);
    if (same) m.delete(i); else m.set(i, v);
    i.value = v ?? "";
    i.classList.toggle(DIRTY, !same);
    i.classList.remove("text-emerald-300");
    pendUi(g);
  };
  /** Write staged cells in order. A row object is updated after each write, so a changed key column addresses the
   * row by its new value for the next cell. Stops at the first error; what's left stays staged. */
  const applyEdits = async (g: HTMLElement) => {
    const m = pending.get(g);
    if (!m?.size) return;
    let n = 0;
    bcBusy(1);
    for (const [i, v] of [...m]) {
      const x = cellSrc(g, i), c = i.dataset.c!;
      if (!x) { m.delete(i); continue; }
      try {
        await x.ed.db.execute(updateSql(x.ed.d, x.src.t, x.src.col, x.keyCols), [v, ...x.key].map((a) => arg(x.ed.d, a)));
        x.r[c] = v;
        m.delete(i);
        i.classList.remove(DIRTY);
        i.classList.add("text-emerald-300");
        n++;
      } catch (err) { bcMsg(`${x.src.t}.${x.src.col.name}: ${err}`, true); break; }
    }
    bcBusy(-1);
    pendUi(g);
    if (!m.size) bcMsg(`Updated ${n} cell${n === 1 ? "" : "s"}`);
  };
  const discardEdits = (g: HTMLElement) => {
    for (const i of pending.get(g)?.keys() ?? []) {
      const x = cellSrc(g, i);
      if (x) i.value = shown(x.r[i.dataset.c!]);
      i.classList.remove(DIRTY);
    }
    pending.delete(g);
    pendUi(g);
  };
  for (const [g, p] of [[$("#bc-grid"), "bc-d"], [$("#bc-qgrid"), "bc-q"], [$("#bc-bgrid"), "bc-b"]] as const) {
    g.oncontextmenu = (e) => cellMenu(e, g);
    g.addEventListener("change", (e) => { const i = e.target as HTMLInputElement; if (i.dataset.c) saveCell(g, i, i.value); });
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (e.target as HTMLElement).blur();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") (e.preventDefault(), (e.target as HTMLElement).blur(), void applyEdits(g));
    });
    $(`#${p}-apply`).onclick = () => void applyEdits(g);
    $(`#${p}-discard`).onclick = () => discardEdits(g);
  }

  // ----- objects / table data -----
  const bcObjects = async () => {
    bcObjs = await bcDb.select<Row[]>(objectsSql(bcD));
    bcErDirty = true;
    if (bcV === "er") bcEr();
    bcDrawObjects();
    bcTree();
  };
  const bcDrawObjects = () => {
    const f = $<HTMLInputElement>("#bc-o-q").value.trim().toLowerCase();
    const rows = bcObjs.filter((o) => String(o.name).toLowerCase().includes(f));
    const cols = bcObjs.length ? Object.keys(bcObjs[0]) : ["name"];
    $("#bc-objects").innerHTML = rows.length
      ? `<table class="min-w-full border-collapse text-sm"><thead><tr>${cols.map((c) => `<th class="${TH} capitalize">${esc(c.replace(/_/g, " "))}</th>`).join("")}</tr></thead><tbody>${rows.map((o) =>
          `<tr data-o="${esc(o.name)}" title="Double-click to open" class="cursor-default select-none hover:bg-zinc-800/60 ${o.name === bcSel ? "!bg-amber-500/15" : ""}">${cols.map((c, i) =>
            i === 0 ? `<td class="${TD} font-sans"><span class="flex items-center gap-2"><span class="${o.type === "view" ? "text-sky-400" : "text-emerald-400"}">${icon(o.type === "view" ? "grid" : "table", "h-4 w-4")}</span>${esc(o.name)}</span></td>`
            : `<td class="${TD} text-zinc-400">${esc(fmt(o[c]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : `<p class="py-16 text-center text-sm text-zinc-600">${bcOn ? (f ? "No match" : "No tables in this database") : "Pick a connection on the left, or create one with Connection"}</p>`;
    for (const id of ["#bc-o-open", "#bc-o-design", "#bc-o-trunc", "#bc-o-drop", "#bc-o-csv"]) $<HTMLButtonElement>(id).disabled = !bcSel;
    $<HTMLButtonElement>("#bc-o-new").disabled = !bcOn;
  };
  $("#bc-o-q").oninput = bcDrawObjects;
  $("#bc-objects").onclick = (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>("[data-o]");
    bcSel = r?.dataset.o ?? "";
    bcDrawObjects();
  };
  $("#bc-objects").ondblclick = (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>("[data-o]");
    if (r) bcLoad(r.dataset.o!);
  };
  $("#bc-o-open").onclick = () => bcSel && bcLoad(bcSel);
  $("#bc-o-design").onclick = () => bcSel && bcLoad(bcSel, "struct");
  $("#bc-o-trunc").onclick = () => bcSel && bcTruncate(bcSel);
  $("#bc-o-drop").onclick = () => bcDrop(bcSel);
  const bcTruncate = async (name: string) => {
    if (!(await confirmBox("Empty table?", `Delete every row in ${name} — this cannot be undone.`, "Empty"))) return;
    try {
      await bcDb.execute(truncateSql(bcD, name));
      bcMsg(`Emptied ${name}`);
      if (bcTable === name) bcLoad(name);
    } catch (err) { bcMsg(String(err), true); }
  };

  // ----- New Table form: column rows -> CREATE TABLE (preview kept in sync) -----
  const ntDlg = $<HTMLDialogElement>("#bc-nt"), ntForm = $<HTMLFormElement>("#bc-nt-form"), ntCols = $("#bc-nt-cols");
  const TYPES: Record<Dialect, string[]> = {
    sqlite: ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB"],
    postgres: ["bigint", "integer", "text", "varchar(255)", "boolean", "numeric(12,2)", "timestamptz", "date", "uuid", "jsonb"],
    mysql: ["BIGINT", "INT", "VARCHAR(255)", "TEXT", "TINYINT(1)", "DECIMAL(12,2)", "DATETIME", "DATE", "JSON"],
  };
  const CHK = "h-4 w-4 justify-self-center accent-amber-500";
  const ntRow = (c: Partial<NewCol> = {}) => ntCols.insertAdjacentHTML("beforeend", `<div data-row class="contents">
    <input data-f="name" required value="${esc(c.name ?? "")}" placeholder="column" class="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono outline-none focus:border-amber-500" />
    <input data-f="type" required list="bc-types" value="${esc(c.type ?? TYPES[bcD][1])}" class="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono outline-none focus:border-amber-500" />
    <input data-f="pk" type="checkbox" ${c.pk ? "checked" : ""} class="${CHK}" /><input data-f="nn" type="checkbox" ${c.nn ? "checked" : ""} class="${CHK}" />
    <input data-f="auto" type="checkbox" ${c.auto ? "checked" : ""} class="${CHK}" />
    <input data-f="def" placeholder="none" class="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono outline-none focus:border-amber-500" />
    <button type="button" data-del title="Remove column" class="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400">${icon("x", "h-3.5 w-3.5")}</button></div>`);
  const ntRead = (): NewCol[] => [...ntCols.querySelectorAll("[data-row]")].map((r) => {
    const f = (n: string) => r.querySelector<HTMLInputElement>(`[data-f="${n}"]`)!;
    return { name: f("name").value.trim(), type: f("type").value.trim(), pk: f("pk").checked, nn: f("nn").checked, auto: f("auto").checked, def: f("def").value };
  });
  const ntName = () => (ntForm.elements.namedItem("table") as HTMLInputElement).value.trim();
  const ntSql = () => createSql(bcD, ntName() || "new_table", ntRead());
  const ntPreview = () => void ($("#bc-nt-sql").textContent = ntSql() + ";");
  ntForm.addEventListener("input", ntPreview);
  ntCols.onclick = (e) => {
    const del = (e.target as HTMLElement).closest("[data-del]");
    if (del) (del.closest("[data-row]")!.remove(), ntPreview());
  };
  $("#bc-nt-add").onclick = () => (ntRow(), ntPreview(), ntCols.querySelector<HTMLInputElement>("[data-row]:last-child [data-f=name]")?.focus());
  $("#bc-nt-cancel").onclick = () => ntDlg.close();
  $("#bc-nt-query").onclick = () => (bcEditor.newTab(ntSql() + ";"), ntDlg.close(), bcView("query"));
  $("#bc-o-new").onclick = () => {
    ntForm.reset();
    ntCols.innerHTML = "";
    $("#bc-types").innerHTML = TYPES[bcD].map((t) => `<option value="${t}">`).join("");
    ntRow({ name: "id", type: TYPES[bcD][0], pk: true, nn: true, auto: true });
    ntRow({ name: "name", type: bcD === "sqlite" ? "TEXT" : bcD === "postgres" ? "text" : "VARCHAR(255)", nn: true });
    $("#bc-nt-msg").textContent = "";
    ntPreview();
    ntDlg.showModal();
  };
  ntForm.onsubmit = async (e) => {
    e.preventDefault();
    if (!ntRead().length) return void ($("#bc-nt-msg").textContent = "Add at least one column");
    try {
      await bcDb.execute(ntSql());
      const name = ntName();
      ntDlg.close();
      bcMsg(`Created ${name}`);
      await bcObjects();
      bcSchema();
      bcLoad(name, "struct");
    } catch (err) { $("#bc-nt-msg").textContent = String(err); }
  };
  const bcDrop = async (name: string) => {
    const o = bcObjs.find((x) => x.name === name);
    if (!o) return;
    const kind = String(o.type ?? "table").toUpperCase();
    if (!(await confirmBox(`Delete ${kind.toLowerCase()}?`, `DROP ${kind} ${name} — this cannot be undone.`, "Delete"))) return;
    try {
      await bcDb.execute(`DROP ${kind} ${qid(bcD, name)}`);
      bcMsg(`Dropped ${name}`);
      if (bcTable === name) bcCloseData();
      if (bcSel === name) bcSel = "";
      await bcObjects();
      bcSchema();
    } catch (err) { bcMsg(String(err), true); }
  };
  /** Export as Excel / CSV / JSON; `get` fetches the rows once a format is picked. */
  const exportItems = (name: string, get: () => Promise<Row[]>, prefix = ""): MenuItem[] => {
    const go = (ext: string, conv: (r: Row[]) => string | Uint8Array<ArrayBuffer>, type: string) => async () => {
      try {
        const rows = await get();
        download(`${name}.${ext}`, conv(rows), type);
        bcMsg(`Exported ${rows.length} row(s) to ${name}.${ext}`);
      } catch (err) { bcMsg(String(err), true); }
    };
    return [
      [`${prefix}Excel (.xlsx)`, "table", go("xlsx", toXlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")],
      [`${prefix}CSV`, "download", go("csv", toCsv, "text/csv")],
      [`${prefix}JSON`, "code", go("json", (rows) => JSON.stringify(rows.map(({ __rowid, ...o }) => o), null, 2), "application/json")],
    ];
  };
  /** Drop the format menu under the clicked Export button. */
  const exportMenu = (e: MouseEvent, name: string, get: () => Promise<Row[]>) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    contextMenu(Object.assign(e, { clientX: r.left, clientY: r.bottom + 4 }), exportItems(name, get));
  };
  const tableRows = (t: string) => () => bcDb.select<Row[]>(`SELECT * FROM ${qid(bcD, t)}`);
  $("#bc-o-csv").onclick = (e) => bcSel && exportMenu(e, bcSel, tableRows(bcSel));
  $("#bc-d-csv").onclick = (e) => bcTable && exportMenu(e, bcTable, tableRows(bcTable));
  $("#bc-q-csv").onclick = (e) => (bcQRows.length ? exportMenu(e, "query", async () => bcQRows) : bcMsg("Run a SELECT first", true));
  $("#bc-b-csv").onclick = (e) => { const rows = gridRows.get($("#bc-bgrid")) ?? []; if (rows.length) exportMenu(e, "query", async () => rows); else bcMsg("Run the builder first", true); };

  const dataTab = () => $("#bc-views").querySelector<HTMLElement>('[data-v="data"]')!;
  const bcCloseData = () => {
    bcTable = "";
    dataTab().classList.add("hidden");
    bcView("objects");
    bcStatus();
  };
  // Data grid state for the open table: WHERE filter, sort column, page. Kept across reloads of the same table.
  const PAGE = 500;
  type Mode = "grid" | "struct" | "er";
  let bcWhere = "", bcSort: Sort = null, bcPage = 0, bcTotal = 0, bcMode: Mode = "grid";
  const bcSetMode = (m: Mode) => {
    bcMode = m;
    $("#bc-d-mode").querySelectorAll<HTMLElement>("[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    bc.querySelectorAll<HTMLElement>("[data-mo]").forEach((s) => (s.classList.toggle("hidden", s.dataset.mo !== m), s.classList.toggle("flex", s.dataset.mo === m)));
    $("#bc-grid").classList.toggle("hidden", m !== "grid");
    $("#bc-struct").classList.toggle("hidden", m !== "struct");
    $("#bc-ter").classList.toggle("hidden", m !== "er");
  };
  $("#bc-d-mode").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-m]");
    if (b && bcTable) bcLoad(bcTable, b.dataset.m as Mode);
  };
  const bcLoad = async (t: string, mode: Mode = bcMode): Promise<void> => {
    if (t !== bcTable) (bcWhere = ""), (bcSort = null), (bcPage = 0), ($<HTMLInputElement>("#bc-filter").value = "");
    bcTable = t;
    bcSel = t;
    bcStale = false;
    dataTab().classList.remove("hidden");
    dataTab().querySelector("span")!.textContent = t;
    bcSetMode(mode);
    bcView("data");
    bcTree();
    bcStatus();
    const el = $(mode === "grid" ? "#bc-grid" : mode === "struct" ? "#bc-struct" : "#bc-ter");
    loading(el, `Loading ${t}…`);
    $<HTMLButtonElement>("#bc-add").disabled = true;
    bcBusy(1);
    try {
      bcCols = await bcDb.select<Col[]>(...structSql(bcD, t));
      bcKeys = bcD === "sqlite" ? [{ name: "rowid", type: "", pk: true }] : bcCols.filter((c) => Number(c.pk));
      if (mode === "struct") return await bcStruct();
      if (mode === "er") return await bcTableEr();
      const [rows, cnt] = await Promise.all([
        bcDb.select<Row[]>(selectSql(bcD, t, { where: bcWhere, sort: bcSort, limit: PAGE, offset: bcPage * PAGE })),
        bcDb.select<{ n: unknown }[]>(countSql(bcD, t, bcWhere)),
      ]);
      bcTotal = Number(cnt[0]?.n ?? rows.length);
      if (!rows.length && bcPage > 0) return (bcPage = Math.max(0, Math.ceil(bcTotal / PAGE) - 1)), await bcLoad(t, mode); // rows deleted past the end
      bcDataRows = rows;
      const from = bcPage * PAGE;
      bcGrid($("#bc-grid"), bcDataRows, bcKeys.length ? { db: bcDb, d: bcD, cols: new Map(bcCols.map((col) => [col.name, { t, col, keys: bcKeys.map((k): [Col, string] => [k, k.name === "rowid" ? "__rowid" : k.name]) }])) } : null, { sort: bcSort, from });
      $("#bc-page").textContent = bcTotal ? `${from + 1}–${from + rows.length} of ${bcTotal}` : "0 rows";
      $<HTMLButtonElement>("#bc-prev").disabled = bcPage === 0;
      $<HTMLButtonElement>("#bc-next").disabled = from + rows.length >= bcTotal;
      $<HTMLButtonElement>("#bc-add").disabled = false;
      bcMsg(`${t}: ${bcTotal} row(s)${bcWhere.trim() ? " matching filter" : ""}${bcKeys.length ? "" : " · no primary key, read-only"}`);
    } catch (e) { bcMsg(String(e), true); el.innerHTML = ""; } finally { bcBusy(-1); }
  };
  $("#bc-prev").onclick = () => bcPage > 0 && (bcPage--, bcLoad(bcTable));
  $("#bc-next").onclick = () => (bcPage++, bcLoad(bcTable));
  $("#bc-filter").onkeydown = (e) => {
    const i = e.target as HTMLInputElement;
    if (e.key === "Escape") i.value = "";
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault();
    (bcWhere = i.value), (bcPage = 0);
    bcLoad(bcTable);
  };
  // header click: ascending → descending → unsorted
  $("#bc-grid").addEventListener("click", (e) => {
    const h = (e.target as HTMLElement).closest<HTMLElement>("th[data-sort]");
    if (!h) return;
    const c = h.dataset.sort!;
    bcSort = bcSort?.col !== c ? { col: c, desc: false } : bcSort.desc ? null : { col: c, desc: true };
    bcPage = 0;
    bcLoad(bcTable);
  });

  // ----- Structure: columns / indexes / foreign keys; changes go to a query tab as ALTER statements to review and run -----
  let bcIdx: Row[] = [];
  const yes = (v: unknown) => (v === true || v === 1 || v === "1" || v === "t" ? "YES" : "");
  const bcStruct = async () => {
    const [isql, iargs] = indexSql(bcD, bcTable);
    const [idx, fks] = await Promise.all([
      bcDb.select<Row[]>(isql, iargs).catch(() => [] as Row[]),
      bcDb.select<{ t: string; c: string; rt: string; rc: string | null }[]>(fksSql(bcD)).catch(() => []),
    ]);
    bcIdx = idx;
    const mine = fks.filter((f) => f.t === bcTable || f.rt === bcTable)
      .map((f) => ({ column: `${f.t}.${f.c}`, references: `${f.rt}.${f.rc ?? "(primary key)"}`, direction: f.t === bcTable ? "outgoing" : "incoming" }));
    const sec = (id: string, title: string, n: number) =>
      `<h3 class="sticky left-0 flex items-center gap-2 px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">${title}<span class="rounded bg-zinc-800 px-1.5 font-mono text-zinc-400">${n}</span></h3><div id="${id}"></div>`;
    const el = $("#bc-struct");
    el.innerHTML = sec("bc-s-cols", "Columns", bcCols.length) + sec("bc-s-idx", "Indexes", idx.length) + sec("bc-s-fks", "Foreign keys", mine.length);
    const cols = (bcCols as (Col & Row)[]).map(({ name, type, nullable, default: def, pk, ...rest }) =>
      ({ key: Number(pk) ? "PK" : "", name, type, "not null": yes(nullable) ? "" : "YES", default: def, ...rest }));
    bcGrid($("#bc-s-cols"), cols, null);
    bcGrid($("#bc-s-idx"), idx, null);
    bcGrid($("#bc-s-fks"), mine, null);
    bcMsg(`${bcTable}: ${bcCols.length} column(s), ${idx.length} index(es) · right-click a column or index to change it`);
  };
  // ----- ER diagram: one box per table (draggable), FK lines drawn column-to-column in an SVG underlay -----
  // Two places use it: the ER Diagram view (whole database, masonry) and a table's ER mode (that table + its direct relations).
  const ER_W = 230, ER_GAP = 56;
  type Fk = { t: string; c: string; rt: string; rc: string | null };
  const erFks = new WeakMap<HTMLElement, Fk[]>(); // per canvas
  const erDraw = (cv: HTMLElement) => {
    const boxes = [...cv.querySelectorAll<HTMLElement>("[data-er]")];
    const box = (n: string) => cv.querySelector<HTMLElement>(`[data-er="${CSS.escape(n)}"]`);
    const w = Math.max(0, ...boxes.map((b) => b.offsetLeft + ER_W)) + ER_GAP, h = Math.max(0, ...boxes.map((b) => b.offsetTop + b.offsetHeight)) + ER_GAP;
    (cv.style.width = `${w}px`), (cv.style.height = `${h}px`);
    const rowY = (b: HTMLElement, c: string | null) => {
      const r = c ? b.querySelector<HTMLElement>(`[data-c="${CSS.escape(c)}"]`) : b.querySelector<HTMLElement>("[data-pk]");
      return b.offsetTop + (r ? r.offsetTop + r.offsetHeight / 2 : 14);
    };
    cv.querySelector("svg")!.innerHTML = (erFks.get(cv) ?? []).map((f) => {
      const a = box(f.t), b = box(f.rt);
      if (!a || !b) return "";
      const ay = rowY(a, f.c), by = rowY(b, f.rc), ac = a.offsetLeft + ER_W / 2, bcx = b.offsetLeft + ER_W / 2;
      // overlapping columns (or self-reference): loop out on the right; otherwise leave from the facing sides
      const [ax, bx, c1, c2] = Math.abs(ac - bcx) < ER_W ? [a.offsetLeft + ER_W, b.offsetLeft + ER_W, a.offsetLeft + ER_W + 40, b.offsetLeft + ER_W + 40]
        : bcx > ac ? [a.offsetLeft + ER_W, b.offsetLeft, a.offsetLeft + ER_W + 50, b.offsetLeft - 50]
        : [a.offsetLeft, b.offsetLeft + ER_W, a.offsetLeft - 50, b.offsetLeft + ER_W + 50];
      return `<path d="M${ax},${ay} C${c1},${ay} ${c2},${by} ${bx},${by}" fill="none" stroke="currentColor" stroke-width="1.5"><title>${esc(`${f.t}.${f.c} → ${f.rt}.${f.rc ?? "pk"}`)}</title></path><circle cx="${bx}" cy="${by}" r="3" fill="currentColor"/>`;
    }).join("");
  };
  /** Draw into `el`: every table, or with `focus` only that table (middle), tables pointing at it (left) and tables it points at (right). */
  const erRender = async (el: HTMLElement, focus?: string) => {
    const [sch, all] = await Promise.all([
      bcDb.select<{ t: string; c: string; ty: string }[]>(schemaSql(bcD)),
      bcDb.select<Fk[]>(fksSql(bcD)).catch(() => [] as Fk[]),
    ]);
    const tables = new Map<string, { c: string; ty: string }[]>();
    for (const r of sch) (tables.get(r.t) ?? tables.set(r.t, []).get(r.t)!).push(r);
    let fks = all;
    const pos = new Map<string, [number, number]>();
    const height = (t: string) => 30 + (tables.get(t)?.length ?? 0) * 22 + ER_GAP;
    if (focus) {
      const outs = [...new Set(all.filter((f) => f.t === focus && f.rt !== focus).map((f) => f.rt))];
      const ins = [...new Set(all.filter((f) => f.rt === focus && f.t !== focus).map((f) => f.t))].filter((t) => !outs.includes(t));
      const keep = new Set([focus, ...outs, ...ins]);
      fks = all.filter((f) => keep.has(f.t) && keep.has(f.rt));
      [ins, [focus], outs].forEach((col, i) => { let y = ER_GAP; for (const t of col) (pos.set(t, [ER_GAP + i * (ER_W + ER_GAP * 2), y]), (y += height(t))); });
    } else {
      // masonry: each table goes into the currently shortest of ~√n columns
      const colH = Array(Math.max(1, Math.ceil(Math.sqrt(tables.size)))).fill(ER_GAP);
      for (const t of tables.keys()) { const i = colH.indexOf(Math.min(...colH)); pos.set(t, [ER_GAP + i * (ER_W + ER_GAP), colH[i]]); colH[i] += height(t); }
    }
    const fkCol = new Set(fks.map((f) => `${f.t}\0${f.c}`)), refCol = new Set(fks.map((f) => `${f.rt}\0${f.rc}`));
    el.innerHTML = `<div data-er-canvas class="relative"><svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-amber-500/60"></svg>${[...pos].map(([t, [x, y]]) => {
      const cs = tables.get(t) ?? [], me = t === focus;
      return `<div data-er="${esc(t)}" style="left:${x}px;top:${y}px;width:${ER_W}px" class="absolute overflow-hidden rounded-lg border ${me ? "border-amber-500" : "border-zinc-700"} bg-zinc-900 text-xs shadow-lg shadow-black/30">
        <div data-er-head title="Drag to move · double-click to open" class="flex h-[30px] cursor-move select-none items-center gap-1.5 border-b border-zinc-700 ${me ? "bg-amber-500/15" : "bg-zinc-800"} px-2 font-semibold text-zinc-100"><span class="text-emerald-400">${icon("table", "h-3.5 w-3.5")}</span><span class="truncate">${esc(t)}</span></div>
        ${cs.map(({ c, ty }) => `<div data-c="${esc(c)}" ${refCol.has(`${t}\0${c}`) ? "data-pk" : ""} class="flex h-[22px] items-center gap-1.5 px-2 font-mono">
          <span class="w-3 shrink-0 ${fkCol.has(`${t}\0${c}`) ? "text-amber-400" : "text-sky-400"}">${fkCol.has(`${t}\0${c}`) || refCol.has(`${t}\0${c}`) ? icon("key", "h-3 w-3") : ""}</span>
          <span class="truncate text-zinc-200">${esc(c)}</span><span class="ml-auto truncate pl-2 text-[11px] text-zinc-500">${esc(ty)}</span></div>`).join("")}</div>`;
    }).join("")}</div>`;
    const cv = el.querySelector<HTMLElement>("[data-er-canvas]")!;
    erFks.set(cv, fks);
    erDraw(cv);
    return { tables: pos.size, fks: fks.length };
  };
  const bcEr = async () => {
    const el = $("#bc-er");
    if (!bcOn) return void (el.innerHTML = `<p class="py-16 text-center text-sm text-zinc-600">Connect to a database to see its tables and relations</p>`);
    bcErDirty = false;
    loading(el, "Drawing diagram…");
    bcBusy(1);
    try {
      const n = await erRender(el);
      bcMsg(`ER diagram: ${n.tables} table(s), ${n.fks} foreign key column(s)`);
    } catch (err) { bcMsg(String(err), true); el.innerHTML = ""; } finally { bcBusy(-1); }
  };
  /** Table ER mode: the open table and the tables it is linked to by foreign keys. */
  const bcTableEr = async () => {
    const n = await erRender($("#bc-ter"), bcTable);
    bcMsg(n.tables > 1 ? `${bcTable}: ${n.tables - 1} related table(s) · left = refers to ${bcTable}, right = ${bcTable} refers to` : `${bcTable} has no foreign keys to or from other tables`);
  };
  for (const host of [$("#bc-er"), $("#bc-ter")]) {
    host.onpointerdown = (e) => {
      const head = (e.target as HTMLElement).closest<HTMLElement>("[data-er-head]");
      if (!head || e.button !== 0) return;
      const box = head.parentElement!, cv = box.parentElement!, x0 = e.clientX - box.offsetLeft, y0 = e.clientY - box.offsetTop;
      box.style.zIndex = "10";
      head.setPointerCapture(e.pointerId);
      head.onpointermove = (m) => ((box.style.left = `${Math.max(0, m.clientX - x0)}px`), (box.style.top = `${Math.max(0, m.clientY - y0)}px`), erDraw(cv));
      head.onpointerup = () => ((head.onpointermove = null), (box.style.zIndex = ""));
    };
    host.ondblclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-er]");
      if (b) bcLoad(b.dataset.er!, "grid");
    };
  }
  $("#bc-er-redraw").onclick = () => bcEr();

  const alterTab = (sql: string) => (bcEditor.newTab(sql), bcView("query"), (bcStale = true));
  $("#bc-s-addcol").onclick = () => alterTab(`ALTER TABLE ${qid(bcD, bcTable)} ADD COLUMN ${qid(bcD, "new_column")} ${TYPES[bcD][1]};`);
  $("#bc-struct").oncontextmenu = (e) => {
    const t = e.target as HTMLElement, tr = t.closest("tbody tr"), sec = t.closest("#bc-s-cols, #bc-s-idx");
    if (!tr || !sec) return e.preventDefault();
    const q = qid(bcD, bcTable), i = [...tr.parentElement!.children].indexOf(tr);
    if (sec.id === "bc-s-idx") {
      const n = String(bcIdx[i]?.name ?? "");
      return contextMenu(e, [
        ["Drop Index", "trash", () => alterTab(`DROP INDEX ${qid(bcD, n)}${bcD === "mysql" ? ` ON ${q}` : ""};`)],
        ["Copy Name", "file", () => navigator.clipboard.writeText(n)],
      ]);
    }
    const c = bcCols[i];
    if (!c) return e.preventDefault();
    const cq = qid(bcD, c.name);
    contextMenu(e, [
      ["Rename Column…", "pencil", () => alterTab(`ALTER TABLE ${q} RENAME COLUMN ${cq} TO ${qid(bcD, `${c.name}_new`)};`)],
      ...(bcD === "sqlite" ? [] : [["Change Type…", "code", () => alterTab(bcD === "postgres"
        ? `ALTER TABLE ${q} ALTER COLUMN ${cq} TYPE ${c.type};`
        : `ALTER TABLE ${q} MODIFY COLUMN ${cq} ${c.type};`)] as MenuItem]),
      ["Add Index", "key", () => alterTab(`CREATE INDEX ${qid(bcD, `idx_${bcTable}_${c.name}`)} ON ${q} (${cq});`)],
      ["Copy Name", "file", () => navigator.clipboard.writeText(c.name)],
      ["Drop Column", "trash", () => alterTab(`ALTER TABLE ${q} DROP COLUMN ${cq};`)],
    ]);
  };
  $("#bc-d-refresh").onclick = () => bcTable && bcLoad(bcTable);
  $("#bc-refresh").onclick = async () => {
    bcBusy(1);
    $("#bc-refresh").querySelector("svg")?.classList.add("animate-spin");
    try { await bcObjects(); bcSchema(); if (bcTable) await bcLoad(bcTable); bcMsg("Refreshed"); } catch (err) { bcMsg(String(err), true); }
    finally { bcBusy(-1); $("#bc-refresh").querySelector("svg")?.classList.remove("animate-spin"); }
  };
  const bcDelRow = async (grid: HTMLElement, i: HTMLInputElement) => {
    const x = cellSrc(grid, i);
    if (!x || !(await confirmBox("Delete row?", `${x.keyCols.map((c) => c.name).join(", ")} = ${x.key.join(", ")} in ${x.src.t}`, "Delete"))) return;
    try { await x.ed.db.execute(deleteSql(x.ed.d, x.src.t, x.keyCols), x.key.map((v) => arg(x.ed.d, v))); x.tr.querySelectorAll("input").forEach((inp) => pending.get(grid)?.delete(inp)), pendUi(grid), x.tr.remove(), bcMsg(`Deleted 1 row from ${x.src.t}`); } catch (err) { bcMsg(String(err), true); }
    if (grid.id === "bc-grid") bcLoad(bcTable); // refresh count / paging
  };
  $("#bc-add").onclick = async () => {
    try { await bcDb.execute(insertSql(bcD, bcTable)); await bcLoad(bcTable); } catch (err) { bcMsg(String(err), true); }
  };

  $("[data-basecurves]").onclick = () => (bc.classList.replace("hidden", "flex"), bcList(), bcDrawObjects(), bcStatus());
  $("#bc-close").onclick = () => bc.classList.replace("flex", "hidden");

  // ----- connection dialog (Navicat-style form): URL without password in sqlite, password in the OS credential store -----
  await db.execute("CREATE TABLE IF NOT EXISTS db_conns (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL)");
  const dbSecret = (id: number) => -id; // keyring slot: negative ids so they never clash with SSH connection ids
  const bcDlg = $<HTMLDialogElement>("#bc-dlg"), bcForm = $<HTMLFormElement>("#bc-form");
  const fEl = (n: string) => bcForm.elements.namedItem(n) as HTMLInputElement;
  const setKind = (k: Kind, fill: boolean) => {
    fEl("kind").value = k;
    $("#bc-dlg-title").textContent = `${fEl("id").value ? "Edit" : "New"} Connection (${KIND_LABEL[k]})`;
    $("#bc-kinds").querySelectorAll<HTMLElement>("[data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === k));
    bcForm.querySelectorAll<HTMLElement>("[data-kinds]").forEach((el) => {
      const on = el.dataset.kinds === "all" || el.dataset.kinds === (k === "sqlite" ? "sqlite" : "net");
      el.classList.toggle("hidden", !on);
      if (el instanceof HTMLInputElement) el.disabled = !on; // hidden fields skip validation
    });
    if (fill) for (const [n, v] of Object.entries(DEFAULTS[k])) fEl(n).value = v;
    if (k === "sqlite") showTab("General");
  };
  const showTab = (t: string) => {
    bcForm.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    bcForm.querySelectorAll<HTMLElement>("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== t));
  };
  $("#bc-tabs").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (b) showTab(b.dataset.tab!);
  };
  const sshOn = $<HTMLInputElement>("#bc-ssh-on"), sshSel = $<HTMLSelectElement>("#bc-ssh");
  sshOn.onchange = () => (sshSel.disabled = !sshOn.checked);
  /** SSH tunnel first (if the URL asks for one), then the URL the driver should dial. */
  const dial = async (input: string) => {
    const t = tunnelOf(input);
    if (!t) return input;
    const c = conns.find((x) => x.id === t.ssh);
    if (!c) throw "The SSH server for this connection no longer exists — pick another on the SSH tab.";
    bcMsg(`Opening SSH tunnel via ${c.name}…`);
    const port = await invoke<number>("ssh_tunnel", {
      id: c.id, host: c.host, port: c.port, user: c.user, keyPath: c.key_path, remoteHost: t.host, remotePort: t.port,
    });
    return viaLocal(input, port);
  };
  $("#bc-kinds").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
    if (b) setKind(b.dataset.kind as Kind, true);
  };
  const bcEdit = async (c?: DbConn) => {
    bcForm.reset();
    $("#bc-test-msg").textContent = "";
    fEl("id").value = c ? String(c.id) : "";
    fEl("name").value = c?.name ?? "";
    const f = c ? fromUrl(c.url) : null;
    sshSel.innerHTML = conns.map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.user)}@${esc(s.host)})</option>`).join("") || `<option value="">No SSH servers — add one in DevOps</option>`;
    sshOn.checked = !!f?.ssh;
    if (f?.ssh) sshSel.value = f.ssh;
    sshOn.onchange!(new Event("change"));
    showTab("General");
    if (!c || !f) return setKind("postgres", true), bcDlg.showModal();
    setKind(f.kind, false);
    for (const n of ["host", "port", "database", "user", "file"] as const) fEl(n).value = f[n];
    const pw = await invoke<string>("get_secret", { id: dbSecret(c.id) });
    fEl("secret").value = pw;
    fEl("savepw").checked = !!pw;
    bcDlg.showModal();
  };
  const formUrl = () => toUrl({
    ...(Object.fromEntries(["kind", "host", "port", "database", "user", "file"].map((n) => [n, fEl(n).value])) as ConnForm),
    ssh: sshOn.checked ? sshSel.value : "",
  });
  $("#bc-new").onclick = $("#bc-new2").onclick = () => bcEdit();
  $("#bc-cancel").onclick = () => bcDlg.close();
  $("#bc-test").onclick = async () => {
    if (!bcForm.reportValidity()) return;
    const msg = $("#bc-test-msg");
    msg.className = "mt-4 min-h-4 font-mono text-xs text-zinc-500";
    msg.textContent = "Connecting…";
    try {
      const { url } = connUrl(await dial(withPw(formUrl(), fEl("secret").value)));
      const t = await Database.load(url, { autoCreate: false });
      await t.select("SELECT 1");
      if (t.path !== db.path && t.path !== bcDb.path) await t.close(t.path).catch(() => {});
      msg.textContent = "Connection successful";
      msg.classList.add("text-emerald-400");
    } catch (err) { msg.textContent = String(err); msg.classList.add("text-red-400"); }
  };
  bcForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const url = formUrl(), name = fEl("name").value.trim();
      let id = +fEl("id").value;
      if (id) await db.execute("UPDATE db_conns SET name=$1, url=$2 WHERE id=$3", [name, url, id]);
      else id = (await db.execute("INSERT INTO db_conns (name, url) VALUES ($1, $2)", [name, url])).lastInsertId!;
      const keep = fEl("kind").value !== "sqlite" && fEl("savepw").checked;
      await invoke("set_secret", { id: dbSecret(id), secretValue: keep ? fEl("secret").value : "" }); // blank = remove saved password
      bcDlg.close();
      bcList();
    } catch (err) { $("#bc-test-msg").textContent = String(err); }
  };
  /** Password for a connection whose password isn't saved; null = cancelled. */
  const askPw = (name: string) => new Promise<string | null>((done) => {
    const d = $<HTMLDialogElement>("#bc-pw"), i = $<HTMLInputElement>("#bc-pw-in");
    $("#bc-pw-title").textContent = `Password for ${name}`;
    i.value = "";
    d.returnValue = "";
    d.onclose = () => done(d.returnValue === "ok" ? i.value : null);
    d.showModal();
  });

  // ----- connect / disconnect -----
  // The SQL plugin keeps one pool per URL; only the latest connect wins, and the old pool is closed by name.
  let bcGen = 0;
  const bcConnect = async (input: string, cid: number, openDb = false) => {
    const gen = ++bcGen;
    bcMsg("Connecting…");
    bcConnecting = cid;
    bcTree();
    loading($("#bc-objects"), `Connecting to ${dbConns.find((c) => c.id === cid)?.name ?? "database"}…`);
    if (bcV !== "query" && bcV !== "builder") bcView("objects"); // switching from the Query bar / a builder stays there
    bcBusy(1);
    try {
      const { url, d } = connUrl(await dial(input));
      bcMsg("Connecting…");
      const next = await Database.load(url, { autoCreate: d === "sqlite" });
      if (gen !== bcGen) return; // a newer connect started meanwhile
      // re-connecting the same connection (other database / schema): close its old pool; other connections stay open
      const prev = bcOn && bcCid === cid ? bcDb : sessions.get(cid)?.db;
      if (prev && prev.path !== db.path && prev.path !== next.path) await prev.close(prev.path).catch(() => {}); // never close the app's own store
      sessions.delete(cid);
      if (bcOn && bcCid !== cid) sessions.set(bcCid, snap()); // park the one that was selected
      (bcDb = next), (bcD = d), (bcOn = true), (bcUrl = url), (bcCid = cid), (bcCollapsed = d === "sqlite" && !openDb), (bcDbOpen = openDb), (bcSel = "");
      if (bcTable) bcCloseData();
      bcCurDb = d === "sqlite" ? "" : decodeURIComponent(new URL(url).pathname.slice(1));
      bcDbList = d === "sqlite" ? [] : (await bcDb.select<{ name: string }[]>(dbsSql(d))).map((r) => r.name);
      [bcSchemas, bcCurSchema] = d === "postgres" ? [(await bcDb.select<{ name: string }[]>(schemasSql)).map((r) => r.name), (await bcDb.select<{ s: string }[]>("SELECT current_schema() AS s"))[0]?.s ?? ""] : [[], ""];
      await bcObjects();
      bcEditor.setDialect(d);
      bcSchema();
      if (bcV !== "query" && bcV !== "builder") bcView("objects");
      bcStatus();
      bcMsg(`Connected to ${[bcConn()?.name, bcCurDb, bcCurSchema].filter(Boolean).join(" › ")}`);
    } catch (err) {
      if (gen === bcGen) (bcMsg(String(err), true), bcDrawObjects());
    } finally {
      bcBusy(-1);
      if (gen === bcGen) (bcConnecting = 0), (bcTree(), bcQBar());
    }
  };
  /** Close one connection (default: the selected one). Closing the selected one selects another open one, if any. */
  const bcDisconnect = async (id = bcCid) => {
    const s = sess(id), name = dbConns.find((c) => c.id === id)?.name ?? "";
    if (!s) return;
    if (s.db.path !== db.path) await s.db.close(s.db.path).catch(() => {});
    sessions.delete(id);
    if (!(bcOn && id === bcCid)) return bcTree(), bcQBar(), bcMsg(`Closed ${name}`);
    (bcDb = db), (bcOn = false), (bcCid = 0), (bcObjs = []), (bcDbList = []), (bcCurDb = ""), (bcSchemas = []), (bcCurSchema = ""), (bcSel = ""), (bcErDirty = true);
    bcCloseData();
    const other = sessions.keys().next().value;
    if (other !== undefined) return bcActivate(other);
    bcDrawObjects();
    bcTree();
    bcStatus();
    bcMsg(`Closed ${name}`);
  };
  $("#bc-disconnect").onclick = () => void bcDisconnect();

  // ----- query editor -----
  /** Runs one or more statements in order; the last read's rows go to the result grid. Stops at the first error. */
  const QMAX = 1000; // rows fetched by the query editor when the statement has no LIMIT of its own
  /** Columns of a plain SELECT (joins included) that trace back to a table whose primary key is also in the result
   * can be edited in place, like table data. ponytail: SQLite tables without a declared PK stay read-only (no rowid in the result). */
  const qEdit = async (q: string, rows: Row[]): Promise<Edit | null> => {
    const p = selectFrom(bcD, q);
    if (!p || !rows.length) return null;
    const names = [...new Set(p.tables.map((t) => t.name))];
    const structs = new Map(await Promise.all(names.map(async (t) => [t, await bcDb.select<Col[]>(...structSql(bcD, t)).catch(() => [] as Col[])] as const)));
    const cols = new Map([...editCols(bcD, p, structs)].filter(([n, s]) => n in rows[0] && s.keys.every(([, k]) => k in rows[0])));
    return cols.size ? { db: bcDb, d: bcD, cols } : null;
  };
  const bcRun = async (sql: string, out: "q" | "b" = "q") => { // q = Query view, b = Builder view
    if (!bcOn) return bcMsg("Connect to a database first", true);
    bcView(out === "q" ? "query" : "builder");
    const grid = $(out === "q" ? "#bc-qgrid" : "#bc-bgrid");
    const parts = statements(sql).map((s) => sql.slice(s.from, s.to));
    let changed = false, affected = 0, info = "";
    const t0 = performance.now(), took = () => dur(performance.now() - t0), qInfo = $(`#bc-${out}-info`);
    const runBtn = $<HTMLButtonElement>(out === "q" ? "#bc-run" : "#bc-qb-run"), runHtml = runBtn.innerHTML, all = $<HTMLButtonElement>("#bc-runall");
    runBtn.disabled = all.disabled = true;
    loading(grid, "Running query…");
    const tick = () => ((runBtn.innerHTML = `${spinner("h-3.5 w-3.5")} ${took()}`), (qInfo.textContent = `Running… ${took()}`));
    tick();
    const timer = setInterval(tick, 100);
    bcBusy(1);
    let shown = false;
    for (const [i, q] of parts.entries()) {
      const ts = performance.now();
      try {
        if (isRead(q)) {
          const cap = capRows(q, QMAX);
          const rows = await bcDb.select<Row[]>(cap.sql);
          const more = cap.capped && rows.length > QMAX;
          bcQRows = more ? rows.slice(0, QMAX) : rows;
          const ed = await qEdit(q, bcQRows);
          bcGrid(grid, bcQRows, ed);
          shown = true;
          bcHist(q, performance.now() - ts, `${bcQRows.length}${more ? "+" : ""} row(s)`, true);
          info = `${bcQRows.length} row(s)${more ? ` (first ${QMAX} only — add LIMIT / OFFSET to page)` : ""}${ed ? ` · editable: ${[...new Set([...ed.cols.values()].map((s) => s.t))].join(", ")}` : ""} · ${took()}`;
        } else {
          const n = (await bcDb.execute(q)).rowsAffected;
          affected += n;
          changed = true;
          bcHist(q, performance.now() - ts, `${n} affected`, true);
          info = `${parts.length > 1 ? `${i + 1}/${parts.length} statements · ` : ""}${affected} row(s) affected · ${took()}`;
        }
        bcMsg(info);
      } catch (err) {
        info = `Error · ${took()}`;
        bcHist(q, performance.now() - ts, String(err).replace(/^error returned from database:\s*/i, ""), false);
        bcMsg(`${parts.length > 1 ? `Statement ${i + 1}: ` : ""}${err}`, true);
        // Plain message log, like Navicat's Message tab. Theme-safe colours only (zinc + red-400 flip in light mode).
        const where = [bcConn()?.name, bcCurDb, bcCurSchema].filter(Boolean).join(" › ");
        const line = (tag: string, text: string, cls = "text-zinc-300") => `<div class="flex gap-3"><span class="w-12 shrink-0 text-zinc-500">${tag}</span><span class="min-w-0 whitespace-pre-wrap break-words ${cls}">${esc(text)}</span></div>`;
        grid.innerHTML = `<div class="space-y-1 p-3 font-mono text-[13px] leading-relaxed">${[
          line("[SQL]", q.trim()),
          line("[Err]", String(err).replace(/^error returned from database:\s*/i, ""), "text-red-400"),
          line("[Info]", [where && `on ${where}`, parts.length > 1 && `statement ${i + 1}/${parts.length}`, i && `${affected} row(s) affected before`, took()].filter(Boolean).join(" · "), "text-zinc-500"),
        ].join("")}</div>`;
        shown = true;
        break;
      }
    }
    clearInterval(timer);
    qInfo.textContent = info;
    if (!shown) grid.innerHTML = `<p class="py-10 text-center text-sm text-zinc-600">${changed ? info : "No result"}</p>`;
    runBtn.innerHTML = runHtml;
    runBtn.disabled = all.disabled = false;
    bcBusy(-1);
    if (changed) { // DDL/DML may have changed tables or columns
      bcStale = !!bcTable;
      await bcObjects().catch(() => {});
      bcSchema();
    }
  };
  const bcEditor = createSqlEditor($("#bc-editor"), $("#bc-qtabs"), bcRun, () => void bcSaveQuery());
  $("#bc-run").onclick = () => (bcEditor.focus(), bcEditor.runCurrent());
  $("#bc-runall").onclick = () => (bcEditor.focus(), bcEditor.runAll());
  $("#bc-explain").onclick = () => (bcEditor.focus(), bcEditor.runCurrent(bcD === "sqlite" ? "EXPLAIN QUERY PLAN " : "EXPLAIN "));

  // ----- visual query builder (Query › Builder) -----
  // Tables are boxes on a canvas; drag a column's dot onto a column of another box to join them; click the join's
  // badge to pick INNER/LEFT/RIGHT/FULL; tick columns to select them. The SQL below updates live.
  // Each builder is a tab ("Builder 1", "Builder 2", …) kept in localStorage; box columns come from the live schema.
  // ponytail: tabs aren't tied to a connection — a box whose table isn't in the current schema just shows no columns.
  const QB_W = 220, OUT_W = 200;
  type QbBox = { a: string; t: string; x: number; y: number; cols: { c: string; ty: string }[] };
  // out = the table linked to the Result box (FROM); only it and the tables joined to it, directly or not, go in the query
  type QbTab = { name: string; conn: { cid: number; db: string; schema: string } | null; boxes: QbBox[]; joins: Qb["joins"]; cols: Qb["cols"]; out: string | null; ox: number; oy: number; where: string; limit: number; filters: QbF[] };
  type QbF = { id: number; op: QbFilter["op"]; v: string; x: number; y: number; to: { a: string; c: string } | null }; // value box → column = WHERE condition
  let qbZ = 1, qbKey = "", qbSchema = new Map<string, { c: string; ty: string }[]>();
  const qbBlank = (name: string): QbTab => ({ name, conn: null, boxes: [], joins: [], cols: [], out: null, ox: 780, oy: 24, where: "", limit: 100, filters: [] });
  let qbTabs: QbTab[] = [], qbCur = 0;
  try { ({ tabs: qbTabs, cur: qbCur } = JSON.parse(localStorage.bcBuilders ?? "{}")); } catch {} // corrupt → start fresh
  if (Array.isArray(qbTabs)) qbTabs.forEach((t) => (t.filters ??= [])); // tabs saved before filters existed
  if (!Array.isArray(qbTabs) || !qbTabs.length) (qbTabs = [qbBlank("Builder 1")]), (qbCur = 0);
  qbCur = Math.min(Math.max(0, qbCur | 0), qbTabs.length - 1);
  let qb = qbTabs[qbCur];
  const qbStore = () => { try { localStorage.bcBuilders = JSON.stringify({ cur: qbCur, tabs: qbTabs.map((t) => ({ ...t, boxes: t.boxes.map((b) => ({ ...b, cols: [] })) })) }); } catch {} };
  const qbTabsUi = () => {
    $("#bc-btabs").innerHTML = qbTabs.map((t, i) => `<span data-bi="${i}" class="group flex cursor-pointer items-center gap-1 rounded-t-lg border border-b-0 px-3 py-1 text-xs ${i === qbCur ? "border-zinc-700 bg-zinc-900 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-200"}">
        <span class="text-emerald-400">${icon("network", "h-3 w-3")}</span>${esc(t.name)}${qbTabs.length > 1 ? `<button data-bx title="Close builder" class="ml-1 rounded px-1 text-zinc-500 opacity-0 hover:text-red-400 group-hover:opacity-100">×</button>` : ""}</span>`).join("") +
      `<button data-bnew title="New builder" class="px-2 text-sm text-zinc-500 hover:text-amber-400">+</button>`;
  };
  const qbSwitch = (i: number) => {
    qbCur = i;
    qb = qbTabs[i];
    $<HTMLInputElement>("#bc-qb-where").value = qb.where;
    $<HTMLInputElement>("#bc-qb-limit").value = String(qb.limit);
    qbTabsUi();
    qbBoxes();
    void qbSync(true);
  };
  // Each builder is bound to the connection › database › schema it was made on (unbound old tabs bind on first use).
  const qbHere = () => ({ cid: bcCid, db: bcCurDb, schema: bcCurSchema });
  const qbMatch = () => !!qb.conn && bcOn && bcCid === qb.conn.cid && bcCurDb === qb.conn.db && bcCurSchema === qb.conn.schema;
  const qbConnName = () => (qb.conn ? [dbConns.find((c) => c.id === qb.conn!.cid)?.name ?? "(deleted connection)", qb.conn.db, qb.conn.schema].filter(Boolean).join(" › ") : "");
  let qbEnsuring = false;
  /** Make the builder's own connection › db › schema the active one: select it if open, connect it if not, then switch db / schema. */
  const qbEnsure = async () => {
    if (!qb.conn && bcOn) qb.conn = qbHere();
    if (!qb.conn || qbMatch()) return qbMatch();
    if (qbEnsuring) return false;
    const want = qb.conn, c = dbConns.find((x) => x.id === want.cid);
    if (!c) return false;
    qbEnsuring = true;
    try {
      if (!isOpen(c.id)) await bcOpenConn(c);
      else if (bcCid !== c.id) bcActivate(c.id);
      if (bcOn && bcCid === c.id && want.db && bcCurDb !== want.db) await bcConnect(withDb(bcUrl, want.db), c.id, true);
      if (bcOn && bcCid === c.id && want.schema && bcCurSchema !== want.schema) await bcConnect(withSchema(bcUrl, want.schema), c.id, true);
    } finally { qbEnsuring = false; }
    return qbMatch();
  };
  /** Refresh the builder for the active connection; `enforce` first switches to the builder's own connection. */
  const qbSync = async (enforce: boolean) => {
    if (enforce) await qbEnsure();
    const ok = qbMatch(), chip = $("#bc-qb-conn");
    // the selects show the active connection; when that isn't this builder's own, an amber button offers to go back
    chip.innerHTML = `${icon("plug", "h-3.5 w-3.5 shrink-0")}<span class="max-w-[22rem] truncate">${esc(qb.name)} uses ${esc(qbConnName())}</span><span class="font-semibold">— switch</span>`;
    chip.title = "Switch to this builder's connection · right-click: bind this builder to the selection above instead";
    chip.classList.toggle("hidden", ok || !qb.conn);
    chip.classList.toggle("flex", !ok && !!qb.conn);
    if (ok) {
      const key = `${bcCid}|${bcUrl}`;
      if (key !== qbKey) {
        qbKey = key;
        qbSchema = new Map();
        for (const r of await bcDb.select<{ t: string; c: string; ty: string }[]>(schemaSql(bcD)).catch(() => [])) (qbSchema.get(r.t) ?? qbSchema.set(r.t, []).get(r.t)!).push({ c: r.c, ty: r.ty });
      }
      qb.boxes.forEach((b) => (b.cols = qbSchema.get(b.t) ?? []));
      qbBoxes();
    }
    qbList();
    qbDraw();
  };
  $("#bc-qb-conn").onclick = () => void qbSync(true);
  const qbBind = () => ((qb.conn = qbHere()), void qbSync(false));
  $("#bc-qb-conn").oncontextmenu = (e) => contextMenu(e, bcOn ? [["Bind to the active connection", "plug", qbBind]] : []);
  const qbNew = () => {
    const n = Math.max(0, ...qbTabs.map((t) => +(/^Builder (\d+)$/.exec(t.name)?.[1] ?? 0))) + 1;
    qbTabs.push({ ...qbBlank(`Builder ${n}`), conn: bcOn ? qbHere() : null }); // bound to where it was made
    qbSwitch(qbTabs.length - 1);
  };
  $("#bc-btabs").onclick = async (e) => {
    const t = e.target as HTMLElement, i = +(t.closest<HTMLElement>("[data-bi]")?.dataset.bi ?? -1);
    if (t.closest("[data-bnew]")) return qbNew();
    if (t.closest("[data-bx]")) {
      if (qbTabs[i].boxes.length && !(await confirmBox("Close builder?", `${qbTabs[i].name} — its tables and joins are discarded`, "Close"))) return;
      qbTabs.splice(i, 1);
      return qbSwitch(Math.min(qbCur > i ? qbCur - 1 : qbCur, qbTabs.length - 1));
    }
    if (i >= 0 && i !== qbCur) qbSwitch(i);
  };
  const qbInc = () => {
    const inc = new Set(qb.out && qb.boxes.some((b) => b.a === qb.out) ? [qb.out] : []);
    for (let grew = inc.size > 0; grew; ) { grew = false; for (const j of qb.joins) if (inc.has(j.a) !== inc.has(j.b)) (inc.add(j.a), inc.add(j.b), (grew = true)); }
    return inc;
  };
  const qbCv = () => $("#bc-qb-cv");
  const qbSql = () => {
    const inc = qbInc();
    if (!inc.size) return "";
    return builderSql(bcD, { tables: [...qb.boxes].sort((a, b) => +(b.a === qb.out) - +(a.a === qb.out)).filter((b) => inc.has(b.a)), joins: qb.joins.filter((j) => inc.has(j.a) && inc.has(j.b)), cols: qb.cols.filter((c) => inc.has(c.a)), where: qb.where, limit: qb.limit,
      filters: qb.filters.flatMap((q) => (q.to && inc.has(q.to.a) && (q.v.trim() || q.op.startsWith("IS ")) ? [{ ...q.to, op: q.op, v: q.v }] : [])) });
  };
  const qbList = () => {
    const f = $<HTMLInputElement>("#bc-qb-q").value.trim().toLowerCase();
    if (qb.conn && !qbMatch()) return void ($("#bc-qb-list").innerHTML = `<p class="px-2 py-3 text-xs text-zinc-500">This builder uses <b class="text-zinc-300">${esc(qbConnName())}</b>. Press the amber “switch” button above, or pick a connection there to re-bind this builder.</p>`);
    const ts = [...qbSchema.keys()].filter((t) => t.toLowerCase().includes(f));
    $("#bc-qb-list").innerHTML = ts.map((t) => `<div data-qt="${esc(t)}" title="${esc(t)}" class="flex cursor-grab select-none items-center gap-1.5 rounded-md px-2 py-1 hover:bg-zinc-800"><span class="text-emerald-400">${icon("table", "h-3.5 w-3.5")}</span><span class="truncate">${esc(t)}</span></div>`).join("")
      || `<p class="px-2 py-3 text-xs text-zinc-600">${bcOn ? "No tables" : "Connect to a database first"}</p>`;
  };
  const qbAdd = (t: string, x?: number, y?: number) => {
    let a = t;
    for (let n = 2; qb.boxes.some((b) => b.a === a); n++) a = `${t}_${n}`;
    const i = qb.boxes.length;
    qb.boxes.push({ a, t, x: Math.max(0, x ?? 24 + (i % 4) * (QB_W + 60)), y: Math.max(0, y ?? 24 + Math.floor(i / 4) * 260), cols: qbSchema.get(t) ?? [] });
    qbBoxes();
  };
  const qbBoxes = () => {
    const cv = qbCv();
    cv.querySelectorAll("[data-qb], [data-qb-out], [data-qf]").forEach((b) => b.remove());
    cv.insertAdjacentHTML("beforeend", qb.boxes.map((b) => `<div data-qb="${esc(b.a)}" style="left:${b.x}px;top:${b.y}px;width:${QB_W}px" class="absolute rounded-lg border border-zinc-700 bg-zinc-900 text-xs shadow-lg shadow-black/30">
      <div data-qb-head title="Drag to move" class="flex h-[30px] cursor-move select-none items-center gap-1.5 rounded-t-lg border-b border-zinc-700 bg-zinc-800 px-2 font-semibold text-zinc-100">
        <span class="text-emerald-400">${icon("table", "h-3.5 w-3.5")}</span><span class="truncate">${esc(b.t)}</span>${b.a !== b.t ? `<span class="font-normal text-zinc-500">${esc(b.a)}</span>` : ""}
        <button data-qb-x title="Remove from the query" class="ml-auto rounded px-1 text-zinc-500 hover:text-red-400">×</button>
        <span data-port title="Drag onto Result to start the query from this table" class="mr-[-13px] h-3 w-3 shrink-0 cursor-crosshair rounded-full border-2 border-emerald-500 bg-zinc-900 hover:bg-emerald-500"></span></div>
      ${b.cols.map(({ c, ty }) => `<div data-c="${esc(c)}" class="flex h-[22px] items-center gap-1.5 pl-2 font-mono hover:bg-zinc-800/70">
        <input type="checkbox" data-pick ${qb.cols.some((x) => x.a === b.a && x.c === c) ? "checked" : ""} class="accent-amber-500" />
        <span class="truncate text-zinc-200">${esc(c)}</span><span class="ml-auto truncate pl-2 text-[11px] text-zinc-500">${esc(ty)}</span>
        <span data-port title="Drag onto a column of another table to join" class="mr-[-5px] h-2.5 w-2.5 shrink-0 cursor-crosshair rounded-full border border-amber-500 bg-zinc-900 hover:bg-amber-500"></span></div>`).join("")}</div>`).join("") +
      qb.filters.map((q) => `<div data-qf="${q.id}" style="left:${q.x}px;top:${q.y}px;width:${QB_W}px" class="absolute rounded-lg border border-violet-500/60 bg-zinc-900 text-xs shadow-lg shadow-black/30">
        <div data-qf-head title="Drag to move" class="flex h-[30px] cursor-move select-none items-center gap-1.5 rounded-t-lg bg-violet-500/15 px-2 font-semibold text-zinc-100">
          <span class="text-violet-400">${icon("filter", "h-3.5 w-3.5")}</span><span class="truncate">${q.to ? esc(`${q.to.a}.${q.to.c}`) : "Filter"}</span>
          <button data-qf-x title="Remove filter" class="ml-auto rounded px-1 text-zinc-500 hover:text-red-400">×</button>
          <span data-qf-port title="Drag onto a column to filter it" class="mr-[-13px] h-3 w-3 shrink-0 cursor-crosshair rounded-full border-2 border-violet-500 bg-zinc-900 hover:bg-violet-500"></span></div>
        <div class="flex gap-1.5 p-2">
          <select data-qf-op class="rounded border border-zinc-700 bg-zinc-950 px-1 py-1 font-mono text-zinc-100 outline-none focus:border-violet-500 [&>option]:bg-zinc-900">${FILTER_OPS.map((o) => `<option ${o === q.op ? "selected" : ""}>${o}</option>`).join("")}</select>
          <input data-qf-v value="${esc(q.v)}" ${q.op.startsWith("IS ") ? "disabled" : ""} placeholder="${q.op === "IN" ? "a, b, c" : "value"}" spellcheck="false" class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-zinc-100 outline-none focus:border-violet-500 disabled:opacity-40" /></div>
        ${q.to ? "" : `<p class="px-2 pb-2 text-[11px] text-zinc-500">Drag the <span class="text-violet-400">●</span> onto a column</p>`}</div>`).join("") +
      // the Result box: the query's end point; nothing linked to it = nothing to run
      `<div data-qb-out style="left:${qb.ox}px;top:${qb.oy}px;width:${OUT_W}px" class="absolute rounded-lg border-2 bg-zinc-900 text-xs shadow-lg shadow-black/30">
        <span data-qb-in class="absolute -left-[7px] top-[8px] h-3 w-3 rounded-full border-2 border-emerald-500 bg-zinc-900"></span>
        <div data-qb-ohead title="Drag to move" class="flex h-[30px] cursor-move select-none items-center gap-1.5 rounded-t-md bg-emerald-600/20 px-2 font-semibold text-zinc-100">
          <span class="text-emerald-400">${icon("play", "h-3.5 w-3.5")}</span>Result
          <button data-qb-unlink title="Disconnect" class="ml-auto hidden rounded px-1 text-zinc-500 hover:text-red-400">×</button></div>
        <div data-qb-info class="px-2.5 py-2 leading-relaxed text-zinc-400"></div></div>`);
    qbDraw();
  };
  const qbBox = (a: string) => qbCv().querySelector<HTMLElement>(`[data-qb="${CSS.escape(a)}"]`);
  const qbY = (b: HTMLElement, c: string) => { const r = b.querySelector<HTMLElement>(`[data-c="${CSS.escape(c)}"]`); return b.offsetTop + (r ? r.offsetTop + r.offsetHeight / 2 : 15); };
  /** Curve from a box's column row to a point/box (bx0, width bw), leaving from the facing sides; returns the path and its midpoint. */
  const qbCurve = (a: HTMLElement, ay: number, bx0: number, bw: number, by: number) => {
    const ac = a.offsetLeft + QB_W / 2, bcx = bx0 + bw / 2;
    const [ax, bx, c1, c2] = Math.abs(ac - bcx) < QB_W ? [a.offsetLeft + QB_W, bx0 + bw, a.offsetLeft + QB_W + 50, bx0 + bw + 50]
      : bcx > ac ? [a.offsetLeft + QB_W, bx0, a.offsetLeft + QB_W + 60, bx0 - 60] : [a.offsetLeft, bx0 + bw, a.offsetLeft - 60, bx0 + bw + 60];
    return { d: `M${ax},${ay} C${c1},${ay} ${c2},${by} ${bx},${by}`, mx: (ax + 3 * c1 + 3 * c2 + bx) / 8, my: (ay + by) / 2 };
  };
  const qbDraw = (temp = "") => {
    const cv = qbCv(), boxes = [...cv.querySelectorAll<HTMLElement>("[data-qb], [data-qb-out]")];
    const W = Math.max($("#bc-qb-wrap").clientWidth / qbZ, ...boxes.map((b) => b.offsetLeft + QB_W + 120)), H = Math.max($("#bc-qb-wrap").clientHeight / qbZ, ...boxes.map((b) => b.offsetTop + b.offsetHeight + 120));
    (cv.style.width = `${W}px`), (cv.style.height = `${H}px`), (cv.style.transform = `scale(${qbZ})`);
    ($("#bc-qb-size").style.width = `${W * qbZ}px`), ($("#bc-qb-size").style.height = `${H * qbZ}px`);
    cv.querySelector("svg")!.innerHTML = qb.joins.map((j, i) => {
      const a = qbBox(j.a), b = qbBox(j.b);
      if (!a || !b) return "";
      const k = qbCurve(a, qbY(a, j.ac), b.offsetLeft, QB_W, qbY(b, j.bc)), w = j.type.length * 7 + 14;
      return `<g class="group"><path d="${k.d}" fill="none" stroke="#f59e0b" stroke-opacity=".75" stroke-width="1.75" class="transition-[stroke-width,stroke-opacity] group-hover:[stroke-opacity:1] group-hover:[stroke-width:4]"/><path data-j="${i}" d="${k.d}" fill="none" stroke="transparent" stroke-width="12" class="pointer-events-auto cursor-context-menu"><title>Right-click for options</title></path>
        <g data-j="${i}" class="pointer-events-auto cursor-pointer"><title>${esc(`${j.a} ${j.type} JOIN ${j.b} ON ${j.a}.${j.ac} = ${j.b}.${j.bc} — click to change`)}</title>
        <rect x="${k.mx - w / 2}" y="${k.my - 9}" width="${w}" height="18" rx="9" fill="#f59e0b"/><text x="${k.mx}" y="${k.my + 4}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#000">${j.type}</text></g></g>`;
    }).join("") + qbOutLink() + qb.filters.map((q) => { // filter → column lines (violet)
      const fb = cv.querySelector<HTMLElement>(`[data-qf="${q.id}"]`), tb = q.to ? qbBox(q.to.a) : null;
      if (!fb || !tb || !q.to) return "";
      const d = qbCurve(fb, fb.offsetTop + 15, tb.offsetLeft, QB_W, qbY(tb, q.to.c)).d;
      return `<g class="group"><path d="${d}" fill="none" stroke="#8b5cf6" stroke-width="1.75" class="transition-[stroke-width] group-hover:[stroke-width:4]"/><path data-qfl="${q.id}" d="${d}" fill="none" stroke="transparent" stroke-width="12" class="pointer-events-auto cursor-context-menu"><title>Right-click for options</title></path></g>`;
    }).join("") + temp;
    // Result box status; tables outside the query are dimmed; Run / To editor need a link
    const inc = qbInc(), out = cv.querySelector<HTMLElement>("[data-qb-out]"), sql = qbSql();
    if (out) {
      out.classList.toggle("border-emerald-500", !!inc.size);
      out.classList.toggle("border-dashed", !inc.size);
      out.classList.toggle("border-zinc-600", !inc.size);
      out.querySelector("[data-qb-unlink]")!.classList.toggle("hidden", !inc.size);
      out.querySelector("[data-qb-info]")!.innerHTML = inc.size
        ? `FROM <b class="text-zinc-100">${esc(qb.out)}</b><br>${inc.size} table${inc.size > 1 ? "s" : ""} · ${qb.cols.filter((c) => inc.has(c.a)).length || "all"} column(s)`
        : `<span class="text-amber-300">Not connected</span><br>Drag a table's <span class="text-emerald-400">●</span> here to run`;
    }
    cv.querySelectorAll<HTMLElement>("[data-qb]").forEach((b) => b.classList.toggle("opacity-45", !!inc.size && !inc.has(b.dataset.qb!)));
    $<HTMLButtonElement>("#bc-qb-run").disabled = $<HTMLButtonElement>("#bc-qb-edit").disabled = !sql;
    qbStore();
    $("#bc-qb-sql").textContent = sql || (qb.boxes.length ? "-- link a table to Result to build the query" : "-- add a table from the list (click or drag it here)");
  };
  /** Line from the linked table's header dot to the Result box. */
  const qbOutLink = () => {
    const a = qb.out ? qbBox(qb.out) : null, o = qbCv().querySelector<HTMLElement>("[data-qb-out]");
    const d = a && o ? qbCurve(a, a.offsetTop + 15, o.offsetLeft, OUT_W, o.offsetTop + 14).d : "";
    return d ? `<g class="group"><path d="${d}" fill="none" stroke="#10b981" stroke-width="2.25" class="transition-[stroke-width] group-hover:[stroke-width:4.5]"/><path data-outlink d="${d}" fill="none" stroke="transparent" stroke-width="12" class="pointer-events-auto cursor-context-menu"><title>Right-click for options</title></path></g>` : "";
  };
  // list → canvas: click adds at the next free spot, drag drops it where released
  $("#bc-qb-list").onpointerdown = (e) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>("[data-qt]");
    if (!it || e.button !== 0) return;
    e.preventDefault();
    const t = it.dataset.qt!, x0 = e.clientX, y0 = e.clientY;
    let ghost: HTMLElement | null = null;
    it.setPointerCapture(e.pointerId);
    it.onpointermove = (m) => {
      if (!ghost && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
      ghost ??= document.body.appendChild(Object.assign(document.createElement("div"), { className: "pointer-events-none fixed z-50 rounded-md border border-amber-500 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 shadow-lg", textContent: t }));
      (ghost.style.left = `${m.clientX + 8}px`), (ghost.style.top = `${m.clientY + 8}px`);
    };
    it.onpointerup = (u) => {
      it.onpointermove = it.onpointerup = null;
      if (!ghost) return qbAdd(t);
      ghost.remove();
      const w = $("#bc-qb-wrap"), r = w.getBoundingClientRect();
      if (u.clientX >= r.left && u.clientX <= r.right && u.clientY >= r.top && u.clientY <= r.bottom) qbAdd(t, (u.clientX - r.left + w.scrollLeft) / qbZ - QB_W / 2, (u.clientY - r.top + w.scrollTop) / qbZ - 15);
    };
  };
  // canvas: move boxes by the header, drag a column dot onto another table's column to join
  $("#bc-qb-cv").onpointerdown = (e) => {
    const el = e.target as HTMLElement, cv = qbCv(), head = el.closest<HTMLElement>("[data-qb-head]"), port = el.closest<HTMLElement>("[data-port]"), ohead = el.closest<HTMLElement>("[data-qb-ohead]");
    if (e.button !== 0 || el.closest("[data-qb-x], [data-pick], [data-qb-unlink], [data-qf] input, [data-qf] select, [data-qf-x]")) return;
    const qfh = el.closest<HTMLElement>("[data-qf-head]"), qfp = el.closest<HTMLElement>("[data-qf-port]");
    if (qfh && !qfp) {
      const box = qfh.parentElement!, q = qb.filters.find((x) => x.id === +box.dataset.qf!)!, sx = e.clientX, sy = e.clientY, x0 = q.x, y0 = q.y;
      qfh.setPointerCapture(e.pointerId);
      qfh.onpointermove = (m) => ((q.x = Math.max(0, x0 + (m.clientX - sx) / qbZ)), (q.y = Math.max(0, y0 + (m.clientY - sy) / qbZ)), (box.style.left = `${q.x}px`), (box.style.top = `${q.y}px`), qbDraw());
      qfh.onpointerup = () => (qfh.onpointermove = qfh.onpointerup = null);
      return;
    }
    if (qfp) { // filter dot → drop on a table column: that column gets the condition
      e.preventDefault();
      const box = qfp.closest<HTMLElement>("[data-qf]")!, q = qb.filters.find((x) => x.id === +box.dataset.qf!)!, ay = box.offsetTop + 15;
      qfp.setPointerCapture(e.pointerId);
      qfp.onpointermove = (m) => {
        const r = cv.getBoundingClientRect();
        qbDraw(`<path d="${qbCurve(box, ay, (m.clientX - r.left) / qbZ, 0, (m.clientY - r.top) / qbZ).d}" fill="none" stroke="#8b5cf6" stroke-width="1.75" stroke-dasharray="5 4"/>`);
      };
      qfp.onpointerup = (u) => {
        qfp.onpointermove = qfp.onpointerup = null;
        const to = document.elementFromPoint(u.clientX, u.clientY)?.closest<HTMLElement>("[data-qb] [data-c]");
        if (to) q.to = { a: to.closest<HTMLElement>("[data-qb]")!.dataset.qb!, c: to.dataset.c! };
        qbBoxes(); // header shows the linked column
      };
      return;
    }
    if (ohead) {
      const box = ohead.parentElement!, sx = e.clientX, sy = e.clientY, x0 = qb.ox, y0 = qb.oy;
      ohead.setPointerCapture(e.pointerId);
      ohead.onpointermove = (m) => ((qb.ox = Math.max(0, x0 + (m.clientX - sx) / qbZ)), (qb.oy = Math.max(0, y0 + (m.clientY - sy) / qbZ)), (box.style.left = `${qb.ox}px`), (box.style.top = `${qb.oy}px`), qbDraw());
      ohead.onpointerup = () => (ohead.onpointermove = ohead.onpointerup = null);
    } else if (head && !port) {
      const box = head.parentElement!, b = qb.boxes.find((x) => x.a === box.dataset.qb)!, sx = e.clientX, sy = e.clientY, bx0 = b.x, by0 = b.y;
      box.style.zIndex = "10";
      head.setPointerCapture(e.pointerId);
      head.onpointermove = (m) => ((b.x = Math.max(0, bx0 + (m.clientX - sx) / qbZ)), (b.y = Math.max(0, by0 + (m.clientY - sy) / qbZ)), (box.style.left = `${b.x}px`), (box.style.top = `${b.y}px`), qbDraw());
      head.onpointerup = () => ((head.onpointermove = head.onpointerup = null), (box.style.zIndex = ""));
    } else if (port) {
      e.preventDefault();
      // a column dot joins (drop on another table's column) or, like the header dot, links to Result
      const row = port.closest<HTMLElement>("[data-c]"), box = port.closest<HTMLElement>("[data-qb]")!, ay = row ? qbY(box, row.dataset.c!) : box.offsetTop + 15;
      port.setPointerCapture(e.pointerId);
      port.onpointermove = (m) => {
        const r = cv.getBoundingClientRect();
        qbDraw(`<path d="${qbCurve(box, ay, (m.clientX - r.left) / qbZ, 0, (m.clientY - r.top) / qbZ).d}" fill="none" stroke="#f59e0b" stroke-width="1.75" stroke-dasharray="5 4"/>`);
      };
      port.onpointerup = (u) => {
        port.onpointermove = port.onpointerup = null;
        const hit = document.elementFromPoint(u.clientX, u.clientY), to = hit?.closest<HTMLElement>("[data-qb] [data-c]"), tb = to?.closest<HTMLElement>("[data-qb]");
        if (hit?.closest("[data-qb-out]")) qb.out = box.dataset.qb!;
        else if (row && to && tb && tb !== box) {
          const j = { a: box.dataset.qb!, ac: row.dataset.c!, b: tb.dataset.qb!, bc: to.dataset.c!, type: "INNER" as JoinType };
          const dupe = qb.joins.some((x) => (x.a === j.a && x.ac === j.ac && x.b === j.b && x.bc === j.bc) || (x.a === j.b && x.ac === j.bc && x.b === j.a && x.bc === j.ac));
          if (!dupe) qb.joins.push(j);
        }
        qbDraw();
      };
    }
  };
  $("#bc-qb-cv").onclick = (e) => {
    const el = e.target as Element, a = el.closest<HTMLElement>("[data-qb]")?.dataset.qb, pick = el.closest<HTMLInputElement>("[data-pick]"), g = el.closest<SVGElement>("[data-j]");
    if (el.closest("[data-qb-unlink]")) return void ((qb.out = null), qbDraw());
    if (el.closest("[data-qb-x]") && a) {
      (qb.boxes = qb.boxes.filter((b) => b.a !== a)), (qb.joins = qb.joins.filter((j) => j.a !== a && j.b !== a)), (qb.cols = qb.cols.filter((c) => c.a !== a)), qb.out === a && (qb.out = null), qb.filters.forEach((q) => q.to?.a === a && (q.to = null));
      qbBoxes();
    } else if (pick && a) {
      const c = pick.closest<HTMLElement>("[data-c]")!.dataset.c!;
      qb.cols = pick.checked ? [...qb.cols, { a, c }] : qb.cols.filter((k) => !(k.a === a && k.c === c));
      qbDraw();
    } else if (g) qbLineMenu(e, g);
  };
  /** Menu for a line (join or Result link): its options, and at least "Delete line". */
  const qbLineMenu = (e: MouseEvent, el: Element) => {
    if (el.hasAttribute("data-qfl")) return contextMenu(e, [["Delete line", "trash", () => { const q = qb.filters.find((x) => x.id === +el.getAttribute("data-qfl")!); if (q) (q.to = null), qbBoxes(); }]]);
    if (el.hasAttribute("data-outlink")) return contextMenu(e, [["Delete line", "trash", () => ((qb.out = null), qbDraw())]]);
    const j = qb.joins[+(el.getAttribute("data-j") ?? -1)];
    if (!j) return;
    contextMenu(e, [
      ...(["INNER", "LEFT", "RIGHT", "FULL"] as const).filter((t) => t !== "FULL" || bcD === "postgres") // MySQL has no FULL JOIN
        .map((t): MenuItem => [`${t} JOIN${t === "LEFT" ? ` · all rows of ${j.a}` : t === "RIGHT" ? ` · all rows of ${j.b}` : ""}`, t === j.type ? "check" : "none", () => ((j.type = t), qbDraw())]),
      ["Swap sides", "refresh", () => (Object.assign(j, { a: j.b, ac: j.bc, b: j.a, bc: j.ac }), qbDraw())],
      ["Delete line", "trash", () => ((qb.joins = qb.joins.filter((x) => x !== j)), qbDraw())],
    ]);
  };
  /** A value box at canvas (x, y); default: near the top-left of what's in view. */
  const qbAddFilter = (x?: number, y?: number) => {
    const w = $("#bc-qb-wrap");
    qb.filters.push({ id: Math.max(0, ...qb.filters.map((q) => q.id)) + 1, op: "=", v: "", to: null, x: Math.max(0, x ?? w.scrollLeft / qbZ + 24), y: Math.max(0, y ?? w.scrollTop / qbZ + 24) });
    qbBoxes();
    qbCv().querySelector<HTMLInputElement>(`[data-qf="${qb.filters[qb.filters.length - 1].id}"] [data-qf-v]`)?.focus();
  };
  $("#bc-qb-filter").onclick = () => qbAddFilter();
  // typing in a filter box: update the condition, SQL follows live
  $("#bc-qb-cv").addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement, q = qb.filters.find((x) => x.id === +(el.closest<HTMLElement>("[data-qf]")?.dataset.qf ?? -1));
    if (!q) return;
    if (el.matches("[data-qf-v]")) q.v = el.value;
    if (el.matches("[data-qf-op]")) {
      q.op = el.value as QbF["op"];
      const v = el.parentElement!.querySelector<HTMLInputElement>("[data-qf-v]")!;
      (v.disabled = q.op.startsWith("IS ")), (v.placeholder = q.op === "IN" ? "a, b, c" : "value");
    }
    qbDraw();
  });
  $("#bc-qb-cv").addEventListener("click", (e) => {
    const x = (e.target as Element).closest("[data-qf-x]"), id = +((e.target as Element).closest<HTMLElement>("[data-qf]")?.dataset.qf ?? -1);
    if (x) (qb.filters = qb.filters.filter((q) => q.id !== id)), qbBoxes();
  });
  $("#bc-qb-cv").oncontextmenu = (e) => {
    const line = (e.target as Element).closest("[data-j], [data-outlink]");
    if (line) return qbLineMenu(e, line);
    if ((e.target as Element).closest("[data-qb], [data-qb-out], [data-qf]")) return;
    const r = qbCv().getBoundingClientRect();
    contextMenu(e, [["Add filter here", "filter", () => qbAddFilter((e.clientX - r.left) / qbZ, (e.clientY - r.top) / qbZ)]]);
  };
  $("#bc-qb-q").oninput = () => qbList();
  $("#bc-qb-where").oninput = $("#bc-qb-limit").oninput = () => ((qb.where = $<HTMLInputElement>("#bc-qb-where").value), (qb.limit = +$<HTMLInputElement>("#bc-qb-limit").value || 0), qbDraw());
  $("#bc-qb-clear").onclick = () => ((qb.boxes = []), (qb.joins = []), (qb.cols = []), (qb.filters = []), (qb.out = null), qbBoxes());
  $("#bc-qb-run").onclick = async () => {
    if (!(await qbEnsure())) return bcMsg(`Connect ${qbConnName() || "to a database"} first`, true);
    const s = qbSql();
    if (s) void bcRun(s, "b"); else bcMsg("Link a table to Result first", true);
  };
  $("#bc-qb-edit").onclick = () => { const s = qbSql(); if (s) (bcEditor.newTab(`${s};`), bcView("query")); };
  $("#bc-newb").onclick = () => (bcView("builder"), qbNew());
  /** Zoom 30–200%, keeping the canvas point under (cx, cy) — wrap-relative, default the centre — in place. */
  const qbZoom = (z: number, cx?: number, cy?: number) => {
    const w = $("#bc-qb-wrap"), old = qbZ;
    (cx ??= w.clientWidth / 2), (cy ??= w.clientHeight / 2);
    qbZ = Math.round(Math.min(2, Math.max(0.3, z)) * 100) / 100;
    $("#bc-qb-z").textContent = `${Math.round(qbZ * 100)}%`;
    qbDraw();
    w.scrollLeft = ((w.scrollLeft + cx) / old) * qbZ - cx;
    w.scrollTop = ((w.scrollTop + cy) / old) * qbZ - cy;
  };
  $("#bc-qb-wrap").addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = $("#bc-qb-wrap").getBoundingClientRect();
    qbZoom(qbZ * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // Hold Space → hand cursor; drag to pan the canvas (like design tools). Ignored while typing in a field.
  let qbSpace = false;
  const typing = () => !!document.activeElement?.closest("input, textarea, select, [contenteditable], .cm-editor");
  const qbHand = (on: boolean) => ((qbSpace = on), $("#bc-qb-wrap").classList.toggle("cursor-grab", on), qbCv().classList.toggle("pointer-events-none", on));
  addEventListener("keydown", (e) => {
    if (e.code !== "Space" || bcV !== "builder" || bc.classList.contains("hidden") || typing()) return;
    e.preventDefault(); // no page scroll / button press
    if (!qbSpace) qbHand(true);
  });
  addEventListener("keyup", (e) => e.code === "Space" && qbSpace && qbHand(false));
  addEventListener("blur", () => qbSpace && qbHand(false));
  $("#bc-qb-wrap").addEventListener("pointerdown", (e) => {
    if (!qbSpace || e.button !== 0) return;
    e.preventDefault();
    const w = e.currentTarget as HTMLElement, sx = e.clientX + w.scrollLeft, sy = e.clientY + w.scrollTop;
    w.setPointerCapture(e.pointerId);
    w.classList.add("!cursor-grabbing");
    w.onpointermove = (m) => ((w.scrollLeft = sx - m.clientX), (w.scrollTop = sy - m.clientY));
    w.onpointerup = () => ((w.onpointermove = w.onpointerup = null), w.classList.remove("!cursor-grabbing"));
  });
  $("#bc-qb-zin").onclick = () => qbZoom(qbZ + 0.1);
  $("#bc-qb-zout").onclick = () => qbZoom(qbZ - 0.1);
  $("#bc-qb-z").onclick = () => qbZoom(1);
  $("#bc-newq").onclick = () => (bcEditor.newTab(bcTable ? `SELECT * FROM ${qid(bcD, bcTable)} LIMIT 100;` : ""), bcView("query"));
  /** Column names for autocomplete; best-effort (completion just has fewer names if it fails). */
  const bcSchema = () => bcDb.select<{ t: string; c: string; ty: string }[]>(schemaSql(bcD)).then(bcEditor.setSchema, () => {});

  // ----- Main: recent query history (bc_history in the app's own SQLite) -----
  type Hist = { id: number; at: number; conn: string; db: string; schema: string; sql: string; ms: number; result: string; ok: number };
  type Saved = { id: number; folder: number | null; name: string; sql: string; at: number };
  type Folder = { id: number; name: string };
  let bcSaved: Saved[] = [], bcFolders: Folder[] = [];
  const bcShutF = new Set<number>(); // collapsed folders (all open by default)
  /** inputBox, pre-filled with `value`. */
  const askName = (title: string, where: string, ok: string, kind: "file" | "folder", value: string) => {
    const p = inputBox(title, where, ok, kind, "Name"), i = $<HTMLInputElement>("#confirm-input");
    i.value = value;
    i.select();
    $<HTMLButtonElement>("#confirm-ok").disabled = !value.trim();
    return p;
  };
  /** One row per statement run from the editor; keeps the newest 5000 (enough for the date range on Main). Best-effort: history never blocks a query. */
  const bcHist = (sql: string, ms: number, result: string, ok: boolean) =>
    db.execute("INSERT INTO bc_history (at, conn, db, schema, sql, ms, result, ok) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [Date.now(), bcConn()?.name ?? "", bcCurDb, bcCurSchema, sql.trim(), Math.round(ms), result, ok ? 1 : 0])
      .then(() => db.execute("DELETE FROM bc_history WHERE id <= (SELECT MAX(id) - 5000 FROM bc_history)"))
      .catch(() => {});
  const when = (t: number) => {
    const d = new Date(t), p = (n: number) => String(n).padStart(2, "0"), hm = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    return d.toDateString() === new Date().toDateString() ? hm : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${hm.slice(0, 5)}`;
  };
  const ago = (t: number) => {
    const s = (Date.now() - t) / 1000;
    return s < 60 ? "just now" : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`;
  };
  /** Filled area + line, scaled to its own max. */
  const spark = (v: number[], color: string) => {
    const m = Math.max(1, ...v), pts = v.map((n, i) => `${((i * 100) / (v.length - 1)).toFixed(1)},${(28 - (n / m) * 24).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 100 30" preserveAspectRatio="none" class="h-7 w-full"><polygon points="0,30 ${pts} 100,30" fill="${color}" fill-opacity=".18"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  };
  const DAYS = 14, REC_STEP = 50;
  const PALETTE = ["#f59e0b", "#38bdf8", "#34d399", "#a78bfa", "#f472b6", "#fb923c", "#2dd4bf", "#facc15"];
  /** One colour per saved connection (same in the card sparkline and the Activity chart); grey for deleted ones. */
  const connColor = (name: string) => { const i = dbConns.findIndex((c) => c.name === name); return i < 0 ? "#71717a" : PALETTE[i % PALETTE.length]; };
  const oneLine = (s: string) => s.replace(/\s+/g, " ");
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const bcHistById = new Map<number, Hist>(); // every history row on screen, for click → open in editor
  // Recent queries filter: a preset ("1" / "7" / "30" days, "all") or "custom" dates; `limit` grows with Load more.
  const bcRec = { range: "all", from: "", to: "", limit: REC_STEP };
  const panel = (title: string, ic: keyof typeof ICONS, right: string, body: string, cls = "", bodyAttr = "") => `
    <section class="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 ${cls}">
      <header class="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <span class="text-zinc-500">${icon(ic, "h-3.5 w-3.5")}</span><h2 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">${title}</h2>
        <div class="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">${right}</div></header>
      <div class="min-h-0 flex-1 overflow-auto" ${bodyAttr}>${body}</div></section>`;
  const empty = (s: string) => `<p class="grid h-full min-h-16 place-items-center px-3 text-center text-xs text-zinc-600">${s}</p>`;

  /** The dashboard: hero · [connections | activity | saved, quick start] · recent queries. */
  const bcMain = async () => {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const start = d0.getTime() - (DAYS - 1) * 864e5;
    let recent: { conn: string; at: number; ms: number }[], totals: { conn: string; last: number; n: number }[];
    [bcSaved, bcFolders, recent, totals] = await Promise.all([
      db.select<Saved[]>("SELECT * FROM bc_saved ORDER BY name COLLATE NOCASE").catch(() => []),
      db.select<Folder[]>("SELECT * FROM bc_folders ORDER BY name COLLATE NOCASE").catch(() => []),
      db.select<{ conn: string; at: number; ms: number }[]>("SELECT conn, at, ms FROM bc_history WHERE at >= $1", [start]).catch(() => []),
      db.select<{ conn: string; last: number; n: number }[]>("SELECT conn, MAX(at) AS last, COUNT(*) AS n FROM bc_history GROUP BY conn").catch(() => []),
    ]);
    bcHistById.clear();
    const days = new Map<string, number[]>();
    for (const r of recent) {
      const v = days.get(r.conn) ?? Array(DAYS).fill(0);
      v[Math.min(DAYS - 1, Math.floor((r.at - start) / 864e5))]++;
      days.set(r.conn, v);
    }
    const tot = new Map(totals.map((t) => [t.conn, t]));
    const todays = recent.filter((r) => r.at >= d0.getTime());
    const avg = todays.length ? todays.reduce((a, r) => a + r.ms, 0) / todays.length : 0;
    const open = dbConns.filter((c) => isOpen(c.id)).length;
    const list = [...dbConns].sort((a, b) => +isOpen(b.id) - +isOpen(a.id) || (tot.get(b.name)?.last ?? 0) - (tot.get(a.name)?.last ?? 0) || a.name.localeCompare(b.name));

    const stat = (v: string | number, label: string, cls: string) => `<div class="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-1.5 backdrop-blur"><p class="text-xl font-bold tabular-nums ${cls}">${v}</p><p class="text-[10px] uppercase tracking-wider text-zinc-500">${label}</p></div>`;
    const card = (c: DbConn) => {
      const f = fromUrl(c.url), k = f.kind, on = isOpen(c.id), busy = bcConnecting === c.id;
      const where = k === "sqlite" ? f.file : `${f.user}@${f.host}${f.port ? `:${f.port}` : ""}${f.database ? `/${f.database}` : ""}`;
      const ssh = tunnelOf(c.url), via = ssh && (conns.find((x) => x.id === ssh.ssh)?.name ?? `#${ssh.ssh}`);
      const t = tot.get(c.name), tables = sess(c.id)?.objs.length;
      const dot = busy ? "bg-amber-400 animate-pulse" : on ? "bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/70" : "bg-zinc-600";
      return `<button data-cid="${c.id}" data-name="${esc(c.name.toLowerCase())}" class="group relative flex flex-col gap-2.5 overflow-hidden rounded-xl border ${on ? "border-zinc-700 bg-zinc-900" : "border-zinc-800 bg-zinc-900/50"} p-3.5 text-left transition duration-200 hover:-translate-y-0.5 hover:border-zinc-600 hover:bg-zinc-900 hover:shadow-xl hover:shadow-black/40">
        <span class="absolute inset-x-0 top-0 h-0.5 opacity-70 group-hover:opacity-100" style="background:linear-gradient(90deg,${KIND_COLOR[k]},transparent)"></span>
        <div class="flex items-center gap-3">${badge(k, true, "h-9 w-9 rounded-xl", "h-5 w-5")}
          <div class="min-w-0 flex-1"><p class="truncate font-semibold text-zinc-100">${esc(c.name)}</p><p class="text-xs text-zinc-500">${KIND_LABEL[k]}</p></div>
          <span title="${busy ? "Connecting…" : on ? "Connected" : "Not connected"}" class="h-2.5 w-2.5 shrink-0 rounded-full ${dot}"></span></div>
        <div class="space-y-1 text-xs"><p class="truncate font-mono text-zinc-400" title="${esc(where)}">${esc(where) || "&nbsp;"}</p>
          <p class="flex items-center gap-1.5 truncate ${via ? "text-sky-400/90" : "text-zinc-600"}">${icon("network", "h-3 w-3")} ${via ? `via ssh · ${esc(via)}` : "direct"}</p></div>
        <div class="opacity-80 group-hover:opacity-100">${spark(days.get(c.name) ?? Array(DAYS).fill(0), connColor(c.name))}</div>
        <div class="flex items-center gap-2 text-xs text-zinc-500">
          <span class="truncate">${tables !== undefined ? `${tables} tables · ` : ""}${t ? `${t.n} queries` : "no queries yet"}</span>
          <span class="ml-auto shrink-0">${t ? ago(t.last) : ""}</span>
          <span class="shrink-0 font-medium text-zinc-400 transition group-hover:translate-x-0.5 group-hover:text-amber-400">${on ? "Use" : "Connect"} ›</span></div>
      </button>`;
    };
    const act = (id: string, ic: keyof typeof ICONS, title: string, sub: string, color: string) => {
      const off = ($(`#${id}`) as HTMLButtonElement).disabled;
      return `<button data-act="${id}" ${off ? "disabled" : ""} class="group flex min-w-0 items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 text-left transition hover:border-zinc-600 hover:bg-zinc-900 disabled:pointer-events-none disabled:opacity-40">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-800 ${color} transition group-hover:scale-110">${icon(ic, "h-4 w-4")}</span>
        <span class="min-w-0"><span class="block truncate text-sm font-medium text-zinc-100">${title}</span><span class="block truncate text-[11px] text-zinc-500">${sub}</span></span></button>`;
    };

    // Activity: one stacked bar per day, a segment per connection
    const dayTot = Array.from({ length: DAYS }, (_, i) => [...days.values()].reduce((a, v) => a + v[i], 0));
    const max = Math.max(1, ...dayTot);
    const bars = dayTot.map((n, i) => {
      const d = new Date(start + i * 864e5);
      const segs = [...days].filter(([, v]) => v[i]).map(([c, v]) => `<div title="${esc(c)}: ${v[i]}" class="w-full shrink-0 first:rounded-b-sm last:rounded-t-sm" style="height:${(v[i] / max) * 100}%;background:${connColor(c)}"></div>`).join("");
      return `<div title="${d.getDate()}/${d.getMonth() + 1} · ${n} queries" class="flex min-w-0 flex-1 flex-col items-center gap-1">
        <div class="flex w-full min-h-0 flex-1 flex-col-reverse rounded-sm bg-zinc-800/30">${segs}</div>
        <span class="text-[10px] tabular-nums ${i === DAYS - 1 ? "font-semibold text-amber-400" : "text-zinc-600"}">${d.getDate()}</span></div>`;
    }).join("");
    const legend = [...days.keys()].map((c) => `<span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-sm" style="background:${connColor(c)}"></span>${esc(c || "—")}</span>`).join("");
    const activity = recent.length
      ? `<div class="flex h-full min-h-32 flex-col gap-2 p-3"><div class="flex min-h-0 flex-1 gap-1">${bars}</div><div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">${legend}</div></div>`
      : empty(`No queries in the last ${DAYS} days`);

    const ROW = "flex cursor-pointer select-none items-center gap-2 py-1 pr-3 hover:bg-zinc-800/60";
    const query = (s: Saved, lvl: number) => `<div data-s="${s.id}" style="padding-left:${0.75 + lvl * 1.25}rem" class="${ROW}" title="${esc(s.sql)}">
        <span class="w-3 shrink-0"></span><span class="shrink-0 text-sky-400">${icon("file", "h-3.5 w-3.5")}</span>
        <span class="min-w-0 flex-1 truncate text-zinc-200">${esc(s.name)}</span><span class="shrink-0 text-xs text-zinc-600">${when(s.at)}</span></div>`;
    const saved = bcFolders.map((f) => {
      const qs = bcSaved.filter((s) => s.folder === f.id), open = !bcShutF.has(f.id);
      return `<div data-f="${f.id}" class="${ROW} pl-3">${caret(open)}<span class="shrink-0 text-amber-400">${icon("folder", "h-3.5 w-3.5")}</span>
          <span class="truncate font-medium text-zinc-200">${esc(f.name)}</span><span class="text-xs text-zinc-600">${qs.length}</span></div>
        ${open ? qs.map((s) => query(s, 1)).join("") || `<p class="py-1 pl-12 text-xs text-zinc-600">Empty — right-click a query › Move to ${esc(f.name)}</p>` : ""}`;
    }).join("") + bcSaved.filter((s) => s.folder === null).map((s) => query(s, 0)).join("");

    const rangeBtn = (v: string, label: string) => `<button data-range="${v}" class="rounded-md px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-200 [&.on]:bg-amber-500/15 [&.on]:text-amber-400">${label}</button>`;
    const DATE = "rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-300 [color-scheme:dark] outline-none focus:border-amber-500";

    $("#bc-main").innerHTML = `<div class="flex flex-1 flex-col gap-4">
      <div class="relative shrink-0 overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-900 to-amber-500/10 px-6 py-4">
        <svg class="pointer-events-none absolute inset-0 h-full w-full text-amber-500" viewBox="0 0 600 120" preserveAspectRatio="none" fill="none">
          <path d="M0 100 C140 100 190 30 300 50 S460 110 600 18" stroke="currentColor" stroke-opacity=".35" stroke-width="2" vector-effect="non-scaling-stroke"/>
          <path d="M0 115 C120 108 250 62 360 78 S510 100 600 55" stroke="currentColor" stroke-opacity=".18" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
          <path d="M0 70 C160 72 230 110 330 96 S480 40 600 82" stroke="#38bdf8" stroke-opacity=".12" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
        <div class="relative flex flex-wrap items-center gap-6">
          <div><p class="text-[10px] font-semibold uppercase tracking-[0.3em] text-amber-400/80">Database client</p>
            <h1 class="text-3xl font-bold tracking-tight text-zinc-100">Base<span class="text-amber-400">Curves</span></h1></div>
          <div class="flex flex-wrap gap-2">${stat(dbConns.length, "Connections", "text-zinc-100")}${stat(open, "Open", "text-emerald-400")}${stat(todays.length, "Queries today", "text-amber-400")}${stat(todays.length ? dur(avg) : "—", "Avg today", "text-sky-400")}</div>
          <label class="ml-auto flex w-72 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-zinc-500 backdrop-blur focus-within:border-amber-500">${icon("search", "h-4 w-4")}
            <input id="bc-home-q" placeholder="Search connections…" class="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600" />
            <kbd class="rounded border border-zinc-700 px-1.5 text-[10px] text-zinc-500">Ctrl K</kbd></label>
        </div>
      </div>
      <div class="grid h-[66rem] shrink-0 auto-rows-[minmax(0,1fr)] gap-4 lg:h-[44rem] xl:h-[22rem] lg:grid-cols-[repeat(2,minmax(0,1fr))] xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,0.9fr)]">
        ${panel("Connections", "plug", `<span>${dbConns.length}</span><button data-act="bc-new" title="New connection" class="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-amber-400">${icon("plus", "h-3.5 w-3.5")}</button>`,
          `<div data-cards class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 p-3">${list.map(card).join("")}
            <button data-act="bc-new" class="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 text-sm text-zinc-500 transition hover:border-amber-500 hover:bg-amber-500/5 hover:text-amber-400">
              <span class="grid h-9 w-9 place-items-center rounded-full border border-current">${icon("plus", "h-4 w-4")}</span>New connection</button></div>`)}
        <div class="flex min-h-0 min-w-0 flex-col gap-4">
          ${panel(`Activity · ${DAYS} days`, "logs", `<span>${recent.length} queries</span>`, activity, "flex-1")}
        </div>
        <div class="flex min-h-0 min-w-0 flex-col gap-4 lg:col-span-2 xl:col-span-1">
          ${panel("Saved queries", "folder", `<button data-newfolder title="New folder" class="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-amber-400">${icon("plus", "h-3.5 w-3.5")} Folder</button>`,
            `<div class="py-1 text-[13px]">${saved || empty("No saved queries — press Save (Ctrl+S) in Query")}</div>`, "flex-1", "data-saved")}
          <section class="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
            <h2 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Quick start</h2>
            <div class="grid grid-cols-2 gap-2">${act("bc-newq", "code", "Query", "SQL editor", "text-amber-400")}${act("bc-newb", "network", "Builder", "join tables", "text-emerald-400")}${act("bc-v-objects", "table", "Tables", "current db", "text-sky-400")}${act("bc-new", "plug", "Connect", "add a database", "text-violet-400")}</div>
          </section>
        </div>
      </div>
      ${panel("Recent queries", "code", `
        <span id="bc-rec-n" class="mr-2 tabular-nums"></span>
        ${rangeBtn("1", "Today")}${rangeBtn("7", "7 d")}${rangeBtn("30", "30 d")}${rangeBtn("all", "All")}
        <input id="bc-rec-from" type="date" title="From" value="${bcRec.from}" class="ml-1 ${DATE}" /><span>→</span><input id="bc-rec-to" type="date" title="To" value="${bcRec.to}" class="${DATE}" />`,
        `<div id="bc-recent"></div>`, "h-[32rem] shrink-0")}
    </div>`;
    $<HTMLInputElement>("#bc-home-q").oninput = (e) => {
      const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
      $("#bc-main").querySelectorAll<HTMLElement>("[data-cards] [data-cid]").forEach((el) => el.classList.toggle("hidden", !el.dataset.name!.includes(q)));
    };
    const pickDate = () => {
      Object.assign(bcRec, { range: "custom", from: $<HTMLInputElement>("#bc-rec-from").value, to: $<HTMLInputElement>("#bc-rec-to").value, limit: REC_STEP });
      bcRecent();
    };
    $("#bc-rec-from").onchange = $("#bc-rec-to").onchange = pickDate;
    await bcRecent();
  };
  /** Fills the Recent queries table for the current range; re-run by the range buttons, date pickers and Load more. */
  const bcRecent = async () => {
    const el = document.getElementById("bc-recent");
    if (!el) return;
    const from = bcRec.from ? new Date(`${bcRec.from}T00:00`).getTime() : 0;
    const to = bcRec.to ? new Date(`${bcRec.to}T00:00`).getTime() + 864e5 : 8.64e15;
    const [rows, cnt] = await Promise.all([
      db.select<Hist[]>("SELECT * FROM bc_history WHERE at >= $1 AND at < $2 ORDER BY id DESC LIMIT $3", [from, to, bcRec.limit]).catch(() => []),
      db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM bc_history WHERE at >= $1 AND at < $2", [from, to]).catch(() => []),
    ]);
    const n = cnt[0]?.n ?? 0, H = (label: string, cls = "") => `<th class="${TH} ${cls}">${label}</th>`;
    $("#bc-rec-n").textContent = `${rows.length} of ${n}`;
    $("#bc-main").querySelectorAll<HTMLElement>("[data-range]").forEach((b) => b.classList.toggle("on", b.dataset.range === bcRec.range));
    el.innerHTML = rows.length ? `<table class="w-full table-fixed border-collapse text-[13px]">
        <colgroup><col class="w-28"><col class="w-56"><col><col class="w-24"><col class="w-48"></colgroup>
        <thead><tr>${H("Time")}${H("Ran on")}${H("Query")}${H("Duration", "text-right")}${H("Result")}</tr></thead>
        <tbody>${rows.map((h) => (bcHistById.set(h.id, h), `<tr data-hid="${h.id}" class="cursor-pointer odd:bg-zinc-900/40 hover:bg-zinc-800/60">
          <td class="${TD} text-zinc-500">${when(h.at)}</td>
          <td class="${TD} font-sans text-zinc-400" title="${esc([h.conn, h.db, h.schema].filter(Boolean).join(" › "))}"><span class="mr-1.5 inline-block h-2 w-2 rounded-sm" style="background:${connColor(h.conn)}"></span>${esc([h.conn, h.db, h.schema].filter(Boolean).join(" › "))}</td>
          <td class="${TD} text-zinc-200" title="${esc(h.sql)}">${esc(oneLine(h.sql))}</td>
          <td class="${TD} text-right text-zinc-500">${dur(h.ms)}</td>
          <td class="${TD} ${h.ok ? "text-zinc-400" : "text-red-400"}" title="${esc(h.result)}">${esc(h.result)}</td></tr>`)).join("")}</tbody></table>
        ${rows.length < n ? `<button data-more class="mx-auto my-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:border-amber-500 hover:text-amber-400">${icon("arrowDown", "h-3.5 w-3.5")} Load ${Math.min(REC_STEP, n - rows.length)} more · ${n - rows.length} left</button>` : ""}`
      : empty(bcRec.range === "all" ? "No queries yet — run something in Query and it shows up here" : "No queries in this range");
  };
  bc.addEventListener("keydown", (e) => {
    if (bcV === "main" && e.ctrlKey && e.key.toLowerCase() === "k") (e.preventDefault(), document.getElementById("bc-home-q")?.focus());
  });
  const pick = (e: Event, attr: string) => +((e.target as HTMLElement).closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) ?? NaN);
  const openSaved = (s: Saved) => (bcEditor.newTab(s.sql, s.name, s.id), bcView("query"));
  $("#bc-main").onclick = async (e) => {
    const t = e.target as HTMLElement, act = t.closest<HTMLElement>("[data-act]"), cc = dbConns.find((c) => c.id === pick(e, "data-cid"));
    if (act) return $(`#${act.dataset.act}`).click();
    if (cc) return void bcOpenConn(cc).finally(bcQBar);
    const range = t.closest<HTMLElement>("[data-range]")?.dataset.range;
    if (range) {
      const from = range === "all" ? "" : ymd(new Date(Date.now() - (+range - 1) * 864e5));
      Object.assign(bcRec, { range, from, to: "", limit: REC_STEP });
      ($<HTMLInputElement>("#bc-rec-from").value = from), ($<HTMLInputElement>("#bc-rec-to").value = "");
      return bcRecent();
    }
    if (t.closest("[data-more]")) return (bcRec.limit += REC_STEP), bcRecent();
    const h = bcHistById.get(pick(e, "data-hid")), s = bcSaved.find((x) => x.id === pick(e, "data-s")), f = pick(e, "data-f");
    if (h) (bcEditor.newTab(`${h.sql};`), bcView("query"));
    else if (s) openSaved(s);
    else if (f) (bcShutF.has(f) ? bcShutF.delete(f) : bcShutF.add(f), bcMain());
    else if ((e.target as HTMLElement).closest("[data-newfolder]")) await bcNewFolder();
  };
  const bcNewFolder = async () => {
    const name = await askName("New folder", "Main › Saved queries", "Create", "folder", "");
    if (name) await db.execute("INSERT INTO bc_folders (name) VALUES ($1)", [name]), bcMain();
  };
  $("#bc-main").oncontextmenu = (e) => {
    const s = bcSaved.find((x) => x.id === pick(e, "data-s")), f = bcFolders.find((x) => x.id === pick(e, "data-f"));
    const cc = dbConns.find((c) => c.id === pick(e, "data-cid"));
    if (cc) return connMenu(e, cc);
    const run =(sql: string, args: unknown[]) => () => void db.execute(sql, args).then(bcMain, (err) => bcMsg(String(err), true));
    if (s) return contextMenu(e, [
      ["Open", "play", () => openSaved(s)],
      ["Rename", "pencil", async () => { const n = await askName("Rename query", s.name, "Rename", "file", s.name); if (n) run("UPDATE bc_saved SET name = $1 WHERE id = $2", [n, s.id])(); }],
      ...bcFolders.filter((x) => x.id !== s.folder).map((x): MenuItem => [`Move to ${x.name}`, "folder", run("UPDATE bc_saved SET folder = $1 WHERE id = $2", [x.id, s.id])]),
      ...(s.folder !== null ? [["Move to top level", "arrowUp", run("UPDATE bc_saved SET folder = NULL WHERE id = $1", [s.id])] as MenuItem] : []),
      ["Delete", "trash", async () => { if (await confirmBox("Delete saved query?", s.name, "Delete")) (bcEditor.forget(s.id), run("DELETE FROM bc_saved WHERE id = $1", [s.id])()); }],
    ]);
    if (f) return contextMenu(e, [
      ["Rename", "pencil", async () => { const n = await askName("Rename folder", f.name, "Rename", "folder", f.name); if (n) run("UPDATE bc_folders SET name = $1 WHERE id = $2", [n, f.id])(); }],
      ["Delete folder", "trash", async () => {
        if (!(await confirmBox("Delete folder?", `${f.name} — its queries move to the top level`, "Delete"))) return;
        await db.execute("UPDATE bc_saved SET folder = NULL WHERE folder = $1", [f.id]);
        run("DELETE FROM bc_folders WHERE id = $1", [f.id])();
      }],
    ]);
    if ((e.target as HTMLElement).closest("[data-saved]")) return contextMenu(e, [["New folder", "folder", () => void bcNewFolder()]]);
  };
  /** Save the current query tab: a tab opened from (or already saved to) Saved queries is updated in place; otherwise ask for a name. */
  const bcSaveQuery = async () => {
    const c = bcEditor.current();
    if (!c.text.trim()) return bcMsg("Nothing to save", true);
    if (c.sid !== undefined && (await db.select<unknown[]>("SELECT 1 FROM bc_saved WHERE id = $1", [c.sid])).length) {
      await db.execute("UPDATE bc_saved SET sql = $1, at = $2 WHERE id = $3", [c.text, Date.now(), c.sid]);
      return bcMsg(`Saved ${c.name}`);
    }
    const name = await askName("Save query", "Main › Saved queries", "Save", "file", /^Query \d+$/.test(c.name) ? "" : c.name);
    if (!name) return;
    const r = await db.execute("INSERT INTO bc_saved (folder, name, sql, at) VALUES (NULL, $1, $2, $3)", [name, c.text, Date.now()]);
    bcEditor.markSaved(Number(r.lastInsertId), name);
    bcMsg(`Saved ${name} — it's on Main`);
  };
  $("#bc-save").onclick = () => void bcSaveQuery();
  bcView("main"); // the app opens on Main; later visits keep whatever view was last shown

  // ---------- app switcher (iPhone-style): swipe an app away to free what it holds ----------
  type SwApp = { name: string; art: keyof typeof ART; detail: () => string; kill: () => unknown };
  const SW: Record<string, SwApp> = {
    devops: {
      name: "DevOps", art: "devops",
      detail: () => (tabs.length ? `${tabs.length} SSH tab${tabs.length > 1 ? "s" : ""} open` : "No sessions"),
      kill: () => [...tabs].forEach((t) => closeTab(t.key)), // ends SSH sessions, disposes terminals
    },
    basecurves: {
      name: "BaseCurves", art: "database",
      detail: () => (bcOn ? `${sessions.size + 1} connected · using ${bcConn()?.name ?? ""}` : "Not connected"),
      kill: async () => {
        for (const id of [...sessions.keys()]) await bcDisconnect(id);
        await bcDisconnect();
        await invoke("ssh_tunnels_close").catch(() => {});
        bcQRows = [];
        bcDataRows = [];
        $("#bc-qgrid").innerHTML = "";
        bcEditor.setSchema([]);
        bc.classList.replace("flex", "hidden");
      },
    },
    calendar: { name: "Calendar", art: "calendar", detail: () => "Notes by day", kill: () => calPage.classList.replace("flex", "hidden") },
    notepad: { name: "Notepad", art: "notepad", detail: () => (npOpen ? `Editing ${npOpen.name}` : `${notes.length} notes`), kill: () => npPage.classList.replace("flex", "hidden") },
    post: {
      name: "Sun Post", art: "post", detail: () => (postRes.body ? "Holding last response" : "Idle"),
      kill: () => ((postRes = { body: "", heads: "" }), drawPostOut(), postPage.classList.replace("flex", "hidden")),
    },
  };
  const running = new Set<string>();
  const tiles = () => Object.keys(SW).map((k) => [k, document.querySelector<HTMLElement>(`#launcher [data-${k}]`)] as const);
  // a small dot under running apps on the main display, like a dock
  tiles().forEach(([, b]) => b?.insertAdjacentHTML("beforeend", `<span data-run-dot class="invisible -mt-1 h-1.5 w-1.5 rounded-full bg-amber-400"></span>`));
  const swMark = () => {
    if (tabs.length) running.add("devops");
    $("#sw-n").textContent = String(running.size);
    $("#sw-n").classList.toggle("hidden", !running.size);
    tiles().forEach(([k, b]) => b?.querySelector("[data-run-dot]")?.classList.toggle("invisible", !running.has(k)));
  };

  // ----- nav bar: Back · Home · Running apps -----
  // Screens: the main display ("home"), the DevOps workspace (under the launcher), and full-screen app pages.
  const PAGES: Record<string, string> = { basecurves: "#bc", calendar: "#cal", post: "#post", notepad: "#notepad", settings: "#settings" };
  const screenNow = () =>
    Object.keys(PAGES).find((k) => !$(PAGES[k]).classList.contains("hidden")) ?? ($("#launcher").classList.contains("hidden") ? "devops" : "home");
  pathOf = () => {
    const s = screenNow();
    if (s === "home") return "/";
    if (s === "devops") return tabs.find((t) => t.key === activeKey)?.where ?? "/devops";
    if (s === "notepad") return ["/notepad", npOpen?.folder ?? npDir, npOpen?.name].filter(Boolean).join("/");
    if (s === "calendar") return `/calendar/${calKey(calSel)}`;
    if (s === "basecurves") {
      const c = bcConn();
      if (!c) return "/basecurves";
      const tail = bcV === "data" ? `${bcTable}${bcMode === "struct" ? "/structure" : bcMode === "er" ? "/er-diagram" : ""}` : bcV === "query" ? "query" : bcV === "builder" ? `builder/${qb.name.toLowerCase().replace(/\s+/g, "-")}` : bcV === "er" ? "er-diagram" : bcV === "main" ? "main" : bcSel;
      return ["/basecurves", c.name, bcCurDb, bcCurSchema, tail].filter(Boolean).join("/");
    }
    if (s === "post") {
      const u = postField("u").value.trim().replace(/^https?:\/\//, "");
      return u ? `/post/${postField("m").value} ${u}` : "/post";
    }
    if (s === "settings") return `/settings/theme/${themeName()}`;
    return `/${s}`;
  };
  // any screen switch is a class change somewhere; redraw the path once per frame
  let pathQueued = false;
  new MutationObserver(() => pathQueued || ((pathQueued = true), requestAnimationFrame(() => ((pathQueued = false), showWhere()))))
    .observe(document.body, { attributes: true, attributeFilter: ["class"], subtree: true });
  showWhere();
  const navHist: string[] = [];
  let navigating = false;
  const hideAll = () => {
    Object.values(PAGES).forEach((sel) => $(sel).classList.replace("flex", "hidden"));
    swShow(false);
  };
  const goTo = (k: string) => {
    hideAll();
    $("#launcher").classList.replace("hidden", "flex");
    swMark();
    if (k === "home") return;
    navigating = true; // the tile click below must not record history again
    document.querySelector<HTMLElement>(`#launcher [data-${k}]`)?.click();
    navigating = false;
  };
  $("#launcher").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    const k = b && [...Object.keys(SW), "settings"].find((x) => b.hasAttribute(`data-${x}`));
    if (!k) return;
    if (!navigating) navHist.push(screenNow());
    if (SW[k]) running.add(k), swMark();
  });
  $("#nav-home").onclick = () => {
    if (screenNow() !== "home") navHist.push(screenNow());
    goTo("home");
  };
  $("#nav-back").onclick = () => {
    if (!$("#switcher").classList.contains("hidden")) return swShow(false);
    const now = screenNow();
    let prev = navHist.pop();
    // skip stale entries: the screen we're on, or an app that was swiped away
    while (prev && (prev === now || (SW[prev] && !running.has(prev) && prev !== "devops"))) prev = navHist.pop();
    goTo(prev ?? "home");
  };
  $("#nav-apps").onclick = () => swShow($("#switcher").classList.contains("hidden"));
  // floating ball: drag to move (snaps to the nearest side, remembered), tap to open/close the menu
  {
    const nav = $("#navbar"), ball = $("#nav-ball"), menu = $("#nav-menu");
    const place = (x: number, y: number) => {
      x = Math.max(8, Math.min(innerWidth - 56, x));
      y = Math.max(8, Math.min(innerHeight - 56, y));
      Object.assign(nav.style, { left: `${x}px`, top: `${y}px`, right: "", bottom: "" });
      const onRight = x > innerWidth / 2; // menu opens toward the middle of the screen
      menu.style.left = onRight ? "" : "3.5rem";
      menu.style.right = onRight ? "3.5rem" : "";
    };
    const snap = () => {
      const r = nav.getBoundingClientRect();
      place(r.left + 24 > innerWidth / 2 ? innerWidth : 0, r.top);
      localStorage.navBall = JSON.stringify([nav.style.left === "8px" ? "l" : "r", r.top / innerHeight]);
    };
    try {
      const [side, fy] = JSON.parse(localStorage.navBall);
      place(side === "l" ? 0 : innerWidth, fy * innerHeight);
    } catch { place(innerWidth, innerHeight - 150); }
    addEventListener("resize", snap);
    let start: { x: number; y: number; dx: number; dy: number } | null = null, moved = false;
    ball.onpointerdown = (e) => {
      const r = nav.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top };
      moved = false;
      ball.setPointerCapture(e.pointerId);
    };
    ball.onpointermove = (e) => {
      if (!start) return;
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return; // small jitter is still a tap
      moved = true;
      nav.classList.remove("open");
      place(e.clientX - start.dx, e.clientY - start.dy);
    };
    ball.onpointerup = () => {
      if (!start) return;
      start = null;
      if (moved) snap();
      else if (nav.classList.contains("open")) swShow(false), nav.classList.remove("open");
      else nav.classList.add("open");
    };
    for (const id of ["#nav-back", "#nav-home"]) $(id).addEventListener("click", () => nav.classList.remove("open"));
    addEventListener("pointerdown", (e) => !nav.contains(e.target as Node) && $("#switcher").classList.contains("hidden") && nav.classList.remove("open"));
  }
  const mem = () => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory; // Chromium/WebView2 only
    return m ? `JS memory ${(m.usedJSHeapSize / 1048576).toFixed(0)} MB` : "";
  };
  const swDraw = () => {
    swMark();
    $("#sw-mem").textContent = mem();
    $("#sw-mem").classList.toggle("hidden", !mem());
    $<HTMLButtonElement>("#sw-clear").disabled = !running.size;
    $("#sw-cards").innerHTML = running.size
      ? [...running].map((k) => `<div data-app="${k}" class="relative flex h-[55vh] max-h-[26rem] w-60 shrink-0 cursor-grab select-none flex-col items-center justify-center gap-4 rounded-[2rem] border border-zinc-700 bg-gradient-to-b from-zinc-800 to-zinc-900 shadow-2xl shadow-black/60 transition-[transform,opacity] duration-300 active:cursor-grabbing">
          <button data-kill title="Close ${SW[k].name}" class="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full bg-zinc-950/70 text-zinc-400 hover:bg-red-500 hover:text-white">${icon("x", "h-4 w-4")}</button>
          ${appArt(SW[k].art, "h-24 w-24 drop-shadow-[0_10px_14px_rgb(0_0_0/0.5)]")}
          <p class="text-lg font-semibold">${SW[k].name}</p>
          <p class="px-4 text-center text-xs text-zinc-400">${esc(SW[k].detail())}</p>
          <p class="absolute bottom-4 flex items-center gap-1 text-[11px] text-zinc-500">${icon("arrowUp", "h-3 w-3")} swipe up to close</p>
        </div>`).join("")
      : `<p class="w-full text-center text-zinc-500">No apps running</p>`;
  };
  const swShow = (on: boolean) => ($("#switcher").classList.toggle("hidden", !on), $("#switcher").classList.toggle("flex", on), $("#nav-apps").classList.toggle("on", on), $("#navbar").classList.toggle("open", on), on && swDraw());
  const swKill = async (k: string, card?: HTMLElement) => {
    if (card) (card.style.transform = "translateY(-120vh)"), (card.style.opacity = "0");
    running.delete(k);
    await SW[k].kill();
    setTimeout(swDraw, card ? 250 : 0);
  };
  $("#sw-close").onclick = () => swShow(false);
  $("#sw-clear").onclick = async () => {
    $("#sw-cards").querySelectorAll<HTMLElement>("[data-app]").forEach((c, i) => setTimeout(() => ((c.style.transform = "translateY(-120vh)"), (c.style.opacity = "0")), i * 60));
    for (const k of [...running]) (running.delete(k), await SW[k].kill());
    setTimeout(swDraw, 400);
  };
  addEventListener("keydown", (e) => e.key === "Escape" && !$("#switcher").classList.contains("hidden") && swShow(false));
  // swipe: drag a card up past 120px to close it; a tap opens the app
  let drag: { card: HTMLElement; y0: number; dy: number } | null = null;
  $("#sw-cards").onpointerdown = (e) => {
    const t = e.target as HTMLElement, card = t.closest<HTMLElement>("[data-app]");
    if (!card) return;
    if (t.closest("[data-kill]")) return void swKill(card.dataset.app!, card);
    drag = { card, y0: e.clientY, dy: 0 };
    card.setPointerCapture(e.pointerId);
    card.style.transition = "none";
  };
  $("#sw-cards").onpointermove = (e) => {
    if (!drag) return;
    drag.dy = Math.min(0, e.clientY - drag.y0);
    drag.card.style.transform = `translateY(${drag.dy}px) scale(${1 + drag.dy / 3000})`;
    drag.card.style.opacity = String(1 + drag.dy / 500);
  };
  $("#sw-cards").onpointerup = $("#sw-cards").onpointercancel = (e) => {
    if (!drag) return;
    const { card, dy } = drag, k = card.dataset.app!;
    drag = null;
    card.style.transition = "";
    if (dy < -120) return void swKill(k, card);
    card.style.transform = "";
    card.style.opacity = "";
    if (e.type === "pointerup" && dy > -6) {
      swShow(false);
      document.querySelector<HTMLElement>(`#launcher [data-${k}]`)?.click();
    }
  };

  wireRunDialog();

  $<HTMLFormElement>("#auth-form").onsubmit = (e) => {
    e.preventDefault();
    answerAuth([...document.querySelectorAll<HTMLInputElement>("#auth-fields input")].map((i) => i.value));
  };
  $("#auth-cancel").onclick = () => answerAuth(null);
  $("#auth").addEventListener("cancel", (e) => (e.preventDefault(), answerAuth(null))); // Esc
  addEventListener("pointerdown", (e) => $("#ctx").contains(e.target as Node) || hideMenu());
  addEventListener("keydown", (e) => e.key === "Escape" && hideMenu());
  addEventListener("blur", hideMenu);
  addEventListener("resize", hideMenu);

  await listen<AuthPrompt>("auth-prompt", (e) => (authQueue.push(e.payload), showAuth()));

  await refreshList();
  renderTabs();
}

/** Same dialog for add (no conn) and edit. */
async function openForm(c?: Conn) {
  const form = $<HTMLFormElement>("#f");
  form.reset();
  const set = (name: string, v: unknown) => ((form.elements.namedItem(name) as HTMLInputElement).value = String(v));
  set("id", c?.id ?? "");
  if (c) {
    (["name", "host", "port", "user", "key_path"] as const).forEach((k) => set(k, c[k]));
    set("secret", await invoke<string>("get_secret", { id: c.id }));
  }
  $("#dlg-title").textContent = c ? `Edit ${c.name}` : "New SSH connection";
  const pw = form.elements.namedItem("secret") as HTMLInputElement;
  pw.type = "password";
  $("#eye").textContent = "Show";
  $<HTMLDialogElement>("#dlg").showModal();
}

function field(name: string, label: string, placeholder: string, attrs = "", required = true) {
  return `<label class="block text-xs text-zinc-400">${label}
    <input name="${name}" placeholder="${esc(placeholder)}" ${attrs} ${required ? "required" : ""}
      class="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500" />
  </label>`;
}

async function refreshList() {
  conns = await loadConns();
  renderList();
}

// icon (Lucide name) + label per server, kept on this computer like the deployment icons
type ServerLook = { icon?: string; label?: string };
const getSrvLook = (id: number): ServerLook => {
  try { return JSON.parse(localStorage[`srvLook:${id}`] ?? "{}"); } catch { return {}; }
};
const putSrvLook = (id: number, l: ServerLook) => (localStorage[`srvLook:${id}`] = JSON.stringify(l));

function renderList() {
  const q = $<HTMLInputElement>("#q").value.toLowerCase();
  const shown = conns.filter((c) => `${c.name} ${c.host} ${c.user} ${getSrvLook(c.id).label ?? ""}`.toLowerCase().includes(q));
  $("#list").innerHTML = shown.length
    ? shown.map((c) => {
        const open = tabs.find((t) => t.conn.id === c.id);
        const look = getSrvLook(c.id);
        return `
        <div class="flex items-center rounded-lg pl-1.5 hover:bg-zinc-800">
          <button data-sico="${c.id}" title="Choose icon" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700 hover:text-amber-400">${lucide(look.icon || "server", "h-4 w-4")}</button>
          <button data-open="${c.id}" class="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2.5 pr-3 text-left">
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 text-sm"><span class="truncate">${esc(c.name)}</span>${look.label ? `<span class="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-400">${esc(look.label)}</span>` : ""}</span>
              <span class="block truncate font-mono text-[11px] text-zinc-500">${esc(c.user)}@${esc(c.host)}${c.port === 22 ? "" : `:${c.port}`}</span>
            </span>
            ${dot(open?.status)}
          </button>
        </div>`;
      }).join("")
    : `<p class="px-3 py-6 text-center text-xs text-zinc-600">${conns.length ? "No match" : "No servers yet"}</p>`;

  $("#list").querySelectorAll<HTMLElement>("[data-sico]").forEach((b) => (b.onclick = async () => {
    const id = +b.dataset.sico!, k = await pickIcon();
    if (k === null) return;
    putSrvLook(id, { ...getSrvLook(id), icon: k || undefined });
    renderList();
  }));
  const setLabel = async (c: Conn) => {
    const ask = inputBox("Server label", c.name, "Save", "file", "e.g. prod, staging");
    $<HTMLInputElement>("#confirm-input").value = getSrvLook(c.id).label ?? "";
    const label = await ask;
    if (label) (putSrvLook(c.id, { ...getSrvLook(c.id), label }), renderList());
  };

  $("#list").querySelectorAll<HTMLElement>("[data-open]").forEach((b) => {
    const c = conns.find((c) => c.id === +b.dataset.open!)!;
    // Already connected → jump to its first tab; a fresh session is a right-click away.
    b.onclick = () => {
      const t = tabs.find((t) => t.conn.id === c.id);
      if (!t) return openTab(c);
      activeKey = t.key;
      renderTabs();
    };
    // Edit / delete live on the right-click menu (no hover buttons).
    b.oncontextmenu = (e) => contextMenu(e, [
      [tabs.some((t) => t.conn.id === c.id) ? "New session" : "Connect", "plus", () => openTab(c)],
      ["Edit…", "pencil", () => openForm(c)],
      ["Set label…", "pencil", () => setLabel(c)],
      ...(getSrvLook(c.id).label ? [["Remove label", "x", () => (putSrvLook(c.id, { ...getSrvLook(c.id), label: undefined }), renderList())] as MenuItem] : []),
      ["Copy host", "file", () => navigator.clipboard.writeText(`${c.user}@${c.host}${c.port === 22 ? "" : `:${c.port}`}`)],
      ["Delete", "trash", async () => {
        const open = tabs.filter((t) => t.conn.id === c.id);
        if (!(await confirmBox("Delete server?", `${c.name}${open.length ? ` — ${open.length} open tab(s) will close` : ""}`, "Delete"))) return;
        open.forEach((t) => closeTab(t.key));
        await deleteConn(c.id);
        await refreshList();
      }],
    ]);
  });
}

function openTab(c: Conn) {
  const pane = document.createElement("div");
  pane.className = "absolute inset-0";
  $("#stage").append(pane);
  const tab: Tab = { key: ++tabSeq, sid: 0, conn: c, pane, status: "connecting", close: () => {}, where: "" };
  tabs.push(tab);
  activeKey = tab.key;
  connect(tab);
}

/** Opens the machine view: our menu up front, the shell minimised to a button. */
function connect(tab: Tab, attempt = 1, lastErr = "") {
  tab.close();
  const c = tab.conn;
  const sid = (tab.sid = ++sidSeq);
  tab.pane.innerHTML = `
    <div data-view="home" class="absolute inset-0 flex">
      <div data-desk class="flex min-w-0 flex-1 flex-col bg-cover bg-center p-6">
        <div class="flex items-baseline gap-3">
          <h1 class="text-xl font-semibold">${esc(c.name)}</h1>
          <p class="font-mono text-sm text-zinc-500">${esc(c.user)}@${esc(c.host)}:${c.port}</p>
          <span data-stats class="ml-auto hidden items-center gap-4 self-center rounded-full bg-zinc-900/70 px-3 py-1 font-mono text-xs backdrop-blur"></span>
          <span data-ssh class=" flex items-center gap-2 self-center rounded-full bg-zinc-900/70 px-3 py-1 text-xs backdrop-blur"></span>
          <button data-log-btn title="Show log" class="flex items-center gap-1.5 self-center rounded-lg px-2.5 py-1 text-sm hover:bg-zinc-800/60">${icon("logs")} Log</button>
        </div>
        <div class="tiles mt-6 flex-1 overflow-auto">
          ${appTile("deploy", "rocket", "Deploy", true)}
          ${appTile("term-app", "terminal", "Terminal")}
          ${appTile("files-app", "folder", "Files")}
          ${appTile("cron-app", "clock", "Cron")}
        </div>
      </div>
      <section data-log-panel class="absolute inset-y-0 right-0 z-40 hidden w-[26rem] flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/50">
        <div class="flex items-center justify-between px-4 pt-3">
          <h2 class="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Log</h2>
          <button data-log-x title="Hide log" class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">${icon("x", "h-3.5 w-3.5")}</button>
        </div>
        <div data-log class="min-h-0 flex-1 overflow-auto px-4 py-2 font-mono text-xs leading-6"></div>
      </section>
    </div>
    <div data-view="deploy" class="absolute inset-0 hidden flex-col">
      <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        ${backBtn("data-back", c.name)}
        ${appTitle("rocket", "Deploy", esc(c.name))}
      </div>
      <div class="flex min-h-0 flex-1">
        <aside class="flex w-64 shrink-0 flex-col border-r border-zinc-800">
          <div class="p-3">
            <button data-new class="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-sm font-medium text-black hover:bg-amber-400">${icon("plus")} New Deploy</button>
          </div>
          <div class="flex items-center justify-between px-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Deployments
            <button data-refresh title="Refresh" class="rounded p-1 hover:bg-zinc-800 hover:text-zinc-200">${icon("refresh", "h-3.5 w-3.5")}</button>
          </div>
          <nav data-list class="flex-1 space-y-0.5 overflow-auto px-2 pb-3"></nav>
          <div data-qbar class="hidden space-y-2 border-t border-zinc-800 p-3">
            <div class="flex items-center gap-2 text-xs">
              <span data-qcount class="flex-1 font-medium text-zinc-200"></span>
              <button data-qall class="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">All</button>
              <button data-qclear class="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">Clear</button>
            </div>
            <label class="flex items-center gap-2 text-[11px] text-zinc-500">On failure
              <select data-qfail class="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-amber-500">
                <option value="stop">Stop the queue</option>
                <option value="skip">Skip to the next one</option>
              </select>
            </label>
            <button data-qapply class="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-sm font-medium text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">${icon("rocket")} <span data-qlabel>Apply</span></button>
            <p class="text-center text-[11px] text-zinc-500">Asks for every tag first, then runs them one by one in order</p>
          </div>
        </aside>
        <main class="flex min-w-0 flex-1 flex-col">
          <div class="flex items-center gap-2 border-b border-zinc-800 px-5 py-2">
            <h2 data-title class="min-w-0 flex-1 truncate font-mono text-sm"></h2>
            <div class="dp-seg" role="tablist" aria-label="View">
              <button data-v="easy" title="Form: press + to add things one at a time">Form</button>
              <button data-v="yaml" title="Edit the YAML directly">YAML</button>
              <span class="dp-seg-sep"></span>
              <button data-v="flow" title="See the steps as a diagram + simulate">Flow</button>
              <button data-v="sh" title="The bash script that will run on the machine">sh</button>
            </div>
            <button data-manual title="Manual" class="dp-icon">${icon("book")}</button>
            <details data-more class="relative">
              <summary title="More" class="dp-icon list-none">${icon("dots")}</summary>
              <div class="absolute right-0 z-50 mt-1 w-60 rounded-xl border border-zinc-700 bg-zinc-900/95 p-1 text-sm text-zinc-100 shadow-2xl shadow-black/50 backdrop-blur">
                <button data-savesh class="dp-mi">${icon("file")}<span><span class="block">Save sh to the machine</span><span class="block text-[11px] text-zinc-500">Run it yourself in Terminal; no sudo password inside</span></span></button>
                <div data-delwrap class="mt-1 border-t border-zinc-800 pt-1">
                  <button data-del class="dp-mi text-red-400 hover:bg-red-500/10!">${icon("trash")}<span data-deltext>Delete this deployment</span></button>
                </div>
              </div>
            </details>
            <button data-dsave title="Save without deploying (Ctrl+S), even if unfinished" class="ml-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">Save</button>
            <button data-apply class=" flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">${icon("rocket")} Apply</button>
          </div>
          <p data-err class="min-h-5 px-5 pt-1 text-xs text-red-400"></p>
          <div data-easy class="hidden min-h-0 flex-1 overflow-auto"></div>
          <div data-yaml class="min-h-0 flex-1 overflow-hidden"></div>
          <div data-flowbox class="hidden min-h-0 flex-1 overflow-auto"></div>
          <div data-dpanel class="flex h-60 shrink-0 flex-col border-t border-zinc-800 bg-zinc-950">
            <div class="flex items-center px-5 pt-1.5">
              <p class="flex-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Deploy log</p>
              <button data-dmounts title="Show what is mounted on the machine" class="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">${icon("folder", "h-3 w-3")} Mounts</button>
              <button data-dclear title="Clear log" class="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">${icon("trash", "h-3 w-3")} Clear</button>
              <button data-dfull title="Full screen (Esc to exit)" class="ml-1 flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"></button>
            </div>
            <div data-dlog class="min-h-0 flex-1 overflow-auto px-5 py-1 font-mono text-xs leading-6"></div>
          </div>
        </main>
      </div>
    </div>
    <div data-view="term" class="absolute inset-0 hidden flex-col">
      <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        ${backBtn("data-back", c.name)}
        ${appTitle("terminal", "Terminal", esc(c.name))}
        <span class="ml-auto font-mono text-xs text-zinc-500">${esc(c.user)}@${esc(c.host)}</span>
      </div>
      <div data-term class="min-h-0 flex-1 p-2"></div>
    </div>
    <div data-view="files" class="absolute inset-0 hidden flex-col">
      <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        ${backBtn("data-back", c.name)}
        ${appTitle("folder", "Files", esc(c.name))}
        <details class="relative ml-auto">
          <summary class="cursor-pointer list-none rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Settings</summary>
          <div class="absolute right-0 z-50 mt-1 min-w-48 rounded-xl border border-zinc-700 bg-zinc-900/95 p-1 text-sm shadow-2xl shadow-black/50">
            <label class="flex cursor-pointer items-center justify-between gap-4 rounded-lg px-3 py-1.5 hover:bg-zinc-800">
              Show hidden files
              <input type="checkbox" role="switch" data-fhidden class="peer sr-only" />
              <span class="relative h-5 w-9 shrink-0 rounded-full bg-zinc-700 transition-colors peer-checked:bg-amber-500 peer-focus-visible:ring-2 peer-focus-visible:ring-amber-500/50 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"></span>
            </label>
          </div>
        </details>
      </div>
      <form data-fbar class="flex items-center gap-1 border-b border-zinc-800 px-4 py-2">
        <button type="button" data-up title="Up one folder" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("arrowUp")}</button>
        <button type="button" data-frefresh title="Refresh" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("refresh")}</button>
        <button type="button" data-fnew="file" title="New file" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("file")}</button>
        <button type="button" data-fnew="folder" title="New folder" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("folder")}</button>
        <button type="button" data-fup title="Upload files here" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("upload")}</button>
        <input data-path spellcheck="false" class="ml-1 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-sm outline-none focus:border-amber-500" />
      </form>
      <div class="flex min-h-0 flex-1">
        <div data-flist class="min-w-0 flex-1 overflow-auto p-2"></div>
        <section data-fprev class="hidden w-1/2 flex-col border-l border-zinc-800">
          <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
            <span data-fname class="min-w-0 flex-1 truncate font-mono text-sm"></span>
            <span data-fstat class="shrink-0 text-xs text-zinc-500"></span>
            <button data-fextract class="hidden rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">Extract here</button>
            <button data-fsave disabled title="Save (Ctrl+S)" class="rounded-lg bg-amber-500 px-3 py-1 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:cursor-default disabled:opacity-40">Save</button>
            <button data-fx title="Close preview" class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">${icon("x", "h-3.5 w-3.5")}</button>
          </div>
          <pre data-fbody class="min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-5"></pre>
          <div data-fed class="hidden min-h-0 flex-1"></div>
          <div data-fmedia class="hidden min-h-0 flex-1 place-items-center overflow-auto bg-[conic-gradient(#27272a_25%,#18181b_0_50%,#27272a_0_75%,#18181b_0)] bg-[length:16px_16px]"></div>
        </section>
      </div>
    </div>
    <div data-view="cron" class="absolute inset-0 hidden flex-col">
      <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        ${backBtn("data-back", c.name)}
        ${appTitle("clock", "Cron", esc(c.name))}
        <span data-cmsg class="ml-auto text-xs text-zinc-500"></span>
        <button data-cadd class="flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">${icon("plus")} Add job</button>
        <button data-crefresh title="Reload from the machine (drops unsaved changes)" class="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("refresh")}</button>
        <button data-csave disabled class="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">Save</button>
      </div>
      <datalist id="cron-presets-${sid}">
        <option value="* * * * *">every minute</option><option value="*/5 * * * *">every 5 minutes</option>
        <option value="0 * * * *">every hour</option><option value="0 3 * * *">every day at 03:00</option>
        <option value="0 3 * * 0">every Sunday at 03:00</option><option value="0 0 1 * *">1st of every month</option>
        <option value="@reboot">at boot</option>
      </datalist>
      <div class="min-h-0 flex-1 overflow-auto p-4">
        <p class="mb-3 text-xs text-zinc-500">Crontab of <span class="font-mono">${esc(c.user)}</span>. Schedule = minute hour day month weekday. Comments and variables in the file are kept as they are.</p>
        <div data-clist class="space-y-1.5"></div>
      </div>
    </div>
    <div data-loading class="absolute inset-0 z-50 grid place-items-center bg-zinc-950/40 backdrop-blur-md">
      <div class="flex flex-col items-center gap-3">
        <span class="h-10 w-10 animate-spin rounded-full border-4 border-zinc-700 border-t-amber-500"></span>
        <p class="text-sm text-zinc-300">Connecting to ${esc(c.name)}…</p>
      </div>
    </div>`;
  const q = (s: string) => tab.pane.querySelector<HTMLElement>(s)!;
  const log = makeLog(q("[data-log]"));
  const ctx: DeployCtx = { sid, connId: c.id, log: makeLog(q("[data-dlog]")) };
  const openDeploy = deployPage(ctx, q('[data-view="deploy"]'));
  type View = "home" | "deploy" | "term" | "files" | "cron";
  let cur: View = "home";
  const setWhere = () => {
    tab.where = `/devops/server/${tab.conn.id}${cur === "home" ? "" : `/${cur}`}`;
    showWhere();
  };
  const openFiles = filesPage(sid, c.id, q('[data-view="files"]'));
  const openCron = cronPage(sid, q('[data-view="cron"]'), () => view("term"));
  const view = (v: View) => {
    tab.pane.querySelectorAll<HTMLElement>("[data-view]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.view !== v);
      el.classList.toggle("flex", el.dataset.view === v);
    });
    cur = v;
    setWhere();
    if (v === "term") term.focus();
  };
  setWhere();
  q("[data-deploy]").onclick = () => (view("deploy"), openDeploy());
  tab.pane.querySelectorAll<HTMLElement>("[data-back]").forEach((b) => (b.onclick = () => view("home")));
  const showLog = (show: boolean) => {
    q("[data-log-panel]").classList.toggle("hidden", !show);
    q("[data-log-panel]").classList.toggle("flex", show);
    q("[data-log-btn]").classList.toggle("hidden", show);
  };
  q("[data-log-btn]").onclick = () => showLog(true);
  q("[data-log-x]").onclick = () => showLog(false);

  wallpaper(q("[data-desk]"), c.id);
  const setStatus = (s: Status) => {
    tab.status = s;
    q("[data-ssh]").innerHTML = `${dot(s)} SSH ${s === "live" ? "connected" : s === "connecting" ? "connecting…" : "disconnected"}`;
    q("[data-loading]").classList.toggle("hidden", s !== "connecting");
    if (!tabs.includes(tab)) return; // tab closed meanwhile
    renderTabs();
    renderList();
  };

  // Terminal (minimised until the button is pressed).
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    fontSize: 14,
    theme: termTheme(),
  });
  terms.add(term);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(q("[data-term]"));
  q("[data-term-app]").onclick = () => view("term");
  q("[data-files-app]").onclick = () => (view("files"), openFiles());
  q("[data-cron-app]").onclick = () => (view("cron"), openCron());

  let closed = false;
  const cleanups: (() => void)[] = [];
  const add = (f: () => void) => (closed ? f() : cleanups.push(f));
  tab.close = () => {
    if (closed) return;
    closed = true;
    cancelAuth(sid);
    cleanups.reverse().forEach((f) => f());
    terms.delete(term);
    term.dispose();
  };
  const ro = new ResizeObserver(() => {
    if (!q("[data-term]").clientWidth) return; // minimised or hidden tab
    fit.fit();
    invoke("term_resize", { sid, cols: term.cols, rows: term.rows });
  });
  ro.observe(q("[data-term]"));
  add(() => ro.disconnect());

  /** Refreshes the CPU/RAM/disk pill every 3 s while this machine's home view is on screen. */
  async function pollStats() {
    const box = q("[data-stats]");
    let prev: Cpu | undefined;
    while (!closed && tab.status === "live") {
      if (!tab.pane.classList.contains("hidden") && !q('[data-view="home"]').classList.contains("hidden")) {
        try {
          const s = parseStats((await invoke<ExecOut>("remote_exec", { sid, command: STATS_SCRIPT })).out, prev);
          prev = s.cpuRaw;
          box.innerHTML = statsHtml(s);
          box.classList.replace("hidden", "flex");
        } catch {
          break; // not Linux, or session gone
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    box.classList.replace("flex", "hidden");
  }

  setStatus("connecting");
  if (lastErr) log("warn", `Attempt ${attempt - 1} failed: ${lastErr}`);
  log("info", `Connecting to ${c.user}@${c.host}:${c.port}…${attempt > 1 ? ` (attempt ${attempt}/3)` : ""}`);
  // Until setup finishes, any failure retries on its own (3 tries total); after that, drops wait for the reconnect button.
  let settled = false;
  const retry = (why: string) => {
    if (settled || attempt >= 3) return false;
    settled = true; // retry once per attempt
    setTimeout(() => tabs.includes(tab) && tab.sid === sid && connect(tab, attempt + 1, why), 1000);
    return true;
  };
  (async () => {
    // Listen before connecting so the first bytes aren't lost.
    add(await listen<number[]>(`term-data-${sid}`, (e) => term.write(new Uint8Array(e.payload))));
    add(await listen(`term-exit-${sid}`, () => {
      if (retry("session dropped during setup")) return;
      term.writeln("\r\n\x1b[33m[disconnected]\x1b[0m");
      log("err", "Disconnected. Use the reconnect button on the tab.");
      q("[data-deploy]").toggleAttribute("disabled", true);
      q("[data-apply]").toggleAttribute("disabled", true);
      setStatus("closed");
    }));
    if (closed) return;
    try {
      await invoke("ssh_connect", {
        sid, id: c.id, host: c.host, port: c.port, user: c.user, keyPath: c.key_path, cols: term.cols, rows: term.rows,
      });
    } catch (err) {
      if (closed || retry(String(err))) return;
      log("err", `Connection failed: ${err}`);
      setStatus("closed");
      return;
    }
    add(() => invoke("ssh_disconnect", { sid }));
    const input = term.onData((data) => invoke("term_write", { sid, data }).catch(() => {}));
    add(() => input.dispose());
    if (closed) return;
    setStatus("live");
    log("ok", "Connected");
    pollStats();
    // ponytail: settles only on setup success; a real setup error leaves retry armed, so a later drop auto-reconnects too.
    if (await runSetup(sid, log)) {
      settled = true;
      q("[data-deploy]").toggleAttribute("disabled", false);
    }
  })();
}

const gb = (b: number) => (b / 2 ** 30).toFixed(1);
const meter = (label: string, pct: number | null, text: string) => {
  const p = Math.round(pct ?? 0);
  const color = p > 85 ? "bg-red-400" : p > 60 ? "bg-amber-400" : "bg-emerald-400";
  return `<span class="flex items-center gap-1.5" title="${label} ${pct === null ? "…" : p + "%"}">
    <span class="text-zinc-500">${label}</span>
    <span class="h-1.5 w-10 overflow-hidden rounded-full bg-zinc-700"><span class="block h-full rounded-full ${color}" style="width:${p}%"></span></span>
    ${text}</span>`;
};
const statsHtml = (s: Stats) =>
  meter("CPU", s.cpu, s.cpu === null ? "…" : `${Math.round(s.cpu)}%`) +
  meter("RAM", (100 * s.memUsed) / s.memTotal, `${gb(s.memUsed)}/${gb(s.memTotal)}G`) +
  meter("Disk", s.disk, `${Math.round(s.disk)}%`);

/** Makes sure the workspace folder and database exist on the machine; true when ready. */
async function runSetup(sid: number, log: (level: LogLevel, text: string) => void) {
  log("info", `Checking ${REMOTE_DIR}/ and ${REMOTE_DB}…`);
  try {
    const r = await invoke<{ out: string; code: number }>("remote_exec", { sid, command: SETUP_SCRIPT });
    const got = Object.fromEntries(r.out.split("\n").map((l) => l.trim().split("=")));
    const report = (v: string | undefined, path: string) =>
      v === "exists" ? log("ok", `found    ${path}`) : v === "created" ? log("warn", `created  ${path}`) : log("err", `failed   ${path}`);
    report(got.dir, `${REMOTE_DIR}/`);
    report(got.db, `${REMOTE_DIR}/${REMOTE_DB}`);
    const ok = /^(exists|created)$/.test(got.dir ?? "") && /^(exists|created)$/.test(got.db ?? "");
    if (!ok && r.out.trim()) log("err", r.out.trim());
    if (ok) log("ok", "Workspace ready");
    return ok;
  } catch (err) {
    log("err", `Setup failed: ${err}`);
    return false;
  }
}

// ---------- cron page (edit the user's crontab, written only on Save) ----------

/** Wires the Cron page of one machine; returns a function to call each time the page is shown. */
function cronPage(sid: number, root: HTMLElement, openTerm: () => void) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const list = q("[data-clist]");
  const save = q<HTMLButtonElement>("[data-csave]");
  const msg = (t: string, err = false) => {
    q("[data-cmsg]").textContent = t;
    q("[data-cmsg]").classList.toggle("text-red-400", err);
  };
  type Job = Extract<CronLine, { job: true }>;
  let lines: CronLine[] = [];
  let loaded = false;
  const dirty = (d = true) => (save.disabled = !d);

  function render() {
    const jobs = lines.filter((l): l is Job => l.job);
    list.innerHTML = jobs.length
      ? jobs.map((j, i) => `
        <div data-i="${i}" class="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
          <label title="Enabled" class="shrink-0 cursor-pointer">
            <input type="checkbox" data-on ${j.on ? "checked" : ""} class="peer sr-only" />
            <span class="relative block h-5 w-9 rounded-full bg-zinc-700 transition-colors peer-checked:bg-amber-500 peer-focus-visible:ring-2 peer-focus-visible:ring-amber-500/50 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"></span>
          </label>
          <input data-sched value="${esc(j.sched)}" list="cron-presets-${sid}" spellcheck="false" placeholder="* * * * *" aria-label="Schedule" class="w-44 shrink-0 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm outline-none focus:border-amber-500 [&.bad]:border-red-500" />
          <input data-cmd value="${esc(j.cmd)}" spellcheck="false" placeholder="command" aria-label="Command" class="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm outline-none focus:border-amber-500" />
          <button data-run title="Open Terminal in this job's folder" class="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">${icon("terminal")}</button>
          <button data-rm title="Delete job" class="rounded p-1.5 text-zinc-500 hover:bg-red-500/10 hover:text-red-400">${icon("trash")}</button>
        </div>`).join("")
      : `<p class="px-3 py-6 text-center text-xs text-zinc-600">No cron jobs yet</p>`;
    list.querySelectorAll<HTMLElement>("[data-i]").forEach((row) => {
      const j = jobs[+row.dataset.i!];
      const s = row.querySelector<HTMLInputElement>("[data-sched]")!;
      const check = () => s.classList.toggle("bad", !validSched(s.value));
      check();
      row.querySelector<HTMLInputElement>("[data-on]")!.onchange = (e) => ((j.on = (e.target as HTMLInputElement).checked), dirty());
      s.oninput = () => ((j.sched = s.value), check(), dirty());
      row.querySelector<HTMLInputElement>("[data-cmd]")!.oninput = (e) => ((j.cmd = (e.target as HTMLInputElement).value), dirty());
      row.querySelector<HTMLElement>("[data-rm]")!.onclick = () => ((lines = lines.filter((l) => l !== j)), render(), dirty());
      row.querySelector<HTMLElement>("[data-run]")!.onclick = () => {
        openTerm();
        const cd = cdLine(j.cmd);
        if (cd) invoke("term_write", { sid, data: `${cd}\r` }).catch(() => {});
      };
    });
  }

  async function load() {
    msg("Loading…");
    try {
      const r = await invoke<ExecOut>("remote_exec", { sid, command: CRON_READ });
      if (r.code) throw r.out.trim() || `exit ${r.code}`;
      lines = parseCrontab(r.out);
      loaded = true;
      msg("");
      dirty(false);
      render();
    } catch (err) {
      msg(String(err), true);
    }
  }

  q("[data-cadd]").onclick = () => {
    lines.push({ job: true, on: true, sched: "0 3 * * *", cmd: "" });
    render();
    dirty();
    list.querySelector<HTMLInputElement>("[data-i]:last-child [data-cmd]")?.focus();
  };
  q("[data-crefresh]").onclick = load;
  save.onclick = async () => {
    const jobs = lines.filter((l): l is Job => l.job);
    if (jobs.some((j) => !validSched(j.sched))) return msg("Fix the red schedules first", true);
    if (jobs.some((j) => !j.cmd.trim())) return msg("Every job needs a command", true);
    save.disabled = true;
    msg("Saving…");
    try {
      const r = await invoke<ExecOut>("remote_exec", { sid, command: CRON_WRITE, stdin: serializeCrontab(lines) });
      if (r.code) throw r.out.trim() || `exit ${r.code}`; // crontab rejects bad syntax and keeps the old one
      msg("Saved");
    } catch (err) {
      msg(`Save failed: ${err}`, true);
      dirty();
    }
  };
  return () => loaded || load();
}

// ---------- files page (browse + edit, saved only on Save) ----------

/** Wires the Files page of one machine; returns a function to call each time the page is shown. */
function filesPage(sid: number, connId: number, root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const list = q("[data-flist]");
  const input = q<HTMLInputElement>("[data-path]");
  let cur = "~";
  let opened = false;
  let last: Entry[] = [];
  const hiddenBox = q<HTMLInputElement>("[data-fhidden]");
  hiddenBox.checked = localStorage.showHidden === "1"; // default: hide dotfiles
  hiddenBox.onchange = () => ((localStorage.showHidden = hiddenBox.checked ? "1" : "0"), render(last));
  const run = (command: string) => invoke<ExecOut>("remote_exec", { sid, command });
  const fail = (m: string) => list.insertAdjacentHTML("afterbegin", `<p class="px-3 py-2 font-mono text-xs text-red-400">${esc(m)}</p>`);
  const showPrev = (show: boolean) => {
    q("[data-fprev]").classList.toggle("hidden", !show);
    q("[data-fprev]").classList.toggle("flex", show);
  };

  async function go(path: string) {
    list.innerHTML = `<p class="px-3 py-2 text-xs text-zinc-500">Loading…</p>`;
    try {
      const r = await run(listScript(path));
      if (!r.out.startsWith("/")) throw r.out.trim() || `exit ${r.code}`; // cd failed (missing / no permission)
      const { path: abs, entries } = parseListing(r.out);
      cur = abs;
      input.value = abs;
      render(entries);
    } catch (err) {
      input.value = cur;
      list.innerHTML = `<p class="px-3 py-2 font-mono text-xs text-red-400">${esc(err)}</p>`;
    }
  }

  function render(all: Entry[]) {
    last = all;
    const entries = hiddenBox.checked ? all : all.filter((e) => !e.name.startsWith("."));
    list.innerHTML = entries.length
      ? `<div class="grid grid-cols-[1fr_6rem_9rem] px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500"><span>Name</span><span class="text-right">Size</span><span class="text-right">Modified</span></div>` +
        entries
          .map((e, i) => `
            <button data-fi="${i}" class="grid w-full grid-cols-[1fr_6rem_9rem] items-center rounded-lg px-3 py-1.5 text-left text-sm hover:bg-zinc-800">
              <span class="flex min-w-0 items-center gap-3 ${e.name.startsWith(".") ? "opacity-60" : ""}">
                ${appArt(e.dir ? "folder" : "file", "h-7 w-7 drop-shadow-[0_2px_2px_rgb(0_0_0/0.3)]", fileColor(e.name))}
                <span class="truncate">${esc(e.name)}</span>
              </span>
              <span class="text-right font-mono text-xs text-zinc-500">${e.dir ? "" : fmtSize(e.size)}</span>
              <span class="text-right font-mono text-xs text-zinc-500">${esc(e.mtime)}</span>
            </button>`)
          .join("")
      : `<p class="px-3 py-6 text-center text-xs text-zinc-600">Empty folder</p>`;
    list.querySelectorAll<HTMLElement>("[data-fi]").forEach((b) => {
      const e = entries[+b.dataset.fi!];
      b.onclick = () => (e.dir ? go(joinPath(cur, e.name)) : preview(e));
      if (!e.dir) b.oncontextmenu = (ev) => contextMenu(ev, [["Download", "download", () => download(e)]]);
    });
  }

  // ponytail: whole file pulled as base64 into memory; stream in chunks if multi-GB downloads matter
  async function download(e: Entry) {
    list.insertAdjacentHTML("afterbegin", `<p data-fdlmsg class="px-3 py-2 text-xs text-zinc-400">Downloading ${esc(e.name)} (${fmtSize(e.size)})…</p>`);
    const r = await run(mediaScript(joinPath(cur, e.name))).catch((err) => ({ out: String(err), code: 1 }));
    list.querySelector("[data-fdlmsg]")?.remove();
    if (r.code) return void fail(`Download of ${e.name} failed: ${r.out.trim() || `exit ${r.code}`}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([Uint8Array.from(atob(r.out.trim()), (c) => c.charCodeAt(0))]));
    a.download = e.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- editor: changes stay local until Save ----
  const body = q("[data-fbody]");
  const saveBtn = q<HTMLButtonElement>("[data-fsave]");
  let file: { path: string; saved: string; eol: string } | null = null; // null = nothing editable open
  const dirty = () => !!file && ed.get() !== file.saved;
  const stat = (text: string, cls = "text-zinc-500") => {
    const s = q("[data-fstat]");
    s.textContent = s.title = text;
    s.className = `max-w-[50%] truncate text-xs ${cls}`;
  };
  const onEdit = () => {
    saveBtn.disabled = !dirty();
    if (file) stat(dirty() ? "● Unsaved changes" : "", "text-amber-400");
  };
  const ed = createEditor(q("[data-fed]"), onEdit);
  const media = q("[data-fmedia]");
  let blobUrl = "";
  const show = (which: "body" | "ed" | "media") => {
    body.classList.toggle("hidden", which !== "body");
    q("[data-fed]").classList.toggle("hidden", which !== "ed");
    media.classList.toggle("hidden", which !== "media");
    media.classList.toggle("grid", which === "media");
    if (which !== "media") {
      media.innerHTML = "";
      if (blobUrl) URL.revokeObjectURL(blobUrl), (blobUrl = "");
    }
  };
  const showEditor = (on: boolean) => show(on ? "ed" : "body");
  /** Image / SVG (<img>, so SVG scripts never run) or PDF (webview's built-in viewer). */
  async function showMedia(path: string, e: Entry, mime: string) {
    if (e.size > MEDIA_MAX) return void (body.textContent = `Too large to preview (${fmtSize(e.size)} > ${fmtSize(MEDIA_MAX)}).`);
    const r = await run(mediaScript(path));
    if (r.code) throw r.out.trim() || `exit ${r.code}`;
    if (q("[data-fname]").textContent !== path) return; // another file was opened meanwhile
    show("media");
    blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(r.out.trim()), (c) => c.charCodeAt(0))], { type: mime }));
    media.innerHTML =
      mime === "application/pdf"
        ? `<iframe src="${blobUrl}" class="h-full w-full self-stretch justify-self-stretch border-0"></iframe>`
        : `<img src="${blobUrl}" class="max-h-full max-w-full object-contain p-4" />`;
    stat(fmtSize(e.size));
  }
  /** True when it's fine to drop what's in the editor. */
  const canLeave = async () => !dirty() || confirmBox("Discard changes?", `${file!.path} has unsaved changes.`, "Discard");

  async function preview(e: Entry) {
    if (!(await canLeave())) return;
    const path = joinPath(cur, e.name);
    file = null;
    onEdit();
    stat("");
    q("[data-fname]").textContent = path;
    body.textContent = "Loading…";
    showEditor(false);
    showPrev(true);
    q("[data-fextract]").classList.toggle("hidden", !isArchive(e.name));
    try {
      if (isArchive(e.name)) return void ((body.textContent = "Archive. Extract here unpacks it into a new folder next to it."), stat(fmtSize(e.size)));
      const mime = mimeFor(e.name);
      if (mime) return await showMedia(path, e, mime);
      const r = await run(readScript(path));
      if (r.code) throw r.out.trim() || `exit ${r.code}`;
      if (/[\0�]/.test(r.out)) return void (body.textContent = "Binary file, no preview.");
      const cut = e.size > PREVIEW_BYTES; // saving a partial read would truncate the file
      ed.set(r.out, modeFor(e.name), cut);
      if (cut) stat(`Read-only: first ${fmtSize(PREVIEW_BYTES)} of ${fmtSize(e.size)}`, "text-amber-400");
      else file = { path, saved: ed.get(), eol: r.out.includes("\r\n") ? "\r\n" : "\n" };
      showEditor(true);
      ed.focus();
    } catch (err) {
      body.textContent = String(err);
    }
  }

  async function save() {
    if (!file || !dirty()) return;
    const f = file;
    const text = ed.get();
    saveBtn.disabled = true;
    stat("Saving…");
    try {
      const content = text.replace(/\n/g, f.eol);
      let r = await invoke<ExecOut>("remote_exec", { sid, command: writeScript(f.path), stdin: content });
      if (r.code && /permission denied/i.test(r.out)) {
        // not ours (e.g. /etc): retry as root with the saved login password
        const pw = await invoke<string>("get_secret", { id: connId });
        if (!pw) throw "Permission denied; save the login password (edit button) to write as root via sudo";
        stat("Saving with sudo…");
        r = await invoke<ExecOut>("remote_exec", { sid, command: sudoWriteScript(f.path), stdin: `${pw}\n${content}` });
      }
      if (r.code) throw r.out.trim() || `exit ${r.code}`;
      f.saved = text;
      if (file !== f) return;
      if (dirty()) onEdit(); // typed more while saving
      else stat(`✓ Saved ${new Date().toLocaleTimeString([], { hour12: false })}`, "text-emerald-400");
      go(cur); // size / modified time
    } catch (err) {
      if (file === f) {
        saveBtn.disabled = false;
        stat(`Save failed: ${err}`, "text-red-400");
      }
    }
  }

  saveBtn.onclick = save;
  q("[data-fprev]").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  });
  q("[data-up]").onclick = () => go(parentOf(cur));
  q("[data-frefresh]").onclick = () => go(cur);
  root.querySelectorAll<HTMLElement>("[data-fnew]").forEach((b) => {
    const dir = b.dataset.fnew === "folder";
    b.onclick = async () => {
      const name = await inputBox(dir ? "New folder" : "New file", joinPath(cur, ""), "Create", dir ? "folder" : "file", dir ? "folder-name" : "filename.txt");
      if (!name) return;
      if (name.includes("/")) return void fail(`Name can't contain "/"`);
      const path = joinPath(cur, name);
      const r = await run(dir ? mkdirScript(path) : newFileScript(path)).catch((e) => ({ out: String(e), code: 1 }));
      await go(cur);
      if (r.code) fail(r.out.trim() || `exit ${r.code}`);
      else if (!dir) preview({ name, dir: false, size: 0, mtime: "" }); // straight into the editor
    };
  });
  q("[data-fextract]").onclick = async () => {
    const path = q("[data-fname]").textContent!;
    stat("Extracting…");
    const r = await run(extractScript(path)).catch((e) => ({ out: String(e), code: 1 }));
    if (r.code) stat(`Extract failed: ${r.out.trim() || `exit ${r.code}`}`, "text-red-400");
    else stat(`✓ Extracted to ${r.out.trim().split("/").pop()}`, "text-emerald-400");
    go(cur);
  };
  // ponytail: whole file read into memory and sent as base64; stream in chunks if multi-GB uploads matter
  q("[data-fup]").onclick = async () => {
    const inp = Object.assign(document.createElement("input"), { type: "file", multiple: true });
    const files = await new Promise<File[]>((res) => {
      inp.onchange = () => res([...(inp.files ?? [])]);
      inp.oncancel = () => res([]);
      inp.click();
    });
    const dir = cur;
    const taken = files.filter((f) => last.some((e) => e.name === f.name));
    if (taken.length && !(await confirmBox("Replace files?", `Already in ${dir}: ${taken.map((f) => f.name).join(", ")}`, "Replace"))) return;
    for (const [i, f] of files.entries()) {
      list.insertAdjacentHTML("afterbegin", `<p data-fupmsg class="px-3 py-2 text-xs text-zinc-400">Uploading ${i + 1}/${files.length}: ${esc(f.name)} (${fmtSize(f.size)})…</p>`);
      const b64 = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).replace(/^[^,]*,/, ""));
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(f);
      });
      const r = await invoke<ExecOut>("remote_exec", { sid, command: uploadScript(joinPath(dir, f.name)), stdin: b64 }).catch((e) => ({ out: String(e), code: 1 }));
      list.querySelector("[data-fupmsg]")?.remove();
      if (r.code) {
        await go(cur);
        return void fail(`Upload of ${f.name} failed: ${r.out.trim() || `exit ${r.code}`}`);
      }
    }
    if (files.length) go(cur);
  };
  q<HTMLFormElement>("[data-fbar]").onsubmit = (e) => (e.preventDefault(), go(input.value.trim() || "~"));
  q("[data-fx]").onclick = async () => {
    if (!(await canLeave())) return;
    file = null;
    onEdit();
    show("body");
    showPrev(false);
  };

  return () => {
    if (!opened) {
      opened = true;
      go("~");
    }
  };
}

// ---------- deploy page (list, YAML editor, apply) ----------

type ExecOut = { out: string; code: number };
type DeployCtx = { sid: number; connId: number; log: (level: LogLevel, text: string) => void };

const SHELL = SHELL_CMD;
const remote = (ctx: DeployCtx, command: string, stdin?: string, stream = false, timeoutMs?: number) =>
  invoke<ExecOut>("remote_exec", { sid: ctx.sid, command, stdin, stream, timeoutMs });

/** Timestamped, coloured log lines appended to `box`. */
function makeLog(box: HTMLElement) {
  return (level: LogLevel, text: string) => {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="whitespace-pre-wrap"><span class="text-zinc-600">${time}</span>  <span class="${LOG_COLOR[level]}">${esc(text)}</span></div>`,
    );
    while (box.childElementCount > 3000) box.firstElementChild!.remove(); // ponytail: cap DOM for long builds
    box.scrollTop = box.scrollHeight;
  };
}

/** Wires the Deploy page of one machine; returns a function to call each time the page is shown. */
function deployPage(ctx: DeployCtx, root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  let current: string | null = null; // selected deployment, null = new
  let shYaml: string | null = null; // YAML kept aside while showing the generated sh
  let opened = false;
  // "easy" = form over the YAML (easy.ts), "yaml" = the code editor. Both edit the same text in `ed`.
  let mode: "easy" | "yaml" = localStorage.deployMode === "yaml" ? "yaml" : "easy";
  const ed = createEditor(q("[data-yaml]"), () => shYaml === null && validate());
  const easy = createEasy(q("[data-easy]"), {
    change: (yaml) => ed.set(yaml),
    pick: (kind, start) => pickRemote(ctx.sid, kind, start),
    envNames: async (file) => (await remote(ctx, scripts.envNames(file))).out.split("\n").filter(Boolean),
    // same shell + env file as a deploy, so pm2 from nvm / a PATH set in the env file is found
    pm2Apps: async (envFrom) => parsePm2((await remote(ctx, SHELL, scripts.pm2Apps(envFrom))).out),
    mounts: async (paths) => parseMounts((await remote(ctx, scripts.mounts(paths))).out),
    icon,
  });
  const flow = createFlow(q("[data-flowbox]"), (text, step) => ctx.log(step ? "step" : "info", `[sim] ${text}`));
  const flowOn = () => !q("[data-flowbox]").classList.contains("hidden");
  /** Shows the form, the code editor or the flow, from the current mode / sh / flow state. */
  const layout = () => {
    const sh = shYaml !== null;
    const fl = flowOn();
    q("[data-easy]").classList.toggle("hidden", sh || fl || mode !== "easy");
    q("[data-yaml]").classList.toggle("hidden", fl || (!sh && mode === "easy"));
    const view = sh ? "sh" : fl ? "flow" : mode;
    root.querySelectorAll<HTMLElement>("[data-v]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === view)));
  };
  const showFlow = (on: boolean) => {
    q("[data-flowbox]").classList.toggle("hidden", !on);
    layout();
    if (!on) return;
    const m = parseManifest(ed.get());
    flow.render(compile(m, { tag: "<tag>", discard: m.targets.map((t) => t.name), sudoPassword: "********" }), `${m.gitUrl} @ ${m.branch ? `branch ${m.branch}` : m.version}`);
  };

  const validate = () => {
    let msg = "";
    try {
      parseManifest(ed.get());
    } catch (e) {
      msg = (e as Error).message;
    }
    q("[data-err]").textContent = msg;
    easy.mark(msg);
    return !msg;
  };
  const showYaml = (text = shYaml ?? ed.get()) => {
    shYaml = null;
    showFlow(false);
    ed.set(text, "manifest");
  };
  /** Switches mode; the form only opens on YAML it can read. */
  const setMode = (m: "easy" | "yaml", remember = true) => {
    if (shYaml !== null) showYaml();
    if (flowOn()) showFlow(false);
    if (m === "easy") {
      const err = easy.load(ed.get());
      if (err) {
        q("[data-err]").textContent = `Fix the YAML before the form can open - ${err}`;
        m = "yaml";
        remember = false;
      }
    }
    mode = m;
    if (remember) localStorage.deployMode = m;
    layout();
    if (m === "yaml") ed.focus();
  };
  const resetDel = () => {
    q("[data-deltext]").textContent = "Delete this deployment";
    delete q("[data-del]").dataset.armed;
  };
  const closeMore = () => (q<HTMLDetailsElement>("[data-more]").removeAttribute("open"), resetDel());
  // the ⋯ menu closes on a click elsewhere or Esc, and an armed delete un-arms
  addEventListener("mousedown", (e) => q("[data-more]").hasAttribute("open") && !q("[data-more]").contains(e.target as Node) && closeMore());
  addEventListener("keydown", (e) => e.key === "Escape" && q("[data-more]").hasAttribute("open") && closeMore());
  const setCurrent = (name: string | null) => {
    current = name;
    q("[data-title]").textContent = name ? `deployments/${name}.yaml` : "New deployment";
    q("[data-delwrap]").classList.toggle("hidden", !name);
    resetDel();
    root.querySelectorAll<HTMLElement>("[data-row]").forEach((b) => b.classList.toggle("is-current", b.dataset.row === name));
  };

  async function select(name: string | null) {
    showYaml(TEMPLATE);
    setCurrent(name);
    if (name) {
      try {
        ed.set((await remote(ctx, scripts.read(name))).out);
      } catch (err) {
        ctx.log("err", `[${name}] cannot read manifest: ${err}`);
      }
    }
    q("[data-err]").textContent = "";
    setMode(localStorage.deployMode === "yaml" ? "yaml" : "easy", false); // the form falls back to YAML if it can't read the file
    if (!q("[data-err]").textContent) validate();
    if (name && running.has(name) && !busy) watch(name);
  }

  /** Re-attaches to a deploy still running on the machine (e.g. started before the connection dropped). */
  async function watch(name: string) {
    ctx.log("info", `[${name}] still deploying on the machine, following its log…`);
    if (validate()) showFlow(true);
    setBusy(true);
    try {
      await followDeploy(ctx, name, flow);
    } finally {
      setBusy(false);
    }
    refresh();
  }

  // ----- list look: icon per deployment + display order, kept on this computer per machine -----
  // ponytail: stale entries of deleted/renamed deployments stay in localStorage (tiny, harmless)
  type Look = { order: string[]; icons: Record<string, string> }; // icons: Lucide names
  const lookKey = `deployLook:${ctx.connId}`;
  const getLook = (): Look => {
    try { return { order: [], icons: {}, ...JSON.parse(localStorage[lookKey] ?? "{}") }; } catch { return { order: [], icons: {} }; }
  };
  const putLook = (l: Look) => (localStorage[lookKey] = JSON.stringify(l));
  const icoHtml = (k?: string) => (k && lucide(k)) || icon("plus", "h-3.5 w-3.5");
  const chooseIcon = async (b: HTMLElement) => {
    const name = b.dataset.ico!, k = await pickIcon();
    if (k === null) return;
    const l = getLook();
    if (k) l.icons[name] = k;
    else delete l.icons[name];
    putLook(l);
    b.innerHTML = icoHtml(k);
    b.classList.toggle("is-empty", !k);
  };
  const saveOrder = () => {
    const l = getLook();
    l.order = [...root.querySelectorAll<HTMLElement>("[data-row]")].map((r) => r.dataset.row!);
    names = l.order;
    putLook(l);
  };

  async function refresh() {
    const list = q("[data-list]");
    list.innerHTML = `<p class="px-3 py-2 text-xs text-zinc-500">Loading…</p>`;
    try {
      // each line: "<name> <tag> ok|failed <date> <time>" or "<name> never"
      const rows = (await remote(ctx, scripts.list)).out.trim().split("\n").filter(Boolean).map((l) => l.split(" "));
      const look = getLook();
      const rank = (n: string) => (look.order.includes(n) ? look.order.indexOf(n) : 1e9); // new ones go last
      rows.sort((a, b) => rank(a[0]) - rank(b[0]));
      names = rows.map((r) => r[0]);
      running = new Set(rows.filter((r) => r[1] === "running").map((r) => r[0]));
      picked = picked.filter((n) => names.includes(n));
      list.innerHTML = rows.length
        ? rows
            .map(([name, ...st]) => `
              <div data-row="${esc(name)}" class="dp-row" draggable="true" title="Drag to reorder (or Alt+↑/↓)">
                <button data-pick="${esc(name)}" class="dp-pick" title="Add to the Apply queue (runs in the order picked)"></button>
                <button data-ico="${esc(name)}" class="dp-ico${look.icons[name] ? "" : " is-empty"}" title="Choose icon">${icoHtml(look.icons[name])}</button>
                <button data-dep="${esc(name)}" class="flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-3 text-left">
                  ${dot(st[1] === "ok" ? "live" : st[1] === "failed" ? "closed" : undefined)}
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-mono text-sm">${esc(name)}</span>
                    <span data-sub class="block truncate text-[11px] text-zinc-500">${esc(st[0] === "never" ? "never deployed" : st[0] === "running" ? "deploying… (open to watch)" : st.join(" "))}</span>
                  </span>
                </button>
              </div>`)
            .join("")
        : `<p class="px-3 py-2 text-xs text-zinc-500">None yet</p>`;
      list.querySelectorAll<HTMLElement>("[data-dep]").forEach((b) => (b.onclick = () => select(b.dataset.dep!)));
      list.querySelectorAll<HTMLElement>("[data-pick]").forEach((b) => (b.onclick = () => togglePick(b.dataset.pick!)));
      list.querySelectorAll<HTMLElement>("[data-ico]").forEach((b) => (b.onclick = () => chooseIcon(b)));
      // reorder: native drag and drop moves the row live, the order is saved when the drag ends
      let dragged: HTMLElement | null = null;
      list.querySelectorAll<HTMLElement>("[data-row]").forEach((row) => {
        row.ondragstart = (e) => {
          dragged = row;
          e.dataTransfer!.effectAllowed = "move";
          e.dataTransfer!.setData("text/plain", row.dataset.row!);
          row.classList.add("is-drag");
        };
        row.ondragover = (e) => {
          if (!dragged || dragged === row) return;
          e.preventDefault();
          const r = row.getBoundingClientRect();
          if (e.clientY > r.top + r.height / 2) row.after(dragged);
          else row.before(dragged);
        };
        row.ondrop = (e) => e.preventDefault();
        row.ondragend = () => {
          row.classList.remove("is-drag");
          dragged = null;
          saveOrder();
        };
        row.onkeydown = (e) => {
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          const sib = e.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
          if (!sib) return;
          e.key === "ArrowUp" ? sib.before(row) : sib.after(row);
          (e.target as HTMLElement).focus();
          saveOrder();
        };
      });
      setCurrent(current);
      paintQueue();
    } catch (err) {
      list.innerHTML = `<p class="px-3 py-2 text-xs text-red-400">${esc(err)}</p>`;
    }
  }

  root.querySelectorAll<HTMLElement>("[data-v]").forEach((b) => {
    const v = b.dataset.v!;
    b.setAttribute("role", "tab");
    b.onclick = () => (v === "flow" ? openFlow() : v === "sh" ? openSh() : setMode(v as "easy" | "yaml"));
  });
  q("[data-new]").onclick = () => select(null);
  q("[data-refresh]").onclick = refresh;
  q("[data-dclear]").onclick = () => (q("[data-dlog]").innerHTML = "");
  q("[data-dmounts]").onclick = async () => {
    const r = await remote(ctx, scripts.mountList).catch((e) => ({ code: 1, out: String(e) }));
    if (r.code) return ctx.log("err", `cannot list mounts: ${r.out.trim()}`);
    ctx.log("step", "mounts (target  source)");
    r.out.trim().split("\n").forEach((l) => ctx.log("info", l));
  };
  // Full screen log: the panel covers the whole window; Esc or the button puts it back.
  const dpanel = q("[data-dpanel]"), dfull = q("[data-dfull]");
  const setFull = (on: boolean) => {
    const log = q("[data-dlog]"), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
    dpanel.classList.toggle("fixed", on);
    dpanel.classList.toggle("inset-0", on);
    dpanel.classList.toggle("z-50", on);
    dpanel.classList.toggle("h-60", !on);
    dpanel.classList.toggle("border-t", !on);
    dfull.innerHTML = on ? `${icon("minimize", "h-3 w-3")} Exit` : `${icon("maximize", "h-3 w-3")} Full`;
    if (atEnd) log.scrollTop = log.scrollHeight; // stay following the newest lines
  };
  setFull(false);
  dfull.onclick = () => setFull(!dpanel.classList.contains("fixed"));
  addEventListener("keydown", (e) => e.key === "Escape" && dpanel.isConnected && dpanel.classList.contains("fixed") && setFull(false));
  // A script file to run by hand in Terminal (gets the interactive shell's PATH, e.g. from ~/.bashrc).
  q("[data-savesh]").onclick = async () => {
    closeMore();
    if (shYaml !== null) showYaml();
    if (!validate()) return;
    const m = parseManifest(ed.get());
    const r = await remote(ctx, scripts.saveSh(m.name, compile(m, { tag: "", discard: [], standalone: true }))).catch((e) => ({ out: String(e), code: 1 }));
    if (r.code) return ctx.log("err", `[${m.name}] cannot save sh: ${r.out.trim()}`);
    const path = `~/EndFroZen/SunCurved/scripts/${m.name}.sh`;
    ctx.log("ok", `[${m.name}] saved ${path} (chmod 700, no password inside)`);
    ctx.log("info", `run it in Terminal:  ${path}${!m.branch && m.version === "tag" ? " <tag>   e.g. v1.2.0" : ""}`);
  };
  // Preview what will actually run on the machine.
  q("[data-manual]").onclick = openManual;
  const openFlow = () => {
    if (flowOn()) return;
    if (shYaml !== null) showYaml();
    if (validate()) showFlow(true);
  };
  const openSh = () => {
    if (shYaml !== null) return;
    if (!validate()) return;
    showFlow(false);
    shYaml = ed.get();
    ed.set(compile(parseManifest(shYaml), { tag: "<chosen at deploy>", discard: [], sudoPassword: "********" }), "sh", true);
    layout();
  };
  // ----- Apply: the open one, or the picked ones as a queue. One at a time per machine. -----
  let busy = false;
  let names: string[] = []; // deployments in the list
  let running = new Set<string>(); // deployments whose run is still going on the machine
  let picked: string[] = []; // queue order = the order they were picked
  const qstate = new Map<string, "wait" | "run" | "ok" | "fail" | "skip">();
  const QTEXT = { wait: "waiting", run: "deploying…", ok: "ok (this queue)", fail: "failed (this queue)", skip: "not run" };
  const setBusy = (on: boolean) => {
    busy = on;
    q<HTMLButtonElement>("[data-apply]").disabled = on;
    paintQueue();
  };
  function togglePick(name: string) {
    if (busy) return;
    picked = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name];
    qstate.clear();
    paintQueue();
  }
  function paintQueue() {
    root.querySelectorAll<HTMLElement>("[data-row]").forEach((row) => {
      const name = row.dataset.row!;
      const k = picked.indexOf(name);
      const b = row.querySelector<HTMLElement>("[data-pick]")!;
      b.textContent = k >= 0 ? String(k + 1) : "";
      b.setAttribute("aria-pressed", String(k >= 0));
      b.toggleAttribute("disabled", busy);
      row.classList.toggle("is-picked", k >= 0);
      const st = qstate.get(name);
      row.dataset.q = st ?? "";
      const sub = row.querySelector<HTMLElement>("[data-sub]")!;
      sub.dataset.orig ??= sub.textContent!;
      sub.textContent = st ? QTEXT[st] : sub.dataset.orig;
    });
    q("[data-list]").classList.toggle("has-picks", picked.length > 0);
    q("[data-qbar]").classList.toggle("hidden", !picked.length);
    q("[data-qcount]").textContent = `${picked.length} selected`;
    q("[data-qlabel]").textContent = busy ? "Running queue…" : `Apply ${picked.length} in order`;
    q<HTMLButtonElement>("[data-qapply]").disabled = busy || !picked.length;
    q<HTMLSelectElement>("[data-qfail]").disabled = busy;
  }
  const qfail = q<HTMLSelectElement>("[data-qfail]");
  qfail.value = localStorage.deployQueueFail === "skip" ? "skip" : "stop";
  qfail.onchange = () => (localStorage.deployQueueFail = qfail.value);
  q("[data-qclear]").onclick = () => {
    if (busy) return;
    picked = [];
    qstate.clear();
    paintQueue();
  };
  q("[data-qall]").onclick = () => {
    if (busy) return;
    picked = [...picked, ...names.filter((n) => !picked.includes(n))];
    qstate.clear();
    paintQueue();
  };

  /** Save without deploying; only metadata.name has to be valid, the rest may be unfinished. */
  const saveDraft = async () => {
    if (busy) return;
    if (shYaml !== null) showYaml();
    const text = ed.get(), name = draftName(text);
    if (!name) return ctx.log("err", "cannot save: YAML must parse and metadata.name must be set (lowercase letters, digits, '-')");
    const r = await remote(ctx, scripts.save(name, text)).catch((e) => ({ out: String(e), code: 1 }));
    if (r.code) return ctx.log("err", `[${name}] cannot save manifest: ${r.out.trim()}`);
    const done = validate();
    ctx.log(done ? "ok" : "warn", `[${name}] saved${done ? "" : " (unfinished, fix before Apply)"}`);
    setCurrent(name);
    refresh();
  };
  q("[data-dsave]").onclick = saveDraft;
  root.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") (e.preventDefault(), saveDraft());
  });

  q("[data-apply]").onclick = async () => {
    if (busy) return;
    if (shYaml !== null) showYaml();
    if (!validate()) return;
    showFlow(true); // watch the steps light up while it runs
    setBusy(true);
    try {
      const p = await prepareDeploy(ctx, ed.get(), true);
      if (p) await runDeploy(ctx, p, flow);
    } finally {
      setBusy(false);
    }
    setCurrent(parseManifest(ed.get()).name);
    refresh();
  };

  /** Asks about every picked deployment first (tag, local changes), then runs them one after another. */
  q("[data-qapply]").onclick = async () => {
    if (busy || !picked.length) return;
    const queue = [...picked];
    const stopOnFail = qfail.value === "stop";
    qstate.clear();
    queue.forEach((n) => qstate.set(n, "wait"));
    setBusy(true);
    ctx.log("info", `queue: ${queue.join(" → ")}  (on failure: ${stopOnFail ? "stop" : "skip to next"})`);
    const ready: Prepared[] = [];
    let ok = 0, failed = 0, lost = false;
    try {
      for (const [k, name] of queue.entries()) {
        // the open one: what's in the editor (saved first, like Apply); the others: as saved on the machine
        const open = name === current && shYaml === null;
        const text = open ? ed.get() : (await remote(ctx, scripts.read(name))).out;
        const p = await prepareDeploy(ctx, text, open, `${k + 1}/${queue.length}`);
        if (p) ready.push(p);
        else qstate.set(name, "skip");
        paintQueue();
      }
      // The whole queue starts on the machine now, each one waiting for the one before, so it carries on
      // if this connection drops. Then we just watch them in order.
      const launched: string[] = [];
      for (const p of ready) {
        if (await launchDeploy(ctx, p, launched[launched.length - 1], stopOnFail)) launched.push(p.m.name);
        else {
          qstate.set(p.m.name, "fail");
          failed++;
          if (stopOnFail) break;
        }
      }
      for (const name of launched) {
        qstate.set(name, "run");
        paintQueue();
        const here = name === current;
        if (here) showFlow(true);
        const code = await followDeploy(ctx, name, here ? flow : undefined);
        if (code === null) { lost = true; break; } // connection lost: the rest keeps going on the machine
        qstate.set(name, code === 0 ? "ok" : code === QUEUE_SKIPPED ? "skip" : "fail");
        if (code === 0) ok++;
        else if (code !== QUEUE_SKIPPED) failed++;
        paintQueue();
      }
    } catch (e) {
      ctx.log("err", `queue: ${e}`);
    } finally {
      const notRun = queue.length - ok - failed;
      if (lost) ctx.log("warn", "queue: still running on the machine; reconnect and open a deployment to watch it");
      else ctx.log(failed ? "err" : "ok", `queue done: ${ok} ok, ${failed} failed${notRun ? `, ${notRun} not run` : ""}`);
      if (!lost) queue.forEach((n) => qstate.get(n) === "wait" && qstate.set(n, "skip"));
      setBusy(false);
      await refresh(); // fresh states from the machine; the queue result stays on the rows until the picks change
    }
  };

  q("[data-del]").onclick = async () => {
    const b = q("[data-del]");
    if (!b.dataset.armed) {
      b.dataset.armed = "1";
      q("[data-deltext]").textContent = "Click again to confirm delete";
      return;
    }
    closeMore();
    if (!current) return;
    const r = await remote(ctx, scripts.remove(current)).catch((e) => ({ out: String(e), code: 1 }));
    ctx.log(r.code ? "err" : "ok", `[${current}] ${r.out.trim()}`);
    await select(null);
    refresh();
  };

  return () => {
    if (!opened) {
      opened = true;
      select(null);
    }
    refresh();
  };
}

// ----- the "are you sure" step: pick a tag, confirm discarding local changes -----

type RunChoice = { tag: string; discard: string[] };
let runResolve: ((c: RunChoice | null) => void) | null = null;

function askRun(m: Manifest, tags: string[], dirty: Map<string, string[]>, label = ""): Promise<RunChoice | null> {
  $("#run-title").textContent = `${label ? `[${label}] ` : ""}Deploy ${m.name}${m.branch ? ` (git pull ${m.branch})` : ""}`;
  const pickTag = !m.branch && m.version === "tag";
  $("#run-tag-wrap").classList.toggle("hidden", !pickTag);
  $<HTMLSelectElement>("#run-tag").innerHTML = (pickTag ? tags : [m.branch ?? m.version])
    .map((t, i) => `<option value="${esc(t)}">${esc(t)}${i === 0 && pickTag ? "  (latest)" : ""}</option>`)
    .join("");
  $("#run-dirty").innerHTML = m.targets
    .filter((t) => dirty.has(t.name))
    .map((t) => {
      const files = `<pre class="mt-2 max-h-32 overflow-auto font-mono text-[11px] text-zinc-400">${esc(dirty.get(t.name)!.join("\n"))}</pre>`;
      const head = `<p class="font-medium">${esc(t.name)}: working tree has local changes</p>`;
      if (t.dirty === "ask")
        return `<div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400">${head}${files}
          <label class="mt-2 flex items-center gap-2 text-zinc-200"><input type="checkbox" data-discard="${esc(t.name)}" class="accent-amber-500" />
          Discard these changes (git reset --hard + git clean -fd)</label></div>`;
      const note = t.dirty === "discard" ? "will be discarded (dirty: discard)" : "deploy will stop here (dirty: fail)";
      return `<div class="rounded-lg border border-zinc-800 p-3 text-sm text-zinc-400">${head}${files}<p class="mt-2 text-xs">${note}</p></div>`;
    })
    .join("");
  const boxes = [...document.querySelectorAll<HTMLInputElement>("#run-dirty [data-discard]")];
  const sync = () => $<HTMLButtonElement>("#run-go").toggleAttribute("disabled", boxes.some((b) => !b.checked));
  boxes.forEach((b) => (b.onchange = sync));
  sync();
  $<HTMLDialogElement>("#run").showModal();
  return new Promise((res) => (runResolve = res));
}

function wireRunDialog() {
  const dlg = $<HTMLDialogElement>("#run");
  const done = (c: RunChoice | null) => {
    dlg.close();
    runResolve?.(c);
    runResolve = null;
  };
  $("#run-cancel").onclick = () => done(null);
  dlg.addEventListener("cancel", (e) => (e.preventDefault(), done(null)));
  $<HTMLFormElement>("#run-form").onsubmit = (e) => {
    e.preventDefault();
    const discard = [...document.querySelectorAll<HTMLInputElement>("#run-dirty [data-discard]")].map((b) => b.dataset.discard!);
    done({ tag: $<HTMLSelectElement>("#run-tag").value, discard });
  };
}

type FlowSink = { step(title?: string): void; end(ok: boolean): void };
/** A deployment ready to run: what was answered in the "are you sure" dialog. */
type Prepared = { m: Manifest; choice: RunChoice };

/** Apply, part 1: save manifest (`save`) -> precheck -> ask. null = cancelled or a problem (already logged).
 *  `label` (e.g. "2/3") shows in the dialog when several deployments are applied in a row. */
async function prepareDeploy(ctx: DeployCtx, text: string, save: boolean, label = ""): Promise<Prepared | null> {
  let m: Manifest;
  try {
    m = parseManifest(text);
  } catch (e) {
    ctx.log("err", `${(e as Error).message}`);
    return null;
  }
  const tag = `[${m.name}]`;
  try {
    if (save) {
      const saved = await remote(ctx, scripts.save(m.name, text));
      if (saved.code) return (ctx.log("err", `${tag} cannot save manifest: ${saved.out.trim()}`), null);
      ctx.log("info", `${tag} manifest saved`);
    }
    ctx.log("info", `${tag} checking ${m.version === "tag" && !m.branch ? "tags and " : ""}working trees…`);
    const pre = await remote(ctx, SHELL, scripts.precheck(m));
    const tags: string[] = [];
    const dirty = new Map<string, string[]>();
    let cur: string[] | null = null;
    for (const line of pre.out.split("\n")) {
      if (line.startsWith("tag ")) tags.push(line.slice(4).trim());
      else if (line.startsWith("dirty ")) dirty.set(line.slice(6).trim(), (cur = []));
      else if (line.startsWith("  ") && cur) cur.push(line.slice(2));
    }
    tags.reverse(); // newest first
    if (m.version === "tag" && !m.branch && !tags.length) return (ctx.log("err", `${tag} no tags found\n${pre.out.trim()}`), null);

    const choice = await askRun(m, tags, dirty, label);
    if (!choice) return (ctx.log("warn", `${tag} cancelled`), null);
    return { m, choice };
  } catch (e) {
    ctx.log("err", `${tag} ${e}`);
    return null;
  }
}

/** Apply, part 2: start on the machine, then watch it. true = deployed. */
async function runDeploy(ctx: DeployCtx, p: Prepared, flow?: FlowSink): Promise<boolean> {
  if (!(await launchDeploy(ctx, p))) return (flow?.end(false), false);
  return (await followDeploy(ctx, p.m.name, flow)) === 0;
}

/** Compiles and starts a deploy on the machine, detached from this connection (`after`: queued behind
 *  that deployment's run). true = started. */
async function launchDeploy(ctx: DeployCtx, { m, choice }: Prepared, after?: string, stopOnFail = true): Promise<boolean> {
  const tag = `[${m.name}]`;
  try {
    let sudoPassword: string | undefined;
    if (m.sudo === "login-password") {
      sudoPassword = await invoke<string>("get_secret", { id: ctx.connId });
      if (!sudoPassword) return (ctx.log("err", `${tag} sudo needs the saved login password; set it with the edit button`), false);
    }
    const script = compile(m, { ...choice, sudoPassword });

    ctx.log("info", `${tag} ${after ? `queued after ${after}` : "deploying"} ${choice.tag}…`);
    // runs on the machine on its own: a dropped connection doesn't stop it, and followDeploy can re-attach
    const r = await remote(ctx, scripts.launch(m.name, after, stopOnFail), script);
    if (r.code) return (ctx.log("err", `${tag} cannot start: ${r.out.trim()}`), false);
    return true;
  } catch (e) {
    ctx.log("err", `${tag} ${e}`);
    return false;
  }
}

/** Streams a deploy's log on the machine from its first line until it ends (works for one started
 *  earlier, e.g. before the connection dropped). Returns its exit code (0 = deployed,
 *  QUEUE_SKIPPED = not run), or null when the connection was lost while watching. */
async function followDeploy(ctx: DeployCtx, name: string, flow?: FlowSink): Promise<number | null> {
  const tag = `[${name}]`;
  const decoder = new TextDecoder();
  let partial = "";
  const emit = (line: string) => {
    if (line.startsWith("==> ")) flow?.step(line.slice(4));
    ctx.log(line.startsWith("==> ") ? "step" : line.startsWith("!! ") ? "err" : line.startsWith(LOG_MARK) ? "note" : "info", line);
  };
  const un = await listen<number[]>(`exec-data-${ctx.sid}`, (e) => {
    const text = decoder.decode(new Uint8Array(e.payload), { stream: true }).split(HEARTBEAT).join("");
    const lines = (partial + text).split(/\r?\n/);
    partial = lines.pop()!;
    lines.filter((l) => l.trim()).forEach(emit);
  });
  try {
    // heartbeat every 10s, so 45s of silence = the link is gone
    const r = await remote(ctx, scripts.follow(name), undefined, true, 45_000);
    if (partial.trim()) emit(partial);
    flow?.end(!r.code);
    const why = r.code === FOLLOW_LOST ? "stopped without finishing (killed or the machine restarted)" : `exit ${r.code}`;
    if (r.code === QUEUE_SKIPPED) ctx.log("warn", `${tag} not run (the one before it in the queue failed)`);
    else ctx.log(r.code ? "err" : "ok", r.code ? `${tag} deploy failed (${why})` : `${tag} deployed`);
    return r.code;
  } catch (e) {
    ctx.log("warn", `${tag} lost the connection while watching (${e}). It keeps running on the machine (and so does the rest of its queue): reconnect and open ${name} to watch it again.`);
    return null;
  } finally {
    un();
  }
}

// ----- folder / file picker on the machine (used by the easy deploy form) -----

const homes = new Map<number, string>(); // sid -> $HOME, to give paths back as ~/...

function pickRemote(sid: number, kind: "dir" | "file", start: string): Promise<string | null> {
  const dlg = $<HTMLDialogElement>("#picker");
  const list = $("#pick-list");
  const input = $<HTMLInputElement>("#pick-path");
  const run = (path: string) => invoke<ExecOut>("remote_exec", { sid, command: listScript(path) }).catch((e) => ({ out: String(e), code: 1 }));
  const tilde = (abs: string) => {
    const h = homes.get(sid);
    return h && (abs === h || abs.startsWith(h + "/")) ? "~" + abs.slice(h.length) : abs;
  };
  let cur = "/";
  let gen = 0;

  return new Promise((resolve) => {
    const done = (v: string | null) => {
      gen++;
      dlg.close();
      resolve(v);
    };
    async function go(path: string, fallback = true) {
      const me = ++gen;
      list.innerHTML = `<p class="px-3 py-2 text-xs text-zinc-500">Loading…</p>`;
      const r = await run(path);
      if (me !== gen) return;
      if (!r.out.startsWith("/")) {
        if (fallback) return go("~", false); // start path missing: begin at home
        list.innerHTML = `<p class="px-3 py-2 font-mono text-xs text-red-400">${esc(r.out.trim() || `exit ${r.code}`)}</p>`;
        return;
      }
      const { path: abs, entries } = parseListing(r.out);
      cur = abs;
      input.value = tilde(abs);
      list.innerHTML = entries.length
        ? entries
            .map((e, i) => {
              const off = kind === "dir" && !e.dir;
              return `<button data-pi="${i}" ${off ? "disabled" : ""} class="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm enabled:hover:bg-zinc-800 disabled:opacity-35 ${e.name.startsWith(".") ? "opacity-60" : ""}">
                ${appArt(e.dir ? "folder" : "file", "h-6 w-6", fileColor(e.name))}<span class="truncate">${esc(e.name)}</span></button>`;
            })
            .join("")
        : `<p class="px-3 py-6 text-center text-xs text-zinc-600">Empty folder</p>`;
      list.querySelectorAll<HTMLElement>("[data-pi]").forEach((b) => {
        const e = entries[+b.dataset.pi!];
        b.onclick = () => (e.dir ? go(joinPath(cur, e.name)) : done(tilde(joinPath(cur, e.name))));
      });
    }

    $("#pick-title").textContent = kind === "dir" ? "Choose a folder" : "Choose a file";
    $("#pick-ok").classList.toggle("hidden", kind !== "dir");
    $("#pick-ok").onclick = () => done(tilde(cur));
    $("#pick-cancel").onclick = () => done(null);
    $("#pick-up").onclick = () => go(parentOf(cur));
    $<HTMLFormElement>("#pick-bar").onsubmit = (e) => (e.preventDefault(), go(input.value.trim() || "~"));
    dlg.oncancel = (e) => (e.preventDefault(), done(null));
    dlg.showModal();
    const home = homes.has(sid) ? Promise.resolve() : run("~").then((r) => void (r.out.startsWith("/") && homes.set(sid, r.out.split("\n")[0])));
    home.then(() => go(start || "~"));
  });
}

/** Our own yes/no dialog (no native confirm). Resolves true on the OK button. */
function confirmBox(title: string, text: string, ok: string) {
  const dlg = $<HTMLDialogElement>("#confirm");
  document.querySelectorAll("#confirm-input, #confirm [data-inonly]").forEach((el) => el.classList.add("hidden"));
  $("#confirm-icon").innerHTML = icon("x", "h-[18px] w-[18px]");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-text").className = "text-sm text-zinc-400";
  $("#confirm-ok").textContent = ok;
  $<HTMLButtonElement>("#confirm-ok").disabled = false;
  dlg.returnValue = "";
  dlg.showModal();
  $("#confirm-ok").focus();
  return new Promise<boolean>((res) => dlg.addEventListener("close", () => res(dlg.returnValue === "ok"), { once: true }));
}

/** confirmBox with a text field; resolves to the trimmed value, or "" on cancel. */
async function inputBox(title: string, where: string, ok: string, kind: "file" | "folder", placeholder: string) {
  const inp = $<HTMLInputElement>("#confirm-input");
  const okBtn = $<HTMLButtonElement>("#confirm-ok");
  const done = confirmBox(title, where, ok);
  $("#confirm-icon").innerHTML = icon(kind, "h-[18px] w-[18px]");
  $("#confirm-text").className = "truncate rounded-md bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-500"; // path chip
  $("#confirm-text").title = where;
  inp.value = "";
  inp.placeholder = placeholder;
  document.querySelectorAll("#confirm-input, #confirm [data-inonly]").forEach((el) => el.classList.remove("hidden"));
  okBtn.disabled = true;
  inp.oninput = () => (okBtn.disabled = !inp.value.trim());
  inp.focus();
  // Enter would submit via the first button (Cancel), so close as OK ourselves
  inp.onkeydown = (e) => void (e.key === "Enter" && (e.preventDefault(), inp.value.trim() && $<HTMLDialogElement>("#confirm").close("ok")));
  return (await done) ? inp.value.trim() : "";
}

function closeTab(key: number) {
  const i = tabs.findIndex((t) => t.key === key);
  if (i < 0) return;
  tabs[i].close();
  tabs[i].pane.remove();
  tabs.splice(i, 1);
  if (activeKey === key) activeKey = (tabs[i] ?? tabs[i - 1])?.key ?? 0;
  renderTabs();
  renderList();
}

/** Bottom-left path (#path): which app / machine / page / file is on screen. app() sets pathOf. */
let pathOf = () => "/";
function showWhere() {
  const el = $("#path"), p = pathOf();
  if (el.textContent === p) return;
  el.textContent = p;
  // collapsed width (max 22rem), so status bars can start their text right after the path
  document.documentElement.style.setProperty("--path-w", `${Math.min(el.scrollWidth, 22 * 16)}px`);
}
// hover shows the whole path (CSS); click copies it
addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("#path");
  if (!el) return;
  void navigator.clipboard.writeText(el.textContent ?? "").then(() => {
    el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 900);
  });
});

function renderTabs() {
  $("#tabs").innerHTML = tabs.map((t) => `
    <div data-tab="${t.key}" class="group flex max-w-56 cursor-pointer items-center gap-2 rounded-t-lg border-x border-t px-3 py-2 text-sm ${
      t.key === activeKey ? "border-zinc-800 bg-zinc-950 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
    }">
      ${dot(t.status)}
      <span class="truncate">${esc(t.conn.name)}</span>
      ${t.status === "closed" ? `<button data-re="${t.key}" title="Reconnect" class="rounded p-1 text-amber-400 hover:bg-zinc-800">${icon("refresh", "h-3.5 w-3.5")}</button>` : ""}
      <button data-x="${t.key}" title="Close" class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">${icon("x", "h-3.5 w-3.5")}</button>
    </div>`).join("");

  tabs.forEach((t) => t.pane.classList.toggle("hidden", t.key !== activeKey));
  showWhere();
  if (!tabs.length) {
    $("#stage").querySelector("#empty")?.remove();
    $("#stage").insertAdjacentHTML("beforeend", `
      <div id="empty" class="absolute inset-0 grid place-items-center">
        <div class="text-center">
          <div class="mx-auto mb-4 w-fit">${logo("h-20 w-20")}</div>
          <p class="font-medium">No open machines</p>
          <p class="mt-1 text-sm text-zinc-500">Pick a server on the left, or add a new one.</p>
          <button id="add2" class="mt-5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400">+ New connection</button>
        </div>
      </div>`);
    $("#add2").onclick = () => $("#add").click();
  } else {
    $("#stage").querySelector("#empty")?.remove();
  }

  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) =>
    (el.onclick = () => {
      activeKey = +el.dataset.tab!;
      renderTabs();
    }));
  document.querySelectorAll<HTMLElement>("[data-x]").forEach((b) =>
    (b.onclick = async (e) => {
      e.stopPropagation();
      const t = tabs.find((t) => t.key === +b.dataset.x!);
      if (!t) return;
      // A dead connection has nothing to lose; only ask when it's still open.
      if (t.status !== "closed" && !(await confirmBox(`Close ${t.conn.name}?`, "The SSH session and its terminal will be disconnected.", "Disconnect"))) return;
      closeTab(t.key);
    }));
  document.querySelectorAll<HTMLElement>("[data-re]").forEach((b) =>
    (b.onclick = (e) => (e.stopPropagation(), connect(tabs.find((t) => t.key === +b.dataset.re!)!))));
}

app();

/** Offline manual: bundled markdown (src/manual.md), rendered on first open. */
function openManual() {
  const body = $("#manual-body");
  if (!body.innerHTML) body.innerHTML = marked.parse(manualMd, { async: false });
  $<HTMLDialogElement>("#manual").showModal();
}
