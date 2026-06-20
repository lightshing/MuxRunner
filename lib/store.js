import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

import { LOG_DIR, RUNNER_DIR, PENDING_DIR, WORK_DIR, SESSION_CWD, SESSION_PREFIX } from './config.js';
import { slugify, makeId, fileStamp, stripAnsi } from './util.js';
import { buildRunnerScript } from './script.js';
import { MARKER_LINE_RE } from './markers.js';
import * as tmux from './tmux.js';

const META_VERSION = 1;

// A run is still executing its command set while in one of these. Anything else
// (completed / paused-on-error / closed) means the set has finished running —
// which is what an "after another set finishes" trigger waits for. Note paused
// counts as finished: execution aborted, even though the session stays alive.
const EXEC_ACTIVE = new Set(['starting', 'running']);

// Normalize raw command lines: trim trailing whitespace, drop blank lines.
function normalizeCommands(rawCommands) {
  return (rawCommands || [])
    .map((l) => String(l).replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0);
}

/**
 * A command set that has been composed but not launched yet — held until its
 * trigger fires (a scheduled time, a delay, another set finishing) or the user
 * starts it by hand. Persisted to PENDING_DIR so it survives a restart.
 *
 * trigger shapes (type → fields):
 *   { type: 'hold' }                        — wait for a manual start only
 *   { type: 'time',  runAt: <epoch ms> }    — fire at an absolute time
 *   { type: 'delay', delayMs, runAt }       — fire delayMs after creation (runAt precomputed)
 *   { type: 'after', dependsOn, dependsOnName } — fire when run <dependsOn> finishes
 */
class PendingTask {
  constructor(manager, data) {
    this.manager = manager;
    Object.assign(this, data);
  }

  summary() {
    return {
      kind: 'pending',
      id: this.id,
      name: this.name,
      commands: this.commands,
      cwd: this.cwd,
      trigger: this.trigger,
      createdAt: this.createdAt,
      status: 'pending',
    };
  }

  toJSON() {
    return { version: META_VERSION, ...this.summary() };
  }

  // The wall-clock instant this task is due to fire, or null for triggers that
  // have no fixed time (hold / after-another-run).
  dueAt() {
    const t = this.trigger || {};
    if (t.type === 'time' || t.type === 'delay') return t.runAt || null;
    return null;
  }

  async save() {
    await fsp.writeFile(path.join(PENDING_DIR, this.id + '.json'), JSON.stringify(this.toJSON(), null, 2));
  }

  async remove() {
    try {
      await fsp.unlink(path.join(PENDING_DIR, this.id + '.json'));
    } catch {
      /* already gone */
    }
  }
}

/** A single command set execution. */
class Run {
  constructor(manager, data) {
    this.manager = manager;
    Object.assign(this, data);
    this._offset = 0;
    this._decoder = new StringDecoder('utf8');
    this._carry = '';
    this._currentIdx = null;
    this._echoPending = null;
    this._tailTimer = null;
    this._saveTimer = null;
    this._finished = false;
  }

  toJSON() {
    return {
      version: META_VERSION,
      id: this.id,
      name: this.name,
      session: this.session,
      status: this.status,
      cwd: this.cwd,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt || null,
      durationMs: this.timing().durationMs,
      logFile: this.logFile,
      attach: tmux.attachCommand(this.session),
      commands: this.commands,
    };
  }

  // Wall-clock time of the actual execution: first command start → last
  // command finish (or run finish). null until a command has started.
  timing() {
    let startedAt = null;
    let endedAt = null;
    for (const c of this.commands) {
      if (c.startedAt && (startedAt == null || c.startedAt < startedAt)) startedAt = c.startedAt;
      if (c.finishedAt && (endedAt == null || c.finishedAt > endedAt)) endedAt = c.finishedAt;
    }
    if (this.finishedAt && (endedAt == null || this.finishedAt > endedAt)) endedAt = this.finishedAt;
    // Prefer the precise shell-measured total; else the wall span we observed.
    const span = startedAt != null && endedAt != null ? endedAt - startedAt : null;
    const durationMs = this.totalDurationMs != null ? this.totalDurationMs : span;
    return { startedAt, endedAt, durationMs };
  }

  // Lightweight view for lists.
  summary() {
    const total = this.commands.length;
    const done = this.commands.filter((c) => c.status === 'done').length;
    const errored = this.commands.some((c) => c.status === 'error');
    const t = this.timing();
    return {
      id: this.id,
      name: this.name,
      session: this.session,
      status: this.status,
      cwd: this.cwd,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt || null,
      logFile: this.logFile,
      attach: tmux.attachCommand(this.session),
      total,
      done,
      errored,
      // Per-command statuses so list views (the session-card progress swatches)
      // can render the right colours immediately from REST/snapshot data —
      // without waiting for a run:update, which never fires while a single
      // long-running command is in progress.
      steps: this.commands.map((c) => c.status),
      // Execution start (first command's startedAt) so the UI can tick a live
      // elapsed counter for running sessions. null until a command begins.
      startedAt: t.startedAt,
      durationMs: t.durationMs,
    };
  }

