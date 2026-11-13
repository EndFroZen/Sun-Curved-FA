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
import { createMdEditor } from "./mdedit";
import { createSqlEditor } from "./sqledit";
import manualMd from "./manual.md?raw";
import { fmtSize, joinPath, listScript, parentOf, parseListing, PREVIEW_BYTES, readScript, MEDIA_MAX, mimeFor, mediaScript, writeScript, sudoWriteScript, newFileScript, mkdirScript, modeFor, type Entry } from "./files";
import { arg, colsSql, connUrl, dbsSql, DEFAULTS, deleteSql, fromUrl, insertSql, isRead, KIND_LABEL, objectsSql, qid, schemaSql, selectSql, statements, toCsv, toUrl, toXlsx, tunnelOf, updateSql, viaLocal, withDb, withPw, type Col, type ConnForm, type Dialect, type Kind } from "./basecurves";
import { cdLine, CRON_READ, CRON_WRITE, parseCrontab, serializeCrontab, validSched, type CronLine } from "./cron";
import { parseStats, STATS_SCRIPT, type Cpu, type Stats } from "./stats";
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { parseHeaders, pretty, withScheme } from "./post";
import { lucide, pickIcon } from "./iconpick";

type Conn = { id: number; name: string; host: string; port: number; user: string; key_path: string };
type Status = "connecting" | "live" | "closed";

