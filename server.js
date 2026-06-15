import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { PORT, HOST, LOG_DIR } from './lib/config.js';
import { manager } from './lib/store.js';
import { isTmuxAvailable } from './lib/tmux.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!(await isTmuxAvailable())) {
    console.error('FATAL: tmux is not installed or not on PATH. Install tmux and retry.');
    process.exit(1);
  }
  await manager.init();

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // --- REST API ---------------------------------------------------------
  app.get('/api/runs', (_req, res) => {
    res.json(manager.list());
  });

  app.post('/api/runs', async (req, res) => {
    try {
      const { name, commands } = req.body || {};
      const list = Array.isArray(commands)
        ? commands
        : String(commands || '').split('\n');
      const run = await manager.create(String(name || 'untitled'), list);
      res.json(run.summary());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
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
      res.type('text/plain').send(data);
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

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', runs: manager.list() }));
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