  _emitUpdate() {
    this.manager.emit('run:update', this.toJSON());
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch(() => {});
    }, 250);
  }

  async save() {
    const metaPath = path.join(LOG_DIR, this.id + '.json');
    await fsp.writeFile(metaPath, JSON.stringify(this.toJSON(), null, 2));
  }

  startTail() {
    const tick = async () => {
      try {
        await this._readNew();
      } catch {
        /* file may not exist yet */
      }
      if (!this._finished) this._tailTimer = setTimeout(tick, 300);
    };
    this._tailTimer = setTimeout(tick, 150);
  }

  stopTail() {
    if (this._tailTimer) clearTimeout(this._tailTimer);
    this._tailTimer = null;
  }

  async _readNew() {
    const logPath = path.join(LOG_DIR, this.logFile);
    let stat;
    try {
      stat = await fsp.stat(logPath);
    } catch {
      return;
    }
    if (stat.size <= this._offset) return;
    const fd = await fsp.open(logPath, 'r');
    try {
      const len = stat.size - this._offset;
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, this._offset);
      this._offset = stat.size;
      const text = this._decoder.write(buf);
      this._ingest(text);
    } finally {
      await fd.close();
    }
  }

  _ingest(text) {
    this._carry += text;
    const parts = this._carry.split('\n');
    this._carry = parts.pop(); // keep last (possibly partial) line
    for (const rawLine of parts) {
      const line = stripAnsi(rawLine);
      const marker = this._matchMarker(line);
      if (marker) {
        this._handleMarker(marker);
        continue;
      }
      // Non-marker line: live display + (maybe) per-step output. The idx lets
      // the UI route this line into the currently-running command for a
      // real-time parsed view.
      this.manager.emit('run:output', { id: this.id, idx: this._currentIdx, chunk: line + '\n' });
      if (this._currentIdx != null) {
        const step = this.commands[this._currentIdx - 1];
        if (step) {
          // Drop the echoed "$ <cmd>" banner line from stored output.
          if (this._echoPending != null && line === '$ ' + this._echoPending) {
            this._echoPending = null;
          } else {
            step.output = (step.output || '') + line + '\n';
          }
        }
      }
    }
  }

  _matchMarker(line) {
    if (!MARKER_LINE_RE.test(line)) return null;
    let m;
    if ((m = line.match(/\[MUXRUNNER:START:(\d+)\]/))) return { type: 'START', idx: +m[1] };
    if ((m = line.match(/\[MUXRUNNER:END:(\d+):rc=(-?\d+)(?::ms=(-?\d+))?\]/)))
      return { type: 'END', idx: +m[1], rc: +m[2], ms: m[3] != null ? +m[3] : null };
    if ((m = line.match(/\[MUXRUNNER:ABORT:(\d+):rc=(-?\d+)\]/)))
      return { type: 'ABORT', idx: +m[1], rc: +m[2] };
    if ((m = line.match(/\[MUXRUNNER:FINISH:abort=(\d)(?::ms=(-?\d+))?\]/)))
      return { type: 'FINISH', abort: +m[1], ms: m[2] != null ? +m[2] : null };
    return null;
  }

  _handleMarker(m) {
    if (m.type === 'START') {
      this._currentIdx = m.idx;
      const step = this.commands[m.idx - 1];
      if (step) {
        step.status = 'running';
        step.startedAt = Date.now();
        this._echoPending = step.text;
      }
      if (this.status === 'starting') this.status = 'running';
    } else if (m.type === 'END') {
      const step = this.commands[m.idx - 1];
      if (step) {
        step.rc = m.rc;
        step.finishedAt = Date.now();
        step.status = m.rc === 0 ? 'done' : 'error';
        // Precise wall-clock from the shell (bash EPOCHREALTIME). Fall back to
        // the poll-based timestamps if the shell couldn't measure it.
        if (m.ms != null && m.ms >= 0) step.durationMs = m.ms;
        else if (step.startedAt) step.durationMs = step.finishedAt - step.startedAt;
      }
      this._currentIdx = null;
      this._echoPending = null;
    } else if (m.type === 'ABORT') {
      this.status = 'paused';
      // Mark commands after the aborted one as skipped.
      for (let i = m.idx; i < this.commands.length; i++) {
        if (this.commands[i].status === 'pending') this.commands[i].status = 'skipped';
      }
    } else if (m.type === 'FINISH') {
      if (this.status !== 'closed') {
        this.status = m.abort ? 'paused' : 'completed';
      }
      this.finishedAt = Date.now();
      if (m.ms != null && m.ms >= 0) this.totalDurationMs = m.ms;
      this._finished = true;
      this.stopTail();
    }
    this._emitUpdate();
    this._scheduleSave();
  }

  async close() {
    await tmux.killSession(this.session);
    this.stopTail();
    this._finished = true;
    this.status = 'closed';
    if (!this.finishedAt) this.finishedAt = Date.now();
    await this.save();
    this._emitUpdate();
  }
}