const db = await Database.load("sqlite:suncurved.db");
await db.execute(`CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22, user TEXT NOT NULL, key_path TEXT NOT NULL DEFAULT '')`);
await db.execute("CREATE TABLE IF NOT EXISTS wallpapers (conn_id INTEGER PRIMARY KEY, data TEXT NOT NULL)");

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
  none: "", // blank slot keeps menu labels aligned
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  arrowUp: '<path d="m5 12 7-7 7 7M12 19V5"/>',
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
    <div id="path" class="pointer-events-none fixed bottom-2 left-3 z-[70] max-w-[60vw] truncate px-2 py-0.5 font-mono text-[11px] text-zinc-500"></div>
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
            ["bc-new", "plug", "Connection", "New connection", "text-sky-400"],
            ["bc-newq", "code", "New Query", "New query tab", "text-amber-400"],
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
            ${[["objects", "grid", "Objects"], ["data", "table", ""], ["query", "code", "Query"]].map(([v, ic, label]) =>
              `<button data-v="${v}" class="flex max-w-56 items-center gap-1.5 truncate rounded-t-lg border border-b-0 border-transparent px-3 py-1.5 text-zinc-400 hover:text-zinc-100 [&.on]:border-zinc-800 [&.on]:bg-zinc-950 [&.on]:text-zinc-100 ${v === "data" ? "hidden" : ""}">${icon(ic as keyof typeof ICONS, "h-3.5 w-3.5")}<span class="truncate">${label}</span>${v === "data" ? `<span data-close title="Close" class="-mr-1 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">${icon("x", "h-3 w-3")}</span>` : ""}</button>`).join("")}
          </div>

          <section data-view="objects" class="flex min-h-0 flex-1 flex-col">
            <div class="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1 text-xs">
              ${tb("bc-o-open", "table", "Open Table")}${tb("bc-o-new", "plus", "New Table")}${tb("bc-o-drop", "trash", "Delete Table")}${tb("bc-o-csv", "download", "Export Wizard")}
              <label class="ml-auto flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-zinc-500 focus-within:border-amber-500">${icon("search", "h-3.5 w-3.5")}
                <input id="bc-o-q" placeholder="Search" class="w-40 bg-transparent text-zinc-100 outline-none" /></label>
            </div>
            <div id="bc-objects" class="min-h-0 flex-1 overflow-auto"></div>
          </section>

          <section data-view="data" class="hidden min-h-0 flex-1 flex-col">
            <div class="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1 text-xs">
              ${tb("bc-add", "plus", "Add Row")}${tb("bc-d-refresh", "refresh", "Refresh")}${tb("bc-d-csv", "download", "Export")}
              <span class="ml-2 text-zinc-500">Edit a cell and press Enter to save · right-click a row for more</span>
            </div>
            <div id="bc-grid" class="min-h-0 flex-1 overflow-auto"></div>
          </section>

          <section data-view="query" class="hidden min-h-0 flex-1 flex-col">
            <div class="flex shrink-0 items-end gap-1 border-b border-zinc-800 px-2 pt-1 text-xs">
              <div id="bc-qtabs" class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"></div>
              <div class="flex items-center gap-1 pb-1">
                <button id="bc-run" title="Run statement at cursor (Ctrl+Enter)" class="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-500">${icon("play", "h-3.5 w-3.5")} Run</button>
                <button id="bc-runall" title="Run the whole tab (Ctrl+Shift+Enter)" class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-zinc-300 hover:bg-zinc-800">${icon("playAll", "h-3.5 w-3.5")} Run all</button>
              </div>
            </div>
            <div id="bc-editor" class="h-64 shrink-0 overflow-hidden"></div>
            <div id="bc-split" title="Drag to resize" class="h-1.5 shrink-0 cursor-row-resize border-y border-zinc-800 bg-zinc-900 hover:bg-amber-500/40"></div>
            <div class="flex shrink-0 items-center border-b border-zinc-800 px-2 py-0.5 text-xs"><span class="text-zinc-500">Results</span><span class="ml-auto">${tb("bc-q-csv", "download", "Export results")}</span></div>
            <div id="bc-qgrid" class="min-h-0 flex-1 overflow-auto"><p class="py-10 text-center text-sm text-zinc-600">Ctrl+Enter runs the statement under the cursor · Ctrl+Space suggests tables and columns</p></div>
          </section>

          <footer class="flex shrink-0 items-center gap-3 border-t border-zinc-800 bg-zinc-900 px-3 py-1 font-mono text-[11px] text-zinc-500">
            <span id="bc-spin" class="hidden">${spinner("h-3 w-3")}</span><span id="bc-msg" class="min-w-0 flex-1 truncate"></span>
            <span id="bc-where" class="truncate"></span>
          </footer>
        </main>
      </div>
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
        <span id="np-info" class="ml-auto font-mono text-xs text-zinc-500"></span>
        <button id="np-newdir" title="New folder" class="ml-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">${icon("folder")} Folder</button>
        <button id="np-new" title="New note" class="ml-3 flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-amber-400">${icon("plus")} New</button>
      </div>
      <div class="mt-6 flex min-h-0 flex-1 gap-6">
        <aside id="np-side" class="w-[10%] min-w-40 shrink-0 overflow-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-3"></aside>
        <div class="flex min-w-0 flex-1 flex-col">
      <div id="np-list" class="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,7.5rem)] content-start gap-2 overflow-auto p-1"></div>
      <textarea id="np-text" spellcheck="false" placeholder="Type anything…" class="hidden min-h-0 flex-1 resize-none rounded-2xl border border-zinc-800 bg-zinc-900 p-5 font-mono text-sm leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500"></textarea>
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
  // ponytail: one level of folders (no folders inside folders), add nesting if people ask
  let npDirs: string[] = [];
  try { npDirs = JSON.parse(localStorage.notepadFolders ?? "[]"); } catch {}
  let npDir: string | null = null; // folder being viewed, null = top level
  const npSaveDirs = () => (localStorage.notepadFolders = JSON.stringify(npDirs));
  const npPage = $("#notepad"), npText = $<HTMLTextAreaElement>("#np-text"), npList = $("#np-list");
  let notes: Note[] = [];
  try { notes = JSON.parse(localStorage.notepadFiles ?? "[]"); } catch {} // corrupt → start empty
  if (localStorage.notepad) notes.push({ id: Date.now(), name: "Note", text: localStorage.notepad, t: Date.now() }); // from the one-note version
  localStorage.removeItem("notepad");
  let npOpen: Note | null = null;
  const npSave = () => (localStorage.notepadFiles = JSON.stringify(notes));
  const stamp = (t: number) => new Date(t).toLocaleString("sv").slice(0, 16); // 2026-11-12 15:30
  const npInfo = () => (showWhere(),
    $("#np-info").textContent = npOpen
      ? `${npOpen.folder ? `${npOpen.folder} / ` : ""}${npOpen.name} · ${npText.value.split("\n").length} lines · ${npText.value.length} chars`
      : npDir ? `${npDir} · ${notes.filter((n) => n.folder === npDir).length} notes` : `${notes.length} notes`);
  // sidebar: pinned notes/folders ("n:<id>" | "d:<name>") + the 10 most recently opened notes (ids, newest first)
  const npLoad = (k: string): (string | number)[] => {
    try { return JSON.parse(localStorage[k] ?? "[]"); } catch { return []; }
  };
  let npPins = npLoad("notepadPins") as string[], npRecent = npLoad("notepadRecent") as number[];
  const npSaveSide = () => ((localStorage.notepadPins = JSON.stringify(npPins)), (localStorage.notepadRecent = JSON.stringify(npRecent)));
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
    if (note) contextMenu(e, [["Open", "file", () => npShow(note)], npPinItem(note), ...(npRecent.includes(note.id) ? [["Remove from recent", "x", () => ((npRecent = npRecent.filter((id) => id !== note.id)), npSaveSide(), npSideDraw())] as MenuItem] : [])]);
    else if (d) contextMenu(e, [["Open", "folder", () => ((npDir = d), npShow(null))], npPinItem(d)]);
    else e.preventDefault();
  };
  const npShow = (n: Note | null) => {
    npOpen = n;
    npList.classList.toggle("hidden", !!n);
    npText.classList.toggle("hidden", !n);
    $("#np-new").classList.toggle("hidden", !!n);
    $("#np-newdir").classList.toggle("hidden", !!n || !!npDir);
    if (n) npRecent = [n.id, ...npRecent.filter((id) => id !== n.id)].slice(0, 10), npSaveSide();
    npSideDraw();
    if (n) (npText.value = n.text), npText.focus();
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
        here.map(([n, i]) => `<button data-n="${i}" title="${esc(n.name)}\n${esc(n.text.slice(0, 200))}" class="flex flex-col items-center gap-1 rounded-xl border border-transparent p-2 text-center transition hover:border-amber-500/40 hover:bg-amber-500/10 focus-visible:border-amber-500/60 focus-visible:outline-none">
            ${npNoteSvg()}
            <span class="line-clamp-2 w-full break-words text-xs">${esc(n.name)}</span></button>`).join("")
      : `<p class="col-span-full grid h-60 place-items-center text-sm text-zinc-500">${npDir ? "Empty folder. Press New to add a note here." : "No notes yet. Press New or right-click → New note."}</p>`;
    npSideDraw(); // names/moves/deletes show in the sidebar too
  };
  const npNew = () => {
    const n: Note = { id: Date.now(), name: stamp(Date.now()), text: "", t: Date.now(), folder: npDir ?? undefined };
    notes.push(n);
    npSave();
    npShow(n);
  };
  const npOpenDir = (d: string | null) => ((npDir = d), npShow(null));
  const npNewDir = async () => {
    const name = await inputBox("New folder", "Notepad", "Create", "folder", "Folder name");
    if (!name || npDirs.includes(name)) return;
    npDirs.push(name);
    npDirs.sort((a, b) => a.localeCompare(b));
    npSaveDirs();
    npDraw();
    npInfo();
  };
  const npRenameDir = async (d: string) => {
    const ask = inputBox("Rename folder", d, "Rename", "folder", "Folder name");
    $<HTMLInputElement>("#confirm-input").value = d;
    $<HTMLButtonElement>("#confirm-ok").disabled = false;
    const name = await ask;
    if (!name || name === d || npDirs.includes(name)) return;
    npDirs = npDirs.map((x) => (x === d ? name : x));
    notes.forEach((n) => n.folder === d && (n.folder = name));
    npPins = npPins.map((p) => (p === `d:${d}` ? `d:${name}` : p));
    npSaveSide();
    npSaveDirs();
    npSave();
    npDraw();
  };
  const npMoveItems = (n: Note): MenuItem[] => [
    ...npDirs.filter((d) => d !== n.folder).map((d): MenuItem => [`Move to ${d}`, "folder", () => ((n.folder = d), npSave(), npDraw(), npInfo())]),
    ...(n.folder ? [[`Move out of ${n.folder}`, "folder", () => ((n.folder = undefined), npSave(), npDraw(), npInfo())] as MenuItem] : []),
  ];
  const npRename = async (n: Note) => {
    const ask = inputBox("Rename note", n.name, "Rename", "file", "Note name");
    $<HTMLInputElement>("#confirm-input").value = n.name; // start from the current name
    $<HTMLButtonElement>("#confirm-ok").disabled = false;
    const name = await ask;
    if (name) (n.name = name), npSave(), npDraw();
  };
  npText.oninput = () => {
    if (!npOpen) return;
    npOpen.text = npText.value;
    npOpen.t = Date.now();
    npSave();
    npInfo();
  };
  npText.onkeydown = (e) => {
    if (e.key !== "Tab") return; // Tab types a tab instead of leaving the box
    e.preventDefault();
    npText.setRangeText("\t", npText.selectionStart, npText.selectionEnd, "end");
    npText.dispatchEvent(new Event("input"));
  };
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
            notes = notes.filter((x) => x !== n);
            npSave();
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
              npDirs = npDirs.filter((x) => x !== d);
              notes.forEach((n) => n.folder === d && (n.folder = undefined)); // keep the notes, just unfile them
              npSaveDirs();
              npSave();
              npDraw();
              npInfo();
            }],
          ]
        : blank);
  };
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
  let dbConns: DbConn[] = [];
  const bcMsg = (s: string, bad = false) => (($("#bc-msg").textContent = s), $("#bc-msg").classList.toggle("text-red-400", bad));
  // Loading feedback: spinner in the status bar while anything runs, and a centred one in the pane being filled.
  let bcBusyN = 0, bcConnecting = 0;
  const bcBusy = (d: 1 | -1) => $("#bc-spin").classList.toggle("hidden", (bcBusyN = Math.max(0, bcBusyN + d)) === 0);
  const loading = (el: HTMLElement, text: string) =>
    (el.innerHTML = `<div class="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-sm text-zinc-500">${spinner("h-8 w-8")}<span class="animate-pulse">${esc(text)}</span></div>`);
  const bcConn = () => dbConns.find((c) => c.id === bcCid);
  const kindOf = (c: DbConn) => fromUrl(c.url).kind;
  const KIND_COLOR: Record<Kind, string> = { postgres: "#336791", mysql: "#00758f", mariadb: "#c0765a", sqlite: "#0f80cc" };
  const badge = (k: Kind) => `<span title="${KIND_LABEL[k]}" class="grid h-5 w-5 shrink-0 place-items-center rounded-md text-white shadow" style="background:${KIND_COLOR[k]}">${icon("database", "h-3 w-3")}</span>`;
  const caret = (open: boolean) => `<span class="w-3 shrink-0 text-zinc-500">${icon(open ? "arrowDown" : "chevronRight", "h-3 w-3")}</span>`;

  // ----- views -----
  type View = "objects" | "data" | "query";
  let bcV: View = "objects"; // shown in the bottom-left path
  const bcView = (v: View) => {
    bcV = v;
    bc.querySelectorAll<HTMLElement>("[data-view]").forEach((s) => (s.classList.toggle("hidden", s.dataset.view !== v), s.classList.toggle("flex", s.dataset.view === v)));
    $("#bc-views").querySelectorAll<HTMLElement>("[data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    $("#bc-v-objects").classList.toggle("on", v === "objects");
    $("#bc-v-query").classList.toggle("on", v === "query");
    if (v === "query") bcEditor.focus();
  };
  $("#bc-views").onclick = (e) => {
    if ((e.target as HTMLElement).closest("[data-close]")) return bcCloseData();
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-v]");
    if (b) bcView(b.dataset.v as View);
  };
  // Drag the bar between the SQL editor and the results to resize both.
  $("#bc-split").onpointerdown = (e) => {
    const ed = $("#bc-editor"), split = e.currentTarget as HTMLElement, y0 = e.clientY, h0 = ed.offsetHeight;
    const max = ed.parentElement!.clientHeight - 80; // keep some of the results visible
    split.setPointerCapture(e.pointerId);
    split.onpointermove = (m) => (ed.style.height = `${Math.max(48, Math.min(max, h0 + m.clientY - y0))}px`);
    split.onpointerup = () => (split.onpointermove = null);
  };
  $("#bc-split").ondblclick = () => ($("#bc-editor").style.height = ""); // back to default
  $("#bc-v-objects").onclick = () => bcView("objects");
  $("#bc-v-query").onclick = () => bcView("query");
  const bcStatus = () => {
    const c = bcConn();
    $("#bc-badge").innerHTML = bcOn && c
      ? `${badge(kindOf(c))}<span class="text-zinc-200">${esc(c.name)}</span><span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>`
      : `${icon("unplug", "h-3.5 w-3.5")} Not connected`;
    $("#bc-where").textContent = bcOn && c ? [c.name, bcCurDb, bcTable].filter(Boolean).join(" › ") : "";
    for (const id of ["#bc-v-objects", "#bc-refresh", "#bc-disconnect"]) $<HTMLButtonElement>(id).disabled = !bcOn;
  };

  // ----- grid (table data, query results, objects) -----
  const fmt = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const TH = "sticky top-0 z-10 border-b border-r border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left text-xs font-semibold text-zinc-400 whitespace-nowrap";
  const TD = "border-b border-r border-zinc-800/70 px-2 py-1 font-mono text-[13px] whitespace-nowrap max-w-md overflow-hidden text-ellipsis";
  const bcGrid = (el: HTMLElement, rows: Row[], editable: boolean) => {
    const cols = rows.length ? Object.keys(rows[0]).filter((c) => c !== "__rowid") : [];
    const cell = (r: Row, c: string) => r[c] === null
      ? editable ? `<td class="border-b border-r border-zinc-800/70 p-0"><input data-c="${esc(c)}" placeholder="NULL" class="w-full min-w-24 bg-transparent px-2 py-1 font-mono text-[13px] outline-none placeholder:italic placeholder:text-zinc-600 focus:bg-amber-500/10" /></td>`
        : `<td class="${TD} italic text-zinc-600">NULL</td>`
      : editable ? `<td class="border-b border-r border-zinc-800/70 p-0"><input data-c="${esc(c)}" value="${esc(fmt(r[c]))}" class="w-full min-w-24 bg-transparent px-2 py-1 font-mono text-[13px] outline-none focus:bg-amber-500/10" /></td>`
      : `<td class="${TD}" title="${esc(fmt(r[c]))}">${esc(fmt(r[c]))}</td>`;
    el.innerHTML = rows.length
      ? `<table class="min-w-full border-collapse"><thead><tr><th class="${TH} w-10 text-right">#</th>${cols.map((c) => `<th class="${TH}">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r, i) => `<tr data-k="${editable ? esc(JSON.stringify(bcKey(r))) : ""}" class="group odd:bg-zinc-900/40 hover:bg-zinc-800/60">
            <td class="border-b border-r border-zinc-800/70 px-1 text-right font-mono text-[11px] text-zinc-600">${i + 1}</td>${cols.map((c) => cell(r, c)).join("")}</tr>`)
          .join("")}</tbody></table>`
      : `<p class="py-10 text-center text-sm text-zinc-600">No rows</p>`;
  };
  const bcKey = (r: Row) => (bcD === "sqlite" ? [r.__rowid] : bcKeys.map((k) => r[k.name]));
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
    const row = (lvl: number, attrs: string, inner: string, on = false) =>
      `<div ${attrs} style="padding-left:${0.25 + lvl * 1}rem" class="group flex cursor-pointer select-none items-center gap-1.5 rounded-md py-1 pr-1.5 hover:bg-zinc-800 ${on ? "bg-amber-500/15 text-amber-200" : ""}">${inner}</div>`;
    const tables = (lvl: number) => {
      const ts = bcObjs.filter((o) => String(o.name).toLowerCase().includes(f));
      return ts.map((o) => row(lvl, `data-t="${esc(o.name)}" title="${esc(o.name)}"`,
        `<span class="w-3"></span><span class="${o.type === "view" ? "text-sky-400" : "text-emerald-400"}">${icon(o.type === "view" ? "grid" : "table", "h-3.5 w-3.5")}</span><span class="truncate">${esc(o.name)}</span>`, o.name === bcTable)).join("")
        || `<p style="padding-left:${1.5 + lvl}rem" class="py-1 text-xs text-zinc-600">${f ? "No match" : "No tables"}</p>`;
    };
    $("#bc-tree").innerHTML = dbConns.map((c) => {
      const active = c.id === bcCid && bcOn, open = active && !bcCollapsed, k = kindOf(c);
      let html = row(0, `data-cid="${c.id}" title="${esc(c.url)}"`,
        `${bcConnecting === c.id ? spinner("h-3 w-3") : caret(open)}${badge(k)}<span class="min-w-0 flex-1 truncate ${active ? "font-medium text-zinc-100" : ""}">${esc(c.name)}</span>
         ${active ? `<span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>` : ""}`);
      if (!open) return html;
      if (bcD === "sqlite") return html + tables(1);
      for (const n of bcDbList) {
        const cur = n === bcCurDb, show = cur && (bcDbOpen || !!f); // a filter unfolds the current database
        html += row(1, `data-db="${esc(n)}"`, `${caret(show)}<span class="text-amber-400">${icon("database", "h-3.5 w-3.5")}</span><span class="truncate ${cur ? "text-zinc-100" : "text-zinc-400"}">${esc(n)}</span>`);
        if (show) html += tables(2);
      }
      return html;
    }).join("") || `<div class="px-3 py-6 text-center text-xs text-zinc-500">No connections yet<br><button id="bc-first" class="mt-3 rounded-lg bg-amber-500 px-3 py-1.5 font-medium text-black hover:bg-amber-400">+ New Connection</button></div>`;
    document.getElementById("bc-first")?.addEventListener("click", () => bcEdit());
  };
  $("#bc-tree-q").oninput = bcTree;
  const bcList = async () => {
    dbConns = await db.select<DbConn[]>("SELECT * FROM db_conns ORDER BY name");
    bcTree();
  };
  $("#bc-tree").onclick = async (e) => {
    const t = e.target as HTMLElement;
    const tb_ = t.closest<HTMLElement>("[data-t]"), dbr = t.closest<HTMLElement>("[data-db]"), cr = t.closest<HTMLElement>("[data-cid]");
    if (tb_) return bcLoad(tb_.dataset.t!);
    if (dbr) return dbr.dataset.db === bcCurDb ? ((bcDbOpen = !bcDbOpen), bcTree()) : bcConnect(withDb(bcUrl, dbr.dataset.db!), bcCid, true);
    const c = dbConns.find((x) => x.id === +cr?.dataset.cid!);
    if (!c) return;
    if (c.id === bcCid && bcOn) return (bcCollapsed = !bcCollapsed), bcTree();
    bcOpenConn(c);
  };
  const bcDelConn = async (c: DbConn) => {
    if (!(await confirmBox("Delete connection?", c.name, "Delete"))) return;
    if (c.id === bcCid) await bcDisconnect();
    await db.execute("DELETE FROM db_conns WHERE id=$1", [c.id]);
    await invoke("del_secret", { id: dbSecret(c.id) });
    bcList();
  };
  const bcOpenConn = async (c: DbConn) => {
    let pw = await invoke<string>("get_secret", { id: dbSecret(c.id) });
    if (!pw && kindOf(c) !== "sqlite") {
      const p = await askPw(c.name);
      if (p === null) return;
      pw = p;
    }
    bcConnect(withPw(c.url, pw), c.id);
  };

  // ----- right-click menus (shared contextMenu) -----
  const tableMenu = (name: string): MenuItem[] => [
    ["Open Table", "table", () => bcLoad(name)],
    ["Query Table", "code", () => (bcEditor.newTab(`SELECT * FROM ${qid(bcD, name)} LIMIT 100;`), bcView("query"))],
    ...exportItems(name, tableRows(name), "Export "),
    ["Copy Name", "file", () => navigator.clipboard.writeText(name)],
    ["Delete Table", "trash", () => bcDrop(name)],
  ];
  $("#bc-tree").oncontextmenu = (e) => {
    const t = e.target as HTMLElement, tr = t.closest<HTMLElement>("[data-t]"), dbr = t.closest<HTMLElement>("[data-db]");
    const c = dbConns.find((x) => x.id === +t.closest<HTMLElement>("[data-cid]")?.dataset.cid!);
    if (tr) return contextMenu(e, tableMenu(tr.dataset.t!));
    if (dbr) {
      const name = dbr.dataset.db!, cur = name === bcCurDb;
      return contextMenu(e, [
        cur ? ["Refresh", "refresh", () => $("#bc-refresh").click()] : ["Open Database", "database", () => bcConnect(withDb(bcUrl, name), bcCid, true)],
        ["Copy Name", "file", () => navigator.clipboard.writeText(name)],
      ]);
    }
    if (!c) return e.preventDefault();
    const on = c.id === bcCid && bcOn;
    contextMenu(e, [
      on ? ["Close Connection", "unplug", () => bcDisconnect()] : ["Open Connection", "plug", () => bcOpenConn(c)],
      ...(on ? [["New Query", "code", () => (bcEditor.newTab(""), bcView("query"))] as MenuItem] : []),
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
  const cellMenu = (e: MouseEvent, editable: boolean) => {
    const t = e.target as HTMLElement, td = t.closest("td"), tr = t.closest("tr");
    if (!td || !tr || !tr.closest("tbody")) return e.preventDefault();
    const inp = td.querySelector<HTMLInputElement>("input[data-c]");
    const val = inp ? inp.value : td.textContent ?? "";
    const k = editable ? rowKey(tr) : null;
    const rowCsv = () => [...tr.querySelectorAll("td")].slice(1).map((c) => c.querySelector("input")?.value ?? c.textContent ?? "").join(",");
    contextMenu(e, [
      ["Copy Value", "file", () => navigator.clipboard.writeText(val)],
      ["Copy Row", "table", () => navigator.clipboard.writeText(rowCsv())],
      ...(k && inp ? [
        ["Set NULL", "x", () => bcSetNull(inp.dataset.c!, k)] as MenuItem,
        ["Delete Row", "trash", () => bcDelRow(k)] as MenuItem,
      ] : []),
    ]);
  };
  $("#bc-grid").oncontextmenu = (e) => cellMenu(e, true);
  $("#bc-qgrid").oncontextmenu = (e) => cellMenu(e, false);
  const bcSetNull = async (colName: string, k: unknown[]) => {
    const col = bcCols.find((c) => c.name === colName) ?? { name: colName, type: "", pk: false };
    try {
      await bcDb.execute(updateSql(bcD, bcTable, col, bcKeys), [null, ...k.map((v) => arg(bcD, v))]);
      bcMsg(`${colName} set to NULL`);
      bcLoad(bcTable);
    } catch (err) { bcMsg(String(err), true); }
  };

  // ----- objects / table data -----
  const bcObjects = async () => {
    bcObjs = await bcDb.select<Row[]>(objectsSql(bcD));
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
    for (const id of ["#bc-o-open", "#bc-o-drop", "#bc-o-csv"]) $<HTMLButtonElement>(id).disabled = !bcSel;
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
  $("#bc-o-new").onclick = () => {
    const id = bcD === "postgres" ? "id bigserial PRIMARY KEY" : bcD === "mysql" ? "id BIGINT AUTO_INCREMENT PRIMARY KEY" : "id INTEGER PRIMARY KEY";
    bcEditor.newTab(`CREATE TABLE new_table (\n  ${id},\n  name TEXT NOT NULL,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);`);
    bcView("query");
  };
  $("#bc-o-drop").onclick = () => bcDrop(bcSel);
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

  const dataTab = () => $("#bc-views").querySelector<HTMLElement>('[data-v="data"]')!;
  const bcCloseData = () => {
    bcTable = "";
    dataTab().classList.add("hidden");
    bcView("objects");
    bcStatus();
  };
  const bcLoad = async (t: string) => {
    bcTable = t;
    bcSel = t;
    dataTab().classList.remove("hidden");
    dataTab().querySelector("span")!.textContent = t;
    bcView("data");
    bcTree();
    bcStatus();
    loading($("#bc-grid"), `Loading ${t}…`);
    $<HTMLButtonElement>("#bc-add").disabled = true;
    bcBusy(1);
    try {
      bcCols = bcD === "sqlite" ? [] : await bcDb.select<Col[]>(colsSql(bcD), [bcD === "postgres" ? qid(bcD, t) : t]);
      bcKeys = bcD === "sqlite" ? [{ name: "rowid", type: "", pk: true }] : bcCols.filter((c) => Number(c.pk));
      bcDataRows = await bcDb.select<Row[]>(selectSql(bcD, t));
      bcGrid($("#bc-grid"), bcDataRows, bcKeys.length > 0);
      $<HTMLButtonElement>("#bc-add").disabled = false;
      bcMsg(`${t}: ${bcDataRows.length} row(s)${bcDataRows.length === 500 ? " (first 500)" : ""}${bcKeys.length ? "" : " · no primary key, read-only"}`);
    } catch (e) { bcMsg(String(e), true); $("#bc-grid").innerHTML = ""; } finally { bcBusy(-1); }
  };
  $("#bc-d-refresh").onclick = () => bcTable && bcLoad(bcTable);
  $("#bc-refresh").onclick = async () => {
    bcBusy(1);
    $("#bc-refresh").querySelector("svg")?.classList.add("animate-spin");
    try { await bcObjects(); bcSchema(); if (bcTable) await bcLoad(bcTable); bcMsg("Refreshed"); } catch (err) { bcMsg(String(err), true); }
    finally { bcBusy(-1); $("#bc-refresh").querySelector("svg")?.classList.remove("animate-spin"); }
  };
  const rowKey = (el: Element) => JSON.parse((el.closest("tr") as HTMLElement).dataset.k || "null") as unknown[] | null;
  $("#bc-grid").addEventListener("change", async (e) => {
    const i = e.target as HTMLInputElement, k = rowKey(i);
    if (!i.dataset.c || !k) return;
    const col = bcCols.find((c) => c.name === i.dataset.c) ?? { name: i.dataset.c, type: "", pk: false };
    try {
      await bcDb.execute(updateSql(bcD, bcTable, col, bcKeys), [i.value, ...k].map((v) => arg(bcD, v)));
      bcMsg(`Saved ${col.name}`);
      i.classList.add("text-emerald-300");
      if (Number(col.pk)) bcLoad(bcTable); // key changed: refresh so the row is addressed by its new key
    } catch (err) { bcMsg(String(err), true); bcLoad(bcTable); }
  });
  $("#bc-grid").addEventListener("keydown", (e) => e.key === "Enter" && (e.target as HTMLElement).blur());
  const bcDelRow = async (k: unknown[]) => {
    if (!(await confirmBox("Delete row?", `${bcKeys.map((c) => c.name).join(", ")} = ${k.join(", ")} in ${bcTable}`, "Delete"))) return;
    try { await bcDb.execute(deleteSql(bcD, bcTable, bcKeys), k.map((v) => arg(bcD, v))); } catch (err) { bcMsg(String(err), true); }
    bcLoad(bcTable);
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
    bcView("objects");
    bcBusy(1);
    try {
      const { url, d } = connUrl(await dial(input));
      bcMsg("Connecting…");
      const next = await Database.load(url, { autoCreate: d === "sqlite" });
      if (gen !== bcGen) return; // a newer connect started meanwhile
      if (bcDb.path !== db.path && bcDb.path !== next.path) await bcDb.close(bcDb.path).catch(() => {}); // never close the app's own store
      (bcDb = next), (bcD = d), (bcOn = true), (bcUrl = url), (bcCid = cid), (bcCollapsed = d === "sqlite" && !openDb), (bcDbOpen = openDb), (bcSel = "");
      if (bcTable) bcCloseData();
      bcCurDb = d === "sqlite" ? "" : decodeURIComponent(new URL(url).pathname.slice(1));
      bcDbList = d === "sqlite" ? [] : (await bcDb.select<{ name: string }[]>(dbsSql(d))).map((r) => r.name);
      await bcObjects();
      bcEditor.setDialect(d);
      bcSchema();
      bcView("objects");
      bcStatus();
      bcMsg(`Connected to ${bcConn()?.name ?? ""}${bcCurDb ? ` › ${bcCurDb}` : ""}`);
    } catch (err) {
      if (gen === bcGen) (bcMsg(String(err), true), bcDrawObjects());
    } finally {
      bcBusy(-1);
      if (gen === bcGen) (bcConnecting = 0), bcTree();
    }
  };
  const bcDisconnect = async () => {
    if (bcOn && bcDb.path !== db.path) await bcDb.close(bcDb.path).catch(() => {});
    (bcDb = db), (bcOn = false), (bcCid = 0), (bcObjs = []), (bcDbList = []), (bcCurDb = ""), (bcSel = "");
    bcCloseData();
    bcDrawObjects();
    bcTree();
    bcMsg("Disconnected");
  };
  $("#bc-disconnect").onclick = bcDisconnect;

  // ----- query editor -----
  /** Runs one or more statements in order; the last read's rows go to the result grid. Stops at the first error. */
  const bcRun = async (sql: string) => {
    if (!bcOn) return bcMsg("Connect to a database first", true);
    bcView("query");
    const parts = statements(sql).map((s) => sql.slice(s.from, s.to));
    let changed = false, affected = 0;
    const t0 = performance.now();
    const runBtn = $<HTMLButtonElement>("#bc-run"), runHtml = runBtn.innerHTML;
    runBtn.disabled = $<HTMLButtonElement>("#bc-runall").disabled = true;
    runBtn.innerHTML = `${spinner("h-3.5 w-3.5")} Running`;
    loading($("#bc-qgrid"), "Running query…");
    bcBusy(1);
    let shown = false;
    for (const [i, q] of parts.entries()) {
      try {
        if (isRead(q)) {
          bcQRows = await bcDb.select<Row[]>(q);
          bcGrid($("#bc-qgrid"), bcQRows, false);
          shown = true;
          bcMsg(`${bcQRows.length} row(s) · ${Math.round(performance.now() - t0)} ms`);
        } else {
          affected += (await bcDb.execute(q)).rowsAffected;
          changed = true;
          bcMsg(`${parts.length > 1 ? `${i + 1}/${parts.length} statements · ` : ""}${affected} row(s) affected · ${Math.round(performance.now() - t0)} ms`);
        }
      } catch (err) {
        bcMsg(`${parts.length > 1 ? `Statement ${i + 1}: ` : ""}${err}`, true);
        break;
      }
    }
    if (!shown) $("#bc-qgrid").innerHTML = `<p class="py-10 text-center text-sm text-zinc-600">${changed ? "Done — see the status bar for rows affected" : "No result"}</p>`;
    runBtn.innerHTML = runHtml;
    runBtn.disabled = $<HTMLButtonElement>("#bc-runall").disabled = false;
    bcBusy(-1);
    if (changed) { // DDL/DML may have changed tables or columns
      await bcObjects().catch(() => {});
      bcSchema();
    }
  };
  const bcEditor = createSqlEditor($("#bc-editor"), $("#bc-qtabs"), bcRun);
  $("#bc-run").onclick = () => (bcEditor.focus(), bcEditor.runCurrent());
  $("#bc-runall").onclick = () => (bcEditor.focus(), bcEditor.runAll());
  $("#bc-newq").onclick = () => (bcEditor.newTab(bcTable ? `SELECT * FROM ${qid(bcD, bcTable)} LIMIT 100;` : ""), bcView("query"));
  /** Column names for autocomplete; best-effort (completion just has fewer names if it fails). */
  const bcSchema = () => bcDb.select<{ t: string; c: string; ty: string }[]>(schemaSql(bcD)).then(bcEditor.setSchema, () => {});

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
      detail: () => (bcOn ? `Connected · ${bcConn()?.name ?? ""}` : "Not connected"),
      kill: async () => {
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
      return ["/basecurves", c.name, bcCurDb, bcV === "data" ? bcTable : bcV === "query" ? "query" : bcSel].filter(Boolean).join("/");
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
        <input data-path spellcheck="false" class="ml-1 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-sm outline-none focus:border-amber-500" />
      </form>
      <div class="flex min-h-0 flex-1">
        <div data-flist class="min-w-0 flex-1 overflow-auto p-2"></div>
        <section data-fprev class="hidden w-1/2 flex-col border-l border-zinc-800">
          <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
            <span data-fname class="min-w-0 flex-1 truncate font-mono text-sm"></span>
            <span data-fstat class="shrink-0 text-xs text-zinc-500"></span>
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
    });
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
    try {
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
      const fail = (m: string) => list.insertAdjacentHTML("afterbegin", `<p class="px-3 py-2 font-mono text-xs text-red-400">${esc(m)}</p>`);
      if (name.includes("/")) return void fail(`Name can't contain "/"`);
      const path = joinPath(cur, name);
      const r = await run(dir ? mkdirScript(path) : newFileScript(path)).catch((e) => ({ out: String(e), code: 1 }));
      await go(cur);
      if (r.code) fail(r.out.trim() || `exit ${r.code}`);
      else if (!dir) preview({ name, dir: false, size: 0, mtime: "" }); // straight into the editor
    };
  });
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
  const el = $("#path");
  el.textContent = el.title = pathOf();
}

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
