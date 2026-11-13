// Crontab editing: parse `crontab -l` into jobs, keep every other line (comments, VAR=x) untouched.

export type CronLine = { job: true; on: boolean; sched: string; cmd: string } | { job: false; text: string };

/** Missing crontab → empty output; missing crontab binary → exit 127. */
export const CRON_READ = "command -v crontab >/dev/null || { echo 'crontab is not installed on this machine'; exit 127; }; crontab -l 2>/dev/null; exit 0";
/** New crontab goes in on stdin. */
export const CRON_WRITE = "crontab -";

// Minute and hour must be numeric-ish so the stock "# m h dom mon dow command" header isn't taken for a job.
const NUM = String.raw`[\d*/,-]+`;
const ANY = String.raw`[\w*/,-]+`;
const JOB = new RegExp(String.raw`^(#\s*)?(@(?:reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|${NUM}\s+${NUM}\s+${ANY}\s+${ANY}\s+${ANY})\s+(\S.*)$`);

export function parseCrontab(text: string): CronLine[] {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  return lines.map((l) => {
    const m = JOB.exec(l.trim());
    return m ? { job: true, on: !m[1], sched: m[2].replace(/\s+/g, " "), cmd: m[3] } : { job: false, text: l };
  });
}

export const serializeCrontab = (lines: CronLine[]) =>
  lines.map((l) => (l.job ? `${l.on ? "" : "# "}${l.sched.trim()} ${l.cmd.trim()}` : l.text)).join("\n") + "\n"; // crontab needs the final newline

/** Shell line that cds to the first absolute (or ~/) path in a job's command: the folder itself, or the file's folder. "" if none. */
export function cdLine(cmd: string) {
  const p = /(?:^|[\s=])(~?\/[^\s;&|<>'"`]*)/.exec(cmd)?.[1];
  if (!p) return "";
  const q = p.startsWith("~") ? `"$HOME"'${p.slice(1).replace(/'/g, `'\\''`)}'` : `'${p.replace(/'/g, `'\\''`)}'`;
  return `cd -- ${q} 2>/dev/null || cd -- "$(dirname -- ${q})"`;
}

/** True when the schedule has the shape cron accepts (5 fields or an @keyword). */
export const validSched = (s: string) => JOB.test(`${s.trim()} x`);
