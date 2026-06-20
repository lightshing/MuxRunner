// MuxRunner front-end — vanilla JS, no build step.
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  runs: new Map(), // id -> summary
  details: new Map(), // id -> full meta (lazy)
  live: new Map(), // id -> rolling raw output buffer
  stepLive: new Map(), // id -> Map(idx -> live per-command output)
  drawerOpenSteps: new Set(), // expanded step idxs in the open drawer
  openDrawer: null, // id currently shown in drawer
  liveTimer: null, // capture-pane poll interval for the open live drawer
  view: 'compose',
};

const LIVE_ACTIVE = new Set(['starting', 'running', 'paused', 'completed']);
// Statuses where the pane is actively producing output worth polling. We poll
// capture-pane (the rendered terminal grid) so in-place refreshes — spinners,
// ticking seconds, progress bars — show live, which the line-by-line WS stream
// cannot convey.
const LIVE_POLL = new Set(['starting', 'running']);

// ---------- WebSocket ----------
let ws;
function connect() {
  // Match the page scheme so it works behind an HTTPS reverse proxy / tunnel
  // (e.g. Cloudflare): https → wss, http → ws. Avoids mixed-content blocking.
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProto}//${location.host}/ws`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => {
    setConn(false);
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') {
      state.runs.clear();
      msg.runs.forEach((r) => state.runs.set(r.id, r));
      renderAll();
    } else if (msg.type === 'run:update') {
      const r = msg.run;
      // keep a summary-shaped record in runs, store full meta in details
      state.details.set(r.id, r);
      state.runs.set(r.id, toSummary(r));
      renderAll();
      if (state.openDrawer === r.id) {
        if (state.liveTimer && !LIVE_POLL.has(r.status)) {
          // Run just went non-live: drop the capture-pane poller and replace its
          // frozen, possibly-truncated snapshot with the complete log.
          stopLivePoll();
          loadLogStream(r.id);
        }
        renderDrawer(r.id);
      }
    } else if (msg.type === 'run:output') {
      appendLive(msg.id, msg.chunk);
      if (msg.idx != null) appendStepLive(msg.id, msg.idx, msg.chunk);
    }
  };
}

function toSummary(meta) {
  const total = meta.commands.length;
  const done = meta.commands.filter((c) => c.status === 'done').length;
  const errored = meta.commands.some((c) => c.status === 'error');
  const t = runTiming(meta.commands, meta.finishedAt);
  return {
    id: meta.id, name: meta.name, session: meta.session, status: meta.status,
    cwd: meta.cwd, createdAt: meta.createdAt, finishedAt: meta.finishedAt,
    logFile: meta.logFile, attach: meta.attach, total, done, errored,
    steps: meta.commands.map((c) => c.status),
    startedAt: t.startedAt, durationMs: t.durationMs,
  };
}

// Wall-clock timing for a run (first command start → last finish / run end).
function runTiming(commands, finishedAt) {
  let startedAt = null, endedAt = null;
  for (const c of commands || []) {
    if (c.startedAt && (startedAt == null || c.startedAt < startedAt)) startedAt = c.startedAt;
    if (c.finishedAt && (endedAt == null || c.finishedAt > endedAt)) endedAt = c.finishedAt;
  }
  if (finishedAt && (endedAt == null || finishedAt > endedAt)) endedAt = finishedAt;
  return { startedAt, endedAt, durationMs: startedAt != null && endedAt != null ? endedAt - startedAt : null };
}

// Duration of a single command (ms), or null if not measurable yet.
// Prefer the precise shell-measured value; fall back to poll timestamps.
function stepDurationMs(c) {
  if (c.durationMs != null && c.durationMs >= 0) return c.durationMs;
  if (c.startedAt && c.finishedAt) return c.finishedAt - c.startedAt;
  return null;
}

