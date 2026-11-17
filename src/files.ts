// Remote file browsing over the existing SSH session (GNU find on the machine).
import { dq, sq } from "./deploy.ts";

export type Entry = { name: string; dir: boolean; size: number; mtime: string };

const cd = (path: string) => `cd -- ${dq(path)}`; // dq expands a leading ~

/** First output line is the resolved absolute path, then one tab-separated line per entry. */
// ponytail: names containing tabs/newlines break the listing; switch to -printf '\0' if that ever shows up.
export const listScript = (path: string) =>
  `${cd(path)} && pwd && find . -mindepth 1 -maxdepth 1 -printf '%Y\\t%s\\t%TY-%Tm-%Td %TH:%TM\\t%f\\n'`;

export const PREVIEW_BYTES = 256 * 1024;
export const readScript = (path: string) => `head -c ${PREVIEW_BYTES} -- ${sq(path)}`;
/** Images / SVG / PDF the webview renders itself; fetched whole as base64 (remote_exec output is lossy UTF-8). */
export const MEDIA_MAX = 20 * 1024 * 1024;
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml", pdf: "application/pdf",
};
export const mimeFor = (name: string) => MIME[name.split(".").pop()!.toLowerCase()];
export const mediaScript = (path: string) => `base64 -w0 -- ${sq(path)}`;
/** Content goes in on stdin; `cat >` rewrites in place, so owner and mode are kept. */
export const writeScript = (path: string) => `cat > ${sq(path)}`;
/** `set -C` (noclobber) makes the redirect fail instead of emptying an existing file. */
export const newFileScript = (path: string) => `set -C && : > ${sq(path)}`;
export const mkdirScript = (path: string) => `mkdir -- ${sq(path)}`;
/** Root-owned files: stdin = password line, then content. Content goes via a temp file so a sudo that
 *  doesn't prompt (NOPASSWD) can never write the password into the target; `cat >` keeps owner and mode. */
export const sudoWriteScript = (path: string) =>
  `IFS= read -r pw; t=$(mktemp) || exit 1; cat > "$t"; printf '%s\\n' "$pw" | sudo -S -k -p '' sh -c 'cat -- "$1" > "$2"' _ "$t" ${sq(path)}; r=$?; rm -f -- "$t"; exit $r`;

/** Editor highlighting by file name. */
export const modeFor = (name: string) =>
  /\.ya?ml$/i.test(name) ? "yaml" : /\.(sh|bash|zsh)$|^\.?env\b|^\.(bashrc|profile|zshrc)$/i.test(name) ? "sh" : "text";

/** Folders first, then by name. */
export function parseListing(out: string): { path: string; entries: Entry[] } {
  const [path, ...lines] = out.replace(/\n$/, "").split("\n");
  const entries = lines
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 4)
    .map(([type, size, mtime, ...name]) => ({ name: name.join("\t"), dir: type === "d", size: +size, mtime: mtime.slice(0, 16) }))
    .sort((a, b) => +b.dir - +a.dir || a.name.localeCompare(b.name));
  return { path, entries };
}

/** Parent of an absolute path ("/" stays "/"). */
export const parentOf = (p: string) => p.replace(/\/[^/]*\/?$/, "") || "/";
export const joinPath = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name;

export const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;

/** Upload: stdin = base64 (remote_exec stdin is a string). Written to a .part file first, so a dropped
 *  link never leaves a half file under the real name. */
export const uploadScript = (path: string) =>
  `p=${sq(path)}; base64 -d > "$p.part" && mv -f -- "$p.part" "$p" || { rm -f -- "$p.part"; exit 1; }`;

const ARCHIVE = /\.(zip|jar|war|ear|apk|whl|nupkg|7z|rar|tar|tgz|tbz2?|txz|tzst|tar\.(gz|bz2|xz|zst|lz|lzma|z)|gz|bz2|xz|zst|lz4)$/i;
export const isArchive = (name: string) => ARCHIVE.test(name);

/** Extracts next to the archive into a new folder named after it (name-2, name-3… if taken), or for a
 *  single compressed file (.gz/.xz/…) into a new file without the extension. Last output line = what was made.
 *  Uses whatever the machine has: unzip / python3 / tar / 7z / unrar / bsdtar. */
export const extractScript = (path: string) => `f=${sq(path)}; dir=\${f%/*}; [ -n "$dir" ] || dir=/; n=\${f##*/}
lc=$(printf %s "$n" | tr A-Z a-z)
has() { command -v "$1" >/dev/null 2>&1; }
free() { t="$dir/$1"; i=1; while [ -e "$t" ]; do i=$((i+1)); t="$dir/$1-$i"; done; }
mk() { free "$1"; mkdir -- "$t" || exit 1; }
need() { echo "No tool on this machine can open $n (install $1)" >&2; rmdir -- "$t" 2>/dev/null; exit 127; }
one() { free "\${n%.*}"; "$@" -dc -- "$f" > "$t" || { rm -f -- "$t"; exit 1; }; }
case $lc in
  *.tar|*.tar.*|*.tgz|*.tbz|*.tbz2|*.txz|*.tzst) b=\${n%.*}; case $lc in *.tar.*) b=\${b%.*};; esac; mk "$b"
    tar -xf "$f" -C "$t" || exit 1;;
  *.zip|*.jar|*.war|*.ear|*.apk|*.whl|*.nupkg) mk "\${n%.*}"
    if has unzip; then unzip -q -o "$f" -d "$t" || exit 1
    elif has python3; then python3 -m zipfile -e "$f" "$t" || exit 1
    elif has bsdtar; then bsdtar -xf "$f" -C "$t" || exit 1
    else need unzip; fi;;
  *.7z|*.rar) mk "\${n%.*}"
    for c in 7zz 7z 7za; do has $c && { $c x -y -o"$t" -- "$f" >/dev/null || exit 1; echo "$t"; exit 0; }; done
    if [ "\${lc##*.}" = rar ] && has unrar; then unrar x -o+ -inul "$f" "$t/" || exit 1
    elif has bsdtar; then bsdtar -xf "$f" -C "$t" || exit 1
    else need p7zip; fi;;
  *.gz) one gzip;; *.bz2) one bzip2;; *.xz) one xz;; *.zst) one zstd;; *.lz4) one lz4;;
  *) echo "Not an archive: $n" >&2; exit 2;;
esac
echo "$t"`;
