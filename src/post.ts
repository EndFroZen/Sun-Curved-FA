// Sun Post helpers (HTTP client app).

/** "Key: Value" per line → header pairs; blank lines and `#` comments skipped. */
export const parseHeaders = (s: string): [string, string][] =>
  s.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes(":"))
    .map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]; })
    .filter(([k]) => k);

/** Pretty-print JSON bodies; anything else comes back as-is. */
export const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

/** Bare "example.com/x" → "https://example.com/x". */
export const withScheme = (u: string) => (/^https?:\/\//i.test(u.trim()) ? u.trim() : `https://${u.trim()}`);