// Whole-second elapsed for live, ticking counters: 7s · 1m 05s · 1h 02m.
// Distinct from fmtDuration (which shows sub-second decimals) so a counter
// updated once per second doesn't jitter its fractional digit.
function fmtElapsed(ms) {
  if (ms == null || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

// Refresh every live elapsed counter on the page. Each such element carries a
// data-elapsed-since="<startMs>" and we render (now - start). Driven by a 1s
// interval and also called right after any render so counters fill instantly.
function tickElapsed() {
  const now = Date.now();
  for (const el of $$('[data-elapsed-since]')) {
    const since = +el.dataset.elapsedSince;
    if (since) el.textContent = fmtElapsed(now - since);
  }
}

// Human-friendly duration: 840ms · 3.2s · 1m 05s · 1h 02m.
function fmtDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function setConn(on) {
  $('#conn-dot').className = 'dot ' + (on ? 'on' : 'off');
  $('#conn-label').textContent = on ? 'connected' : 'reconnecting…';
}

// Poll the rendered terminal grid for the open live drawer and mirror it into
// the Raw stream pane. capture-pane reflects \r/ANSI overwrites in place, so a
// ticking-seconds line shows its current value rather than a flushed-on-newline
// blob. While this owns the console, the WS line stream (appendLive) stands down.
function startLivePoll(id) {
  stopLivePoll();
  const r = state.runs.get(id);
  if (!r || !LIVE_POLL.has(r.status)) return;
  const tick = async () => {
    if (state.openDrawer !== id) return stopLivePoll();
    const cur = state.runs.get(id);
    if (!cur || !LIVE_POLL.has(cur.status)) return stopLivePoll();
    try {
      const res = await fetch('/api/runs/' + id + '/live');
      if (!res.ok || state.openDrawer !== id) return;
      const out = (await res.json()).output || '';
      state.live.set(id, out);
      const c = $('#drawer-console');
      const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
      c.textContent = out;
      if (atBottom) c.scrollTop = c.scrollHeight;
    } catch {}
  };
  state.liveTimer = setInterval(tick, 700);
  tick();
}

function stopLivePoll() {
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = null;
}

function appendLive(id, chunk) {
  // The live poller owns the console (and live buffer) for the run it's polling;
  // skip the line-by-line path so the two don't fight over the same pane.
  if (state.liveTimer && state.openDrawer === id) return;
  let buf = state.live.get(id) || '';
  buf += chunk;
  if (buf.length > 400000) buf = buf.slice(-300000);
  state.live.set(id, buf);
  if (state.openDrawer === id) {
    const c = $('#drawer-console');
    const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
    c.textContent = buf;
    if (atBottom) c.scrollTop = c.scrollHeight;
  }
}

// Once a run is no longer live, the Raw stream must come from the on-disk log,
// not the capture-pane snapshot. capture-pane is a bounded terminal grid (capped
// at the tmux history-limit) and — because polling stops the instant the run
// completes — it freezes ~one poll interval before the end, so the final burst
// of output and the completion lines never land in it. The log (written by
// pipe-pane) is the complete record, so pull from it here.
async function loadLogStream(id) {
  try {
    const res = await fetch('/api/runs/' + id + '/log');
    if (!res.ok) return;
    const text = await res.text();
    state.live.set(id, text);
    // Only paint if the poller isn't currently driving this console.
    if (state.openDrawer === id && !state.liveTimer) {
      const c = $('#drawer-console');
      const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
      c.textContent = text;
      if (atBottom) c.scrollTop = c.scrollHeight;
    }
  } catch {}
}

// Accumulate output for a single command as it streams, for the live parsed view.
function appendStepLive(id, idx, chunk) {
  const meta = state.details.get(id);
  const step = meta && meta.commands ? meta.commands[idx - 1] : null;
  // Skip the echoed "$ <cmd>" banner — the command is already the step header.
  if (step && chunk === '$ ' + step.text + '\n') return;
  let m = state.stepLive.get(id);
  if (!m) { m = new Map(); state.stepLive.set(id, m); }
  let buf = (m.get(idx) || '') + chunk;
  if (buf.length > 200000) buf = buf.slice(-150000);
  m.set(idx, buf);
  if (state.openDrawer === id) updateDrawerStepLive(idx, buf);
}

// Best output for a command: finalized log output if present, else live buffer.
function getStepOutput(id, step) {
  if (step.output && step.output.length) return step.output;
  const m = state.stepLive.get(id);
  return (m && m.get(step.idx)) || '';
}

function updateDrawerStepLive(idx, buf) {
  const body = document.querySelector(`#drawer-steps .dstep[data-idx="${idx}"] .console`);
  if (!body) return;
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
  body.textContent = buf;
  if (atBottom) body.scrollTop = body.scrollHeight;
}

// ---------- Navigation ----------
$$('.nav-item').forEach((b) =>
  b.addEventListener('click', () => switchView(b.dataset.view))
);
function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  if (view === 'history') renderHistory();
}

// ---------- Compose ----------
// Show the absolute directory new tmux sessions start in.
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.sessionCwd) {
      const el = $('#session-cwd');
      el.textContent = cfg.sessionCwd;
      el.title = cfg.sessionCwd;
    }
  } catch {}
}

