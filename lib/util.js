// Small shared helpers: ANSI stripping, slugifying, timestamps.

// Strip ANSI escape / control sequences so output renders cleanly in the
// (deliberately non-terminal-looking) web UI and in the parsed history.
// Matches CSI sequences (\x1b[ ... letter), OSC sequences (\x1b] ... BEL/ST),
// and a few other two-char escapes.
const ANSI_RE = new RegExp(
  [
    '\\x1B\\][\\s\\S]*?(?:\\x07|\\x1B\\\\)', // OSC ... BEL or ST
    '\\x1B[@-Z\\\\-_]', // single two-char escapes
    '\\x1B\\[[0-?]*[ -/]*[@-~]', // CSI sequences
    '\\x1B[PX^_][\\s\\S]*?\\x1B\\\\', // DCS/PM/APC/SOS strings
  ].join('|'),
  'g'
);

// Lone carriage returns + remaining control chars (keep \n and \t).
const CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function stripAnsi(input) {
  if (input == null) return '';
  return String(input)
    .replace(ANSI_RE, '')
    .replace(/\r/g, '')
    .replace(CTRL_RE, '');
}

// Turn a user-provided name into something safe for filenames.
export function slugify(name) {
  const s = String(name || '')
    .trim()
    .replace(/[^\w一-龥.-]+/g, '-') // keep word chars, CJK, dot, dash
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'untitled';
}

// tmux session names cannot contain '.' or ':'; keep them ASCII-safe.
export function sessionSafe(slug) {
  return slug.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'set';
}

// Filesystem-friendly timestamp: 2026-06-15T12-30-05
export function fileStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

// Compact id used for run + session + runner-script names.
export function makeId(slug, date = new Date()) {
  return `${fileStamp(date)}_${sessionSafe(slug)}`;
}
