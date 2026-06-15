// Generates the bash script that drives a command set inside a tmux session.
//
// The script is *sourced* into a live interactive bash shell (so cwd / env
// changes from the user's commands persist, and the user lands at an
// interactive prompt in the same state if a command fails — ready for
// `tmux attach`). Each user command is written *literally* into the script,
// which is the most faithful execution (it is exactly the line the user typed)
// and avoids quoting/escaping pitfalls.

import { START, END } from './markers.js';

// Single-quote a string safely for embedding inside a bash single-quoted arg.
function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string[]} commands - user command lines (already filtered)
 * @param {string} name - the command set name (for the header banner)
 * @returns {string} bash script source
 */
export function buildRunnerScript(commands, name) {
  const lines = [];
  lines.push('# MuxRunner — generated runner (sourced into an interactive bash session)');
  lines.push(`# command set: ${name}`);
  lines.push('__MUX_ABORT=0');
  lines.push('__MUX_RC=0');
  lines.push('__MUX_ALL0=${EPOCHREALTIME//[.,]/}'); // whole-set wall-clock start
  lines.push(`printf '\\n=== MuxRunner: %s (%s steps) ===\\n' ${shSingleQuote(name)} '${commands.length}'`);
  lines.push('');

  commands.forEach((cmd, i) => {
    const idx = i + 1;
    lines.push('if [ "$__MUX_ABORT" = 0 ]; then');
    lines.push(`  printf '\\n${START(idx)}\\n'`);
    // A human-readable echo of the command being run (helps when attached).
    lines.push(`  printf '\\033[38;5;75m$ %s\\033[0m\\n' ${shSingleQuote(cmd)}`);
    // Capture a precise wall-clock start (bash 5 microsecond clock; the
    // [.,] strip yields integer microseconds regardless of locale radix).
    lines.push('  __MUX_US0=${EPOCHREALTIME//[.,]/}');
    // The user command, written literally on its own line.
    lines.push(`  ${cmd}`);
    lines.push('  __MUX_RC=$?');
    lines.push('  __MUX_US1=${EPOCHREALTIME//[.,]/}');
    lines.push('  if [ -n "$__MUX_US0" ]; then __MUX_MS=$(( (__MUX_US1 - __MUX_US0) / 1000 )); else __MUX_MS=-1; fi');
    lines.push(`  printf '${END(idx)}%s:ms=%s]\\n' "$__MUX_RC" "$__MUX_MS"`);
    lines.push('  if [ "$__MUX_RC" -ne 0 ]; then');
    lines.push('    __MUX_ABORT=1');
    lines.push(`    printf '[MUXRUNNER:ABORT:${idx}:rc=%s]\\n' "$__MUX_RC"`);
    lines.push(
      `    printf '\\033[38;5;203m✗ step ${idx} failed (exit %s) — execution paused. Fix things here, this shell is yours.\\033[0m\\n' "$__MUX_RC"`
    );
    lines.push('  fi');
    lines.push('fi');
    lines.push('');
  });

  lines.push('__MUX_ALL1=${EPOCHREALTIME//[.,]/}');
  lines.push('if [ -n "$__MUX_ALL0" ]; then __MUX_ALLMS=$(( (__MUX_ALL1 - __MUX_ALL0) / 1000 )); else __MUX_ALLMS=-1; fi');
  lines.push(`printf '[MUXRUNNER:FINISH:abort=%s:ms=%s]\\n' "$__MUX_ABORT" "$__MUX_ALLMS"`);
  lines.push('if [ "$__MUX_ABORT" = 0 ]; then');
  lines.push(`  printf '\\033[38;5;78m✓ all ${commands.length} steps completed.\\033[0m\\n'`);
  lines.push('fi');
  lines.push('# Control returns to the interactive shell below.');
  lines.push('');
  return lines.join('\n');
}

// The banner/echo line we add (`$ <cmd>`) should be stripped from the parsed
// per-command output. Export a matcher for the parser.
export const CMD_ECHO_RE = /^\$ /;
