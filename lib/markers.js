// Sentinel markers that the generated runner script prints around each command.
// They serve a double purpose:
//   1. Flow control / progress tracking while a run is live (the backend tails
//      the log file and reacts to them).
//   2. Log segmentation for the history parser (split per-command output and
//      detect which command errored).
//
// Format (each on its own line):
//   [MUXRUNNER:START:<idx>]
//   [MUXRUNNER:END:<idx>:rc=<code>]
//   [MUXRUNNER:ABORT:<idx>:rc=<code>]
//   [MUXRUNNER:FINISH:abort=<0|1>]

export const START = (idx) => `[MUXRUNNER:START:${idx}]`;
export const END = (idx) => `[MUXRUNNER:END:${idx}:rc=`;
export const FINISH = '[MUXRUNNER:FINISH:';

export const MARKER_RE =
  /\[MUXRUNNER:(START|END|ABORT):(\d+)(?::rc=(-?\d+))?\]|\[MUXRUNNER:(FINISH):abort=(\d)\]/g;

// A single-line test, used to drop marker lines from displayed output.
export const MARKER_LINE_RE = /^\s*\[MUXRUNNER:(?:START|END|ABORT|FINISH)[^\]]*\]\s*$/;
