// MuxRunner front-end — vanilla JS, no build step.
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  runs: new Map(), // id -> summary
  details: new Map(), // id -> full meta (lazy)
  live: new Map(), // id -> rolling output buffer
  openDrawer: null, // id currently shown in drawer
  view: 'compose',
};

const LIVE_ACTIVE = new Set(['starting', 'running', 'paused', 'completed']);

// ---------- WebSocket ----------
let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
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
  };
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
      <div class="session-meta">${r.done}/${r.total} steps</div>
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
    }</div>
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
  for (const c of meta.commands) {
    const cmd = document.createElement('div');
    cmd.className = 'cmd ' + (c.status === 'error' ? 'err' : '');
    const rcTxt = c.rc == null ? '' : `exit ${c.rc}`;
    cmd.innerHTML = `
      <div class="cmd-head">
        <span class="dotmark ${c.status}"></span>
        <span class="cmd-idx">${c.idx}</span>
        <span class="cmd-text">${esc(c.text)}</span>
        <span class="cmd-rc ${c.rc ? 'bad' : ''}">${rcTxt}</span>
      </div>
      <div class="cmd-body"><pre class="console">${esc(c.output || '')}</pre></div>`;
    cmd.querySelector('.cmd-head').addEventListener('click', () => cmd.classList.toggle('open'));
    body.appendChild(cmd);
  }
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

async function openDrawer(id) {
  state.openDrawer = id;
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

  const steps = $('#drawer-steps');
  steps.innerHTML = (meta ? meta.commands : []).map((c) => `
    <div class="dstep ${c.status}">
      <span class="dotmark ${c.status}"></span>
      <span class="cmd-idx">${c.idx}</span>
      <span class="cmd-text">${esc(c.text)}</span>
      <span class="cmd-rc ${c.rc ? 'bad' : ''}">${c.rc == null ? '' : 'exit ' + c.rc}</span>
    </div>`).join('');

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

connect();