// ----- Line-number gutter for the commands editor -----
// Numbers logical lines; soft-wrapped continuation rows get a ↪ so wrapping is
// visually distinct from a real newline. A hidden mirror measures how many
// visual rows each line occupies at the textarea's current width.
const cmdInput = $('#set-commands');
const cmdGutter = $('#cmd-gutter');
let cmdMirror;

function gutterMirror(ta) {
  if (!cmdMirror) {
    cmdMirror = document.createElement('div');
    cmdMirror.setAttribute('aria-hidden', 'true');
    Object.assign(cmdMirror.style, {
      position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', padding: '0',
    });
    document.body.appendChild(cmdMirror);
  }
  const cs = getComputedStyle(ta);
  Object.assign(cmdMirror.style, {
    fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing, whiteSpace: 'pre-wrap',
    wordBreak: cs.wordBreak, overflowWrap: cs.overflowWrap, tabSize: cs.tabSize,
    width: ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 'px',
  });
  return cmdMirror;
}

function lineHeightPx(ta) {
  const cs = getComputedStyle(ta);
  let lh = parseFloat(cs.lineHeight);
  if (Number.isNaN(lh)) lh = parseFloat(cs.fontSize) * 1.2;
  return lh;
}

function rebuildGutter() {
  const m = gutterMirror(cmdInput);
  const lh = lineHeightPx(cmdInput);
  const lines = cmdInput.value.split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    m.textContent = lines[i].length ? lines[i] : ' ';
    const rows = Math.max(1, Math.round(m.offsetHeight / lh));
    out += i + 1 + '\n';
    for (let r = 1; r < rows; r++) out += '↪\n';
  }
  cmdGutter.textContent = out;
  syncGutterScroll();
}

function syncGutterScroll() {
  cmdGutter.style.transform = `translateY(${-cmdInput.scrollTop}px)`;
}

cmdInput.addEventListener('input', rebuildGutter);
cmdInput.addEventListener('scroll', syncGutterScroll);
window.addEventListener('resize', rebuildGutter);

$('#run-btn').addEventListener('click', runSet);
async function runSet() {
  const name = $('#set-name').value.trim();
  const commands = $('#set-commands').value;
  const hint = $('#compose-hint');
  if (!name) return flagHint('Give the command set a name.');
  if (!commands.trim()) return flagHint('Add at least one command.');
  hint.className = 'hint';
  hint.textContent = '';
  $('#run-btn').disabled = true;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, commands }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed');
    toast(`Launched “${data.name}” in tmux`);
    $('#set-commands').value = '';
    $('#set-name').value = '';
    rebuildGutter();
    switchView('sessions');
    setTimeout(() => openDrawer(data.id), 150);
  } catch (e) {
    flagHint(e.message);
  } finally {
    $('#run-btn').disabled = false;
  }
}
function flagHint(msg) {
  const h = $('#compose-hint');
  h.className = 'hint err';
  h.textContent = msg;
}

