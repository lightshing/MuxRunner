// Thin wrapper around the tmux CLI. Every call is a child_process exec.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

async function tmux(args, opts = {}) {
  try {
    const { stdout } = await pExecFile('tmux', args, { maxBuffer: 16 * 1024 * 1024, ...opts });
    return stdout;
  } catch (err) {
    // Bubble up with stderr for the caller to decide.
    const e = new Error(err.stderr || err.message);
    e.code = err.code;
    throw e;
  }
}

export async function isTmuxAvailable() {
  try {
    await pExecFile('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

export async function hasSession(name) {
  try {
    await tmux(['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

// Raise the scrollback so capture-pane (the live Raw-stream source) can see the
// whole run rather than just the last ~2000 lines. tmux applies history-limit
// when a pane is created, so this must run before any session is started.
export async function setHistoryLimit(lines = 50000) {
  try {
    await tmux(['set-option', '-g', 'history-limit', String(lines)]);
  } catch {
    /* non-fatal: large runs just fall back to the default scrollback */
  }
}

// Create a detached session running an interactive bash, in the given cwd.
export async function newSession(name, cwd, { width = 220, height = 50 } = {}) {
  await tmux([
    'new-session',
    '-d',
    '-s', name,
    '-x', String(width),
    '-y', String(height),
    '-c', cwd,
    'bash', '-i',
  ]);
}

// Mirror everything the pane prints into a file (full persistent record).
export async function pipePaneToFile(name, file) {
  // -o toggles; we pass a fresh command so it (re)starts capturing.
  await tmux(['pipe-pane', '-t', name, `cat >> ${shArg(file)}`]);
}

// Type a command into the session and press Enter.
export async function sendLine(name, line) {
  await tmux(['send-keys', '-t', name, line, 'Enter']);
}

// Rendered pane content for the live Raw stream. By default capture the entire
// scrollback (`-S -`) so a long run isn't clipped to the last screenful; pass a
// line count to bound it. Bounded by the session history-limit (see
// setHistoryLimit).
export async function capturePane(name, lines = null) {
  const start = lines == null ? '-' : `-${lines}`;
  try {
    return await tmux(['capture-pane', '-p', '-t', name, '-S', start]);
  } catch {
    return '';
  }
}

export async function killSession(name) {
  try {
    await tmux(['kill-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

export function attachCommand(name) {
  return `tmux attach -t ${name}`;
}

function shArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