export class Manager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Run>} */
    this.runs = new Map();
    /** @type {Map<string, PendingTask>} */
    this.pending = new Map();
    /** Guard so the scheduler never double-fires a task while it's launching. */
    this._firing = new Set();
  }

  async init() {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await fsp.mkdir(RUNNER_DIR, { recursive: true });
    await fsp.mkdir(PENDING_DIR, { recursive: true });
    await tmux.setHistoryLimit();
    await this._loadHistory();
    await this._loadPending();
    this._startReaper();
    this._startScheduler();
  }

  // Load persisted meta files so history survives restarts; re-adopt sessions
  // that are still alive in tmux.
  async _loadHistory() {
    let entries = [];
    try {
      entries = await fsp.readdir(LOG_DIR);
    } catch {
      return;
    }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(LOG_DIR, f), 'utf8'));
        if (!meta.id || this.runs.has(meta.id)) continue;
        const alive = await tmux.hasSession(meta.session);
        if (!alive && meta.status !== 'closed' && meta.status !== 'completed' && meta.status !== 'paused') {
          meta.status = 'closed';
        }
        const run = new Run(this, {
          id: meta.id,
          name: meta.name,
          session: meta.session,
          status: meta.status,
          cwd: meta.cwd || WORK_DIR,
          createdAt: meta.createdAt,
          finishedAt: meta.finishedAt,
          logFile: meta.logFile,
          commands: meta.commands || [],
        });
        if (meta.durationMs != null) run.totalDurationMs = meta.durationMs;
        run._finished = true; // we don't re-tail historical runs
        run._adopted = !alive ? false : true;
        this.runs.set(run.id, run);
      } catch {
        /* skip malformed */
      }
    }
  }

  // Periodically reap sessions that disappeared (user killed them by hand).
  _startReaper() {
    setInterval(async () => {
      for (const run of this.runs.values()) {
        if (run.status === 'closed') continue;
        const alive = await tmux.hasSession(run.session);
        if (!alive) {
          run.status = 'closed';
          if (!run.finishedAt) run.finishedAt = Date.now();
          run.stopTail();
          run._finished = true;
          await run.save().catch(() => {});
          this.emit('run:update', run.toJSON());
        }
      }
    }, 4000).unref();
  }

  // Reload deferred tasks composed before a restart so triggers survive reboots.
  async _loadPending() {
    let entries = [];
    try {
      entries = await fsp.readdir(PENDING_DIR);
    } catch {
      return;
    }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(PENDING_DIR, f), 'utf8'));
        if (!meta.id || this.pending.has(meta.id)) continue;
        const task = new PendingTask(this, {
          id: meta.id,
          name: meta.name,
          commands: meta.commands || [],
          cwd: meta.cwd || SESSION_CWD,
          trigger: meta.trigger || { type: 'hold' },
          createdAt: meta.createdAt,
        });
        this.pending.set(task.id, task);
      } catch {
        /* skip malformed */
      }
    }
  }

  // Fire deferred tasks whose trigger condition has come due. Cheap: a few
  // map lookups per second, mirroring the reaper's cadence.
  _startScheduler() {
    setInterval(() => {
      const now = Date.now();
      for (const task of this.pending.values()) {
        if (this._firing.has(task.id)) continue;
        if (this._isDue(task, now)) {
          this._firing.add(task.id);
          this.firePending(task.id)
            .catch((err) => console.error(`pending ${task.id} failed to fire:`, err.message))
            .finally(() => this._firing.delete(task.id));
        }
      }
    }, 1000).unref();
  }

  _isDue(task, now) {
    const t = task.trigger || {};
    if (t.type === 'time' || t.type === 'delay') {
      return t.runAt != null && now >= t.runAt;
    }
    if (t.type === 'after') {
      const dep = this.runs.get(t.dependsOn);
      // Fire once the watched run has finished executing. If it can't be found
      // (e.g. its meta was pruned), treat that as "done" so we don't hang.
      return !dep || !EXEC_ACTIVE.has(dep.status);
    }
    return false; // 'hold' — manual start only
  }

  list() {
    return [...this.runs.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((r) => r.summary());
  }

  get(id) {
    return this.runs.get(id);
  }

  listPending() {
    return [...this.pending.values()]
      .sort((a, b) => (a.dueAt() || a.createdAt || 0) - (b.dueAt() || b.createdAt || 0))
      .map((p) => p.summary());
  }

  getPending(id) {
    return this.pending.get(id);
  }

  // Validate + normalize a trigger from the client into a stored shape.
  _normalizeTrigger(trigger, createdAt) {
    const t = trigger || {};
    const type = t.type;
    if (type === 'hold') return { type: 'hold' };
    if (type === 'time') {
      const runAt = Number(t.runAt);
      if (!Number.isFinite(runAt)) throw new Error('Scheduled time is invalid');
      return { type: 'time', runAt };
    }
    if (type === 'delay') {
      const delayMs = Number(t.delayMs);
      if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Delay is invalid');
      return { type: 'delay', delayMs, runAt: createdAt + delayMs };
    }
    if (type === 'after') {
      const dependsOn = String(t.dependsOn || '');
      const dep = this.runs.get(dependsOn);
      if (!dep) throw new Error('The session to wait for was not found');
      return { type: 'after', dependsOn, dependsOnName: dep.name };
    }
    throw new Error('Unknown trigger type');
  }

  /**
   * Compose a deferred command set without launching it. Held in the pending
   * queue until its trigger fires or it's started by hand.
   */
  async createPending(name, rawCommands, cwd = SESSION_CWD, trigger) {
    const commands = normalizeCommands(rawCommands);
    if (commands.length === 0) throw new Error('No commands provided');
    const now = new Date();
    const createdAt = now.getTime();
    const normTrigger = this._normalizeTrigger(trigger, createdAt);
    const id = makeId(slugify(name), now);
    const task = new PendingTask(this, {
      id,
      name: String(name || 'untitled'),
      commands,
      cwd: cwd || SESSION_CWD,
      trigger: normTrigger,
      createdAt,
    });
    this.pending.set(id, task);
    await task.save();
    this.emit('pending:update', task.summary());
    return task;
  }

  // Launch a pending task now: remove it from the queue and start a real run.
  async firePending(id) {
    const task = this.pending.get(id);
    if (!task) throw new Error('Pending task not found');
    this.pending.delete(id);
    await task.remove();
    this.emit('pending:remove', { id });
    return this._launch(task.name, task.commands, task.cwd);
  }

  // Drop a pending task without running it.
  async cancelPending(id) {
    const task = this.pending.get(id);
    if (!task) return false;
    this.pending.delete(id);
    await task.remove();
    this.emit('pending:remove', { id });
    return true;
  }

  /**
   * Create + start a new run immediately.
   * @param {string} name
   * @param {string[]} rawCommands
   */
  async create(name, rawCommands, cwd = SESSION_CWD) {
    const commands = normalizeCommands(rawCommands);
    if (commands.length === 0) throw new Error('No commands provided');
    return this._launch(String(name || 'untitled'), commands, cwd);
  }

  // The actual tmux launch path, shared by immediate create() and firePending().
  // `commands` must already be normalized + non-empty.
  async _launch(name, commands, cwd = SESSION_CWD) {
    const now = new Date();
    const slug = slugify(name);
    const id = makeId(slug, now);
    const session = `${SESSION_PREFIX}_${id}`;
    const logFile = `${slug}_${fileStamp(now)}.log`;
    const logPath = path.join(LOG_DIR, logFile);
    const runnerPath = path.join(RUNNER_DIR, id + '.sh');

    // Write the runner script and create an (empty) log file up front.
    await fsp.writeFile(runnerPath, buildRunnerScript(commands, name), { mode: 0o755 });
    await fsp.writeFile(logPath, '');

    const run = new Run(this, {
      id,
      name,
      session,
      status: 'starting',
      cwd,
      createdAt: now.getTime(),
      finishedAt: null,
      logFile,
      commands: commands.map((text, i) => ({
        idx: i + 1,
        text,
        status: 'pending',
        rc: null,
        output: '',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      })),
    });
    this.runs.set(id, run);

    // Boot the tmux session, wire up persistence, then source the runner.
    await tmux.newSession(session, cwd);
    await tmux.pipePaneToFile(session, logPath);
    // tiny settle so pipe-pane is attached before output starts
    await new Promise((r) => setTimeout(r, 120));
    await tmux.sendLine(session, `source ${shArg(runnerPath)}`);

    run.startTail();
    await run.save();
    this.emit('run:update', run.toJSON());
    return run;
  }

  async live(id, lines = null) {
    const run = this.runs.get(id);
    if (!run) return null;
    const raw = await tmux.capturePane(run.session, lines);
    return stripAnsi(raw);
  }
}

function shArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export const manager = new Manager();