// ---------- Rendering ----------
function renderAll() {
  renderSessions();
  updateCounts();
  if (state.view === 'history') renderHistory();
}

function updateCounts() {
  const sessions = [...state.runs.values()].filter((r) => LIVE_ACTIVE.has(r.status));
  $('#sessions-count').textContent = sessions.length;
  $('#history-count').textContent = state.runs.size;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function renderSessions() {
  const grid = $('#sessions-grid');
  const list = [...state.runs.values()]
    .filter((r) => LIVE_ACTIVE.has(r.status))
    .sort((a, b) => b.createdAt - a.createdAt);
  $('#sessions-empty').classList.toggle('hidden', list.length > 0);
  grid.innerHTML = '';
  for (const r of list) {
    const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    // Running sessions show a live, ticking elapsed (now − execution start);
    // finished ones keep their final measured duration.
    const live = r.status === 'running' || r.status === 'starting';
    const since = r.startedAt || r.createdAt;
    const durHtml = live
      ? ` · ⏱ <span data-elapsed-since="${since}"></span>`
      : r.durationMs != null ? ` · ⏱ ${fmtDuration(r.durationMs)}` : '';
    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="row">
        <div>
          <h3 title="${esc(r.name)}">${esc(r.name)}</h3>
          <div class="session-meta">${fmtTime(r.createdAt)}</div>
        </div>
        ${statusBadge(r.status)}
      </div>
      <div class="progress ${r.errored ? 'err' : ''}"><i style="width:${pct}%"></i></div>
      <div class="session-meta">${r.done}/${r.total} steps${durHtml}</div>
      <div class="steps-mini">${ticksFor(r.id)}</div>
      <div class="card-actions">
        <button class="btn ghost sm" data-act="view">Watch</button>
        <button class="btn ghost sm" data-act="copy">Copy attach</button>
        <button class="btn danger sm" data-act="end">⏻ End</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act === 'copy') { copy(r.attach); e.stopPropagation(); }
      else if (act === 'end') { e.stopPropagation(); endSession(r.id); }
      else openDrawer(r.id);
    });
    grid.appendChild(card);
  }
  tickElapsed();
}

function ticksFor(id) {
  // Prefer full meta (carries the latest per-command statuses); otherwise fall
  // back to the summary's lightweight `steps` array so refreshing mid-run paints
  // the right swatches — done (green), the running one (pulsing purple), pending
  // (grey) — instead of an all-grey row while we wait for a run:update.
  const meta = state.details.get(id);
  const summary = state.runs.get(id);
  const statuses = meta && meta.commands
    ? meta.commands.map((c) => c.status)
    : summary && summary.steps
      ? summary.steps
      : new Array(summary?.total || 0).fill('pending');
  return statuses.map((s) => `<span class="tick ${s}"></span>`).join('');
}

function statusBadge(s) {
  return `<span class="status ${s}">${s}</span>`;
}

// ---------- History ----------
async function renderHistory() {
  const wrap = $('#history-list');
  const list = [...state.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  $('#history-empty').classList.toggle('hidden', list.length > 0);
  // preserve which rows are open
  const openIds = new Set($$('.hrow.open').map((el) => el.dataset.id));
  wrap.innerHTML = '';
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'hrow' + (openIds.has(r.id) ? ' open' : '');
    row.dataset.id = r.id;
    row.innerHTML = `
      <div class="hrow-head">
        <span class="chevron">▸</span>
        <div>
          <h3>${esc(r.name)}</h3>
          <div class="hrow-when">${fmtTime(r.createdAt)} · ${esc(r.logFile)}</div>
        </div>
        <div class="hrow-spacer"></div>
        <div class="hrow-summary">${r.done}/${r.total} ok${
      r.errored ? ' · <span class="e">error</span>' : ''
    }${r.durationMs != null ? ` · ⏱ ${fmtDuration(r.durationMs)}` : ''}</div>
        ${statusBadge(r.status)}
      </div>
      <div class="hrow-body"></div>`;
    row.querySelector('.hrow-head').addEventListener('click', () => toggleHistory(r.id, row));
    wrap.appendChild(row);
    if (openIds.has(r.id)) fillHistoryBody(r.id, row);
  }
}

