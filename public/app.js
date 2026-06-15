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
  view: 'compose',
};

const LIVE_ACTIVE = new Set(['starting', 'running', 'paused', 'completed']);

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
      if (state.openDrawer === r.id) renderDrawer(r.id);
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
  return {
    id: meta.id, name: meta.name, session: meta.session, status: meta.status,
    cwd: meta.cwd, createdAt: meta.createdAt, finishedAt: meta.finishedAt,
    logFile: meta.logFile, attach: meta.attach, total, done, errored,
    durationMs: runTiming(meta.commands, meta.finishedAt).durationMs,
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

function appendLive(id, chunk) {
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
    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="row">
        <div>
          <h3>${esc(r.name)}</h3>
          <div class="session-meta">${fmtTime(r.createdAt)}</div>
        </div>
        ${statusBadge(r.status)}
      </div>
      <div class="progress ${r.errored ? 'err' : ''}"><i style="width:${pct}%"></i></div>
      <div class="session-meta">${r.done}/${r.total} steps${
        r.durationMs != null ? ` · ⏱ ${fmtDuration(r.durationMs)}` : ''
      }</div>
      <div class="steps-mini">${ticksFor(r.id)}</div>
      <div class="card-actions">
        <button class="btn ghost sm" data-act="view">Watch</button>
        <button class="btn ghost sm" data-act="copy">Copy attach</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act === 'copy') { copy(r.attach); e.stopPropagation(); }
      else openDrawer(r.id);
    });
    grid.appendChild(card);
  }
}

function ticksFor(id) {
  const meta = state.details.get(id);
  const cmds = meta ? meta.commands : new Array(state.runs.get(id)?.total || 0).fill({ status: 'pending' });
  return cmds.map((c) => `<span class="tick ${c.status}"></span>`).join('');
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
$('#drawer-kill').addEventListener('click', async () => {
  const id = state.openDrawer;
  if (!id) return;
  if (!confirm('Close this tmux session? The log is kept in History.')) return;
  await fetch('/api/runs/' + id + '/close', { method: 'POST' });
  toast('Session closed');
});
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
  // seed live buffer from server snapshot if we have nothing yet
  if (!state.live.get(id)) {
    try {
      const res = await fetch('/api/runs/' + id + '/live');
      if (res.ok) state.live.set(id, (await res.json()).output || '');
    } catch {}
  }
  await fetchDetail(id);
  renderDrawer(id);
  const c = $('#drawer-console');
  c.scrollTop = c.scrollHeight;
}

function closeDrawer() {
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

  const t = meta ? runTiming(meta.commands, meta.finishedAt) : { durationMs: null };
  $('#drawer-steps-total').textContent = t.durationMs != null ? `⏱ ${fmtDuration(t.durationMs)} total` : '';

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
        ${dur ? `<span class="cmd-dur">⏱ ${dur}</span>` : c.status === 'running' ? '<span class="cmd-dur run">running…</span>' : ''}
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

  const console = $('#drawer-console');
  console.textContent = state.live.get(id) || '';
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
connect();
