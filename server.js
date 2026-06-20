import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { PORT, HOST, LOG_DIR, SESSION_CWD } from './lib/config.js';
import { manager } from './lib/store.js';
import { isTmuxAvailable } from './lib/tmux.js';
import { stripAnsi } from './lib/util.js';
import { bot } from './lib/telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!(await isTmuxAvailable())) {
    console.error('FATAL: tmux is not installed or not on PATH. Install tmux and retry.');
    process.exit(1);
  }
  await manager.init();

  // Telegram push + bot commands (no-op unless a bot token is configured).
  bot.start(manager);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // --- REST API ---------------------------------------------------------
  // The absolute working directory a fresh tmux session starts in, so the
  // Compose view can show users where their commands will run from.
  app.get('/api/config', (_req, res) => {
    res.json({ sessionCwd: SESSION_CWD });
  });

  app.get('/api/runs', (_req, res) => {
    res.json(manager.list());
  });

  app.post('/api/runs', async (req, res) => {
    try {
      const { name, commands, trigger } = req.body || {};
      const list = Array.isArray(commands)
        ? commands
        : String(commands || '').split('\n');
      // A trigger of anything other than "now" defers the set into the pending
      // queue instead of launching it immediately.
      if (trigger && trigger.type && trigger.type !== 'now') {
        const task = await manager.createPending(String(name || 'untitled'), list, undefined, trigger);
        res.json(task.summary());
      } else {
        const run = await manager.create(String(name || 'untitled'), list);
        res.json(run.summary());
      }
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Pending (deferred / scheduled) command sets ----------------------
  app.get('/api/pending', (_req, res) => {
    res.json(manager.listPending());
  });

  app.post('/api/pending/:id/start', async (req, res) => {
    try {
      const run = await manager.firePending(req.params.id);
      res.json(run.summary());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/pending/:id/cancel', async (req, res) => {
    const ok = await manager.cancelPending(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = manager.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run.toJSON());
  });

  app.get('/api/runs/:id/live', async (req, res) => {
    const out = await manager.live(req.params.id);
    if (out == null) return res.status(404).json({ error: 'not found' });
    res.json({ output: out });
  });

  app.get('/api/runs/:id/log', async (req, res) => {
    const run = manager.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    try {
      const data = await fsp.readFile(path.join(LOG_DIR, run.logFile), 'utf8');
      // Default to a clean, ANSI-stripped view (the on-disk file keeps the full
      // raw terminal record). Pass ?raw=1 for the unfiltered byte stream.
      const out = 'raw' in req.query ? data : stripAnsi(data);
      res.type('text/plain; charset=utf-8').send(out);
    } catch {
      res.status(404).json({ error: 'log missing' });
    }
  });

  app.post('/api/runs/:id/close', async (req, res) => {
    const run = manager.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    await run.close();
    res.json(run.summary());
  });

  // --- HTTP + WebSocket -------------------------------------------------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  };

  manager.on('run:update', (meta) => broadcast({ type: 'run:update', run: meta }));
  manager.on('run:output', (payload) => broadcast({ type: 'run:output', ...payload }));
  manager.on('pending:update', (task) => broadcast({ type: 'pending:update', task }));
  manager.on('pending:remove', (payload) => broadcast({ type: 'pending:remove', ...payload }));

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', runs: manager.list(), pending: manager.listPending() }));
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n  MuxRunner running at  http://${HOST}:${PORT}`);
    console.log(`  Logs directory:       ${LOG_DIR}\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