async function toggleHistory(id, row) {
  row.classList.toggle('open');
  if (row.classList.contains('open')) await fillHistoryBody(id, row);
}

async function fillHistoryBody(id, row) {
  const body = row.querySelector('.hrow-body');
  const meta = await fetchDetail(id);
  body.innerHTML = '';

  // Toolbar: expand/collapse all of THIS run's command outputs, select-all,
  // and "send selected to Compose".
  const tools = document.createElement('div');
  tools.className = 'cmd-tools';
  tools.innerHTML = `
    <button class="btn ghost sm exp-all">Expand all</button>
    <button class="btn ghost sm col-all">Collapse all</button>
    <label class="checkline"><input type="checkbox" class="sel-all" /> Select all</label>
    <span class="cmd-tools-spacer"></span>
    <button class="btn primary sm send-compose" disabled>→ Edit in Compose <span class="seln">(0)</span></button>`;
  body.appendChild(tools);

  for (const c of meta.commands) {
    const cmd = document.createElement('div');
    cmd.className = 'cmd ' + (c.status === 'error' ? 'err' : '');
    const rcTxt = c.rc == null ? '' : `exit ${c.rc}`;
    const dur = fmtDuration(stepDurationMs(c));
    cmd.innerHTML = `
      <div class="cmd-head">
        <input type="checkbox" class="cmd-sel" data-idx="${c.idx}" />
        <span class="dotmark ${c.status}"></span>
        <span class="cmd-idx">${c.idx}</span>
        <span class="cmd-text">${esc(c.text)}</span>
        ${dur ? `<span class="cmd-dur">⏱ ${dur}</span>` : ''}
        <span class="cmd-rc ${c.rc ? 'bad' : ''}">${rcTxt}</span>
        <button class="mini-copy" title="Copy command">⧉</button>
      </div>
      <div class="cmd-body"><pre class="console">${esc(c.output || '')}</pre></div>`;
    cmd.querySelector('.cmd-head').addEventListener('click', (e) => {
      if (e.target.classList.contains('cmd-sel')) return; // let checkbox toggle
      if (e.target.classList.contains('mini-copy')) { copy(c.text); return; }
      cmd.classList.toggle('open');
    });
    cmd.querySelector('.cmd-sel').addEventListener('change', () => updateSelState(body, meta));
    body.appendChild(cmd);
  }

  tools.querySelector('.sel-all').addEventListener('change', (e) => {
    $$('.cmd-sel', body).forEach((cb) => (cb.checked = e.target.checked));
    updateSelState(body, meta);
  });
  tools.querySelector('.exp-all').addEventListener('click', () =>
    $$('.cmd', body).forEach((c) => c.classList.add('open'))
  );
  tools.querySelector('.col-all').addEventListener('click', () =>
    $$('.cmd', body).forEach((c) => c.classList.remove('open'))
  );
  tools.querySelector('.send-compose').addEventListener('click', () =>
    sendToCompose(body, meta)
  );
}

function selectedIdxs(body) {
  return $$('.cmd-sel', body)
    .filter((cb) => cb.checked)
    .map((cb) => +cb.dataset.idx)
    .sort((a, b) => a - b);
}

function updateSelState(body, meta) {
  const sel = selectedIdxs(body);
  const btn = body.querySelector('.send-compose');
  btn.disabled = sel.length === 0;
  btn.querySelector('.seln').textContent = `(${sel.length})`;
  const all = $$('.cmd-sel', body);
  body.querySelector('.sel-all').checked = all.length > 0 && sel.length === all.length;
}

