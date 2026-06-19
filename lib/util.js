// Small shared helpers: ANSI stripping, slugifying, timestamps.

// Strip ANSI escape / control sequences so output renders cleanly in the
// (deliberately non-terminal-looking) web UI and in the parsed history.
// We remove OSC strings, two-char escapes and DCS/PM/APC/SOS strings up front,
// but deliberately KEEP CSI sequences and \r so the per-line overlay below can
// honour the ones that affect what a refreshing line finally looks like
// (carriage return + erase-line). Remaining CSI is dropped during overlay.
const PRE_ANSI_RE = new RegExp(
  [
    '\\x1B\\][\\s\\S]*?(?:\\x07|\\x1B\\\\)', // OSC ... BEL or ST
    '\\x1B[@-Z\\\\-_]', // single two-char escapes (not CSI; CSI is \x1B[)
    '\\x1B[PX^_][\\s\\S]*?\\x1B\\\\', // DCS/PM/APC/SOS strings
  ].join('|'),
  'g'
);

// Remaining control chars to drop. Keeps \t (0x09), \n (0x0A), \r (0x0D) and
// ESC (0x1B) — \r and any surviving CSI are consumed by the overlay pass below.
const CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g;

export function stripAnsi(input) {
  if (input == null) return '';
  const pre = String(input).replace(PRE_ANSI_RE, '').replace(CTRL_RE, '');
  // Fast path: nothing that needs grid-style rendering (no \r, no CSI).
  if (pre.indexOf('\r') === -1 && pre.indexOf('\x1B') === -1) return pre;
  return pre.split('\n').map(renderLine).join('\n');
}

// Render a single line the way a terminal would, so a self-refreshing line such
// as "Elapsed: 1s\rElapsed: 2s\r…\rDone" collapses to its final state ("Done")
// instead of the concatenated wall of every frame. Honours \r (cursor → col 0)
// and the erase-line CSI (\x1b[K / \x1b[1K / \x1b[2K) that progress bars emit;
// any other CSI sequence is dropped.
function renderLine(line) {
  if (line.indexOf('\r') === -1 && line.indexOf('\x1B') === -1) return line;
  const cells = [];
  let cur = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\r') {
      cur = 0;
    } else if (ch === '\x1B' && line[i + 1] === '[') {
      // Parse a CSI sequence: params, intermediates, final byte.
      let j = i + 2;
      while (j < line.length && line[j] >= '0' && line[j] <= '?') j++;
      while (j < line.length && line[j] >= ' ' && line[j] <= '/') j++;
      const final = line[j];
      if (final === 'K') {
        const p = j > i + 2 ? parseInt(line.slice(i + 2, j), 10) : 0;
        if (p === 2) cells.length = 0; // whole line
        else if (p === 1) for (let k = 0; k < cur; k++) cells[k] = ' '; // start→cursor
        else cells.length = cur; // 0/default: cursor→end
      }
      i = j; // skip the sequence (final byte too)
    } else if (ch === '\x1B') {
      // Lone ESC or an escape we don't model — drop it.
    } else {
      cells[cur++] = ch;
    }
  }
  let out = '';
  for (let k = 0; k < cells.length; k++) out += cells[k] === undefined ? ' ' : cells[k];
  return out;
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