// Load the ticked commands (in order) back into Compose for editing + re-run.
function sendToCompose(body, meta) {
  const sel = selectedIdxs(body);
  if (!sel.length) return;
  const byIdx = new Map(meta.commands.map((c) => [c.idx, c]));
  const lines = sel.map((i) => byIdx.get(i).text);
  $('#set-name').value = meta.name + '-edit';
  $('#set-commands').value = lines.join('\n');
  rebuildGutter();
  switchView('compose');
  $('#set-commands').focus();
  toast(`Loaded ${sel.length} command(s) into Compose`);
}

async function fetchDetail(id) {
  const res = await fetch('/api/runs/' + id);
  const meta = await res.json();
  state.details.set(id, meta);
  return meta;
}

// ---------- Drawer ----------
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-scrim').addEventListener('click', closeDrawer);
$('#drawer-copy').addEventListener('click', () => {
  const r = state.runs.get(state.openDrawer);
  if (r) copy(r.attach);
});
$('#drawer-kill').addEventListener('click', () => {
  if (state.openDrawer) endSession(state.openDrawer);
});

// Close a tmux session after an in-app confirmation (no native dialog).
async function endSession(id) {
  const r = state.runs.get(id);
  const ok = await confirmDialog({
    title: 'Close session?',
    body: `End the tmux session ${r ? `“${r.name}”` : ''} and stop any running command. The log is kept in History.`,
    confirmText: '⏻ Close session',
  });
  if (!ok) return;
  try {
    await fetch('/api/runs/' + id + '/close', { method: 'POST' });
    toast('Session closed');
  } catch {
    toast('Failed to close session');
  }
}
$('#dstep-expand-all').addEventListener('click', () => {
  const meta = state.details.get(state.openDrawer);
  if (!meta) return;
  meta.commands.forEach((c) => state.drawerOpenSteps.add(c.idx));
  $$('#drawer-steps .dstep').forEach((el) => el.classList.add('open'));
});
$('#dstep-collapse-all').addEventListener('click', () => {
  state.drawerOpenSteps.clear();
  $$('#drawer-steps .dstep').forEach((el) => el.classList.remove('open'));
});

async function openDrawer(id) {
  state.openDrawer = id;
  state.drawerOpenSteps = new Set();
  $('#drawer').classList.remove('hidden');
  $('#drawer-scrim').classList.remove('hidden');
  // Seed the Raw stream. A live run uses the rendered grid (capture-pane) so
  // in-place \r refreshes (spinners, progress bars) display correctly, and the
  // poller keeps it fresh. A finished run uses the complete log — capture-pane
  // would miss the tail and anything past the history-limit.
  const seed = state.runs.get(id);
  if (seed && LIVE_POLL.has(seed.status)) {
    if (!state.live.get(id)) {
      try {
        const res = await fetch('/api/runs/' + id + '/live');
        if (res.ok) state.live.set(id, (await res.json()).output || '');
      } catch {}
    }
  } else {
    await loadLogStream(id);
  }
  await fetchDetail(id);
  renderDrawer(id);
  const c = $('#drawer-console');
  c.scrollTop = c.scrollHeight;
  startLivePoll(id);
}

function closeDrawer() {
  stopLivePoll();
  state.openDrawer = null;
  $('#drawer').classList.add('hidden');
  $('#drawer-scrim').classList.add('hidden');
}

function renderDrawer(id) {
  const r = state.runs.get(id);
  const meta = state.details.get(id);
  if (!r) return;
  $('#drawer-title').textContent = r.name;
  $('#drawer-sub').innerHTML = `${statusBadge(r.status)} <span style="color:var(--faint)">${esc(
    r.session
  )}</span>`;
  $('#drawer-attach-cmd').textContent = r.attach;
  $('#drawer-rawlog').href = '/api/runs/' + id + '/log';
  const alive = LIVE_ACTIVE.has(r.status);
  $('#drawer-kill').style.display = alive ? '' : 'none';
  $('#drawer-live-status').textContent =
    r.status === 'paused' ? '⏸ paused on error — attach to take over'
    : r.status === 'running' ? '● live'
    : r.status === 'completed' ? '✓ finished (session retained)'
    : r.status === 'closed' ? 'session closed' : r.status;

  const t = meta ? runTiming(meta.commands, meta.finishedAt) : { durationMs: null, startedAt: null };
  // While running, tick the total live (now − execution start); else show the
  // final measured total.
  if (r.status === 'running' || r.status === 'starting') {
    const since = (t.startedAt || r.createdAt);
    $('#drawer-steps-total').innerHTML = since
      ? `⏱ <span data-elapsed-since="${since}"></span> total` : '';
  } else {
    $('#drawer-steps-total').textContent = t.durationMs != null ? `⏱ ${fmtDuration(t.durationMs)} total` : '';
  }

  const steps = $('#drawer-steps');
  steps.innerHTML = '';
  for (const c of meta ? meta.commands : []) {
    const open = state.drawerOpenSteps.has(c.idx);
    const dur = fmtDuration(stepDurationMs(c));
    const el = document.createElement('div');
    el.className = 'dstep ' + c.status + (open ? ' open' : '');
    el.dataset.idx = c.idx;
    el.innerHTML = `
      <div class="dstep-head">
        <span class="dotmark ${c.status}"></span>
        <span class="cmd-idx">${c.idx}</span>
        <span class="cmd-text">${esc(c.text)}</span>
        ${
          dur ? `<span class="cmd-dur">⏱ ${dur}</span>`
          : c.status === 'running' && c.startedAt
            ? `<span class="cmd-dur run">⏱ <span data-elapsed-since="${c.startedAt}"></span></span>`
          : c.status === 'running' ? '<span class="cmd-dur run">running…</span>' : ''
        }
        <span class="cmd-rc ${c.rc ? 'bad' : ''}">${c.rc == null ? '' : 'exit ' + c.rc}</span>
        <button class="mini-copy" title="Copy command">⧉</button>
      </div>
      <div class="dstep-body"><pre class="console">${esc(getStepOutput(id, c))}</pre></div>`;
    el.querySelector('.dstep-head').addEventListener('click', (e) => {
      if (e.target.classList.contains('mini-copy')) { copy(c.text); return; }
      el.classList.toggle('open');
      if (el.classList.contains('open')) state.drawerOpenSteps.add(c.idx);
      else state.drawerOpenSteps.delete(c.idx);
    });
    steps.appendChild(el);
  }

  // While the live poller is driving this console, let it own the content so a
  // re-render (e.g. on a status update) doesn't overwrite the latest grid.
  if (!(state.liveTimer && state.openDrawer === id)) {
    const console = $('#drawer-console');
    console.textContent = state.live.get(id) || '';
  }
  tickElapsed();
}

// ---------- Confirm modal ----------
// In-app confirmation styled like the rest of the UI (replaces window.confirm).
// Resolves true on confirm, false on cancel / scrim / Esc.
function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = true }) {
  return new Promise((resolve) => {
    const scrim = $('#modal-scrim');
    $('#modal-title').textContent = title;
    $('#modal-body').textContent = body;
    const ok = $('#modal-confirm');
    const cancel = $('#modal-cancel');
    ok.textContent = confirmText;
    cancel.textContent = cancelText;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    scrim.classList.remove('hidden');
    const cleanup = (result) => {
      scrim.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      scrim.removeEventListener('mousedown', onScrim);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onScrim = (e) => { if (e.target === scrim) cleanup(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    scrim.addEventListener('mousedown', onScrim);
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}

// ---------- Utils ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[m]));
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied: ' + text);
  } catch {
    toast('Copy failed — ' + text);
  }
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// Populate immediately over REST (works even if the WebSocket is blocked or
// slow behind a proxy/tunnel); the socket then keeps things live.
async function loadInitial() {
  try {
    const res = await fetch('/api/runs');
    if (!res.ok) return;
    const runs = await res.json();
    runs.forEach((r) => state.runs.set(r.id, r));
    renderAll();
  } catch {}
}

loadInitial();
loadConfig();
rebuildGutter();
connect();
// Tick all live elapsed counters (running cards + the open drawer) once a second.
setInterval(tickElapsed, 1000);
