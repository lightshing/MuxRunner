// Telegram bot integration for MuxRunner.
//
// Two jobs:
//   1) PUSH — listen to the run manager and proactively message you when a
//      command set starts, pauses (on error), or ends.
//   2) PULL — long-poll Telegram for commands so you can ask, from your phone,
//      which sessions are running, their progress, and the attach command.
//
// Dependency-free: uses Node 18+ global fetch. Configure via telegram.config.json
// (see telegram.config.example.json) or TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.

import { TELEGRAM } from './config.js';

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

// Statuses we treat as "still alive / interesting" for the sessions list.
const ACTIVE = new Set(['starting', 'running', 'paused']);
const TERMINAL = new Set(['completed', 'paused', 'closed']);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDuration(ms) {
  if (ms == null || ms < 0) return null;
  const s = ms / 1000;
  if (s < 1) return `${ms}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Derive a compact progress view from a full run JSON (toJSON()).
function progressOf(run) {
  const cmds = run.commands || [];
  const total = cmds.length;
  const done = cmds.filter((c) => c.status === 'done').length;
  const errored = cmds.find((c) => c.status === 'error') || null;
  const running = cmds.find((c) => c.status === 'running') || null;
  return { total, done, errored, running };
}

const STATUS_EMOJI = {
  starting: '🟡',
  running: '🟢',
  paused: '⏸️',
  completed: '✅',
  closed: '🛑',
};

export class TelegramBot {
  constructor({ token, chatId } = {}) {
    this.token = token || TELEGRAM.botToken;
    this.chatId = chatId || TELEGRAM.chatId;
    this.manager = null;
    this._lastStatus = new Map(); // run id -> last seen status
    this._offset = 0; // getUpdates offset
    this._polling = false;
    this._stopped = false;
  }

  get enabled() {
    return Boolean(this.token);
  }

  // Wire up to the manager and start the command poller. Call AFTER
  // manager.init() so existing history doesn't spam "started" notifications.
  start(manager) {
    if (!this.enabled) return;
    this.manager = manager;

    // Seed known runs so only genuinely-new runs trigger a start push.
    for (const r of manager.list()) this._lastStatus.set(r.id, r.status);

    manager.on('run:update', (run) => this._onRunUpdate(run));

    this._poll();

    console.log(
      this.chatId
        ? '  Telegram:             enabled (push + commands)'
        : '  Telegram:             enabled — no chatId yet; message the bot to get yours'
    );
  }

  stop() {
    this._stopped = true;
  }

  // --- Push notifications -------------------------------------------------
  _onRunUpdate(run) {
    const prev = this._lastStatus.get(run.id);
    const cur = run.status;
    this._lastStatus.set(run.id, cur);

    if (prev === cur) return;

    const isNew = prev === undefined;
    if (isNew && (cur === 'starting' || cur === 'running')) {
      this._notifyStarted(run);
      return;
    }
    // Fire end/pause notifications once, on entering a terminal state.
    if (TERMINAL.has(cur) && !TERMINAL.has(prev || '')) {
      if (cur === 'paused') this._notifyPaused(run);
      else if (cur === 'completed') this._notifyCompleted(run);
      else if (cur === 'closed') this._notifyClosed(run);
    }
  }

  _notifyStarted(run) {
    const { total } = progressOf(run);
    const lines = [
      '🚀 <b>指令集已启动</b> · Command set started',
      `📛 名称 Name: <b>${esc(run.name)}</b>`,
      `🔢 指令数量 Commands: <b>${total}</b>`,
      `📡 Attach: <code>${esc(run.attach)}</code>`,
      `🆔 <code>${esc(run.id)}</code>`,
    ];
    this.push(lines.join('\n'));
  }

  _notifyPaused(run) {
    const { total, done, errored } = progressOf(run);
    const lines = [
      '⏸️ <b>运行已暂停</b> · Paused on error',
      `📛 名称 Name: <b>${esc(run.name)}</b>`,
      `📊 进度 Progress: <b>${done}/${total}</b> 完成`,
    ];
    if (errored) {
      lines.push(`❌ 失败命令 Failed: <code>${esc(errored.text)}</code> (rc=${errored.rc})`);
    }
    lines.push(`📡 Attach: <code>${esc(run.attach)}</code>`);
    lines.push('ℹ️ 会话仍存活，可 attach 接管 · Session kept alive — attach to take over.');
    this.push(lines.join('\n'));
  }

  _notifyCompleted(run) {
    const { total } = progressOf(run);
    const dur = fmtDuration(run.durationMs);
    const lines = [
      '✅ <b>运行结束</b> · Completed',
      `📛 名称 Name: <b>${esc(run.name)}</b>`,
      `🔢 指令数量 Commands: <b>${total}</b>（全部完成 all done）`,
    ];
    if (dur) lines.push(`⏱️ 用时 Duration: <b>${dur}</b>`);
    lines.push(`📡 Attach: <code>${esc(run.attach)}</code>`);
    this.push(lines.join('\n'));
  }

  _notifyClosed(run) {
    const { total, done } = progressOf(run);
    this.push(
      [
        '🛑 <b>会话已关闭</b> · Session closed',
        `📛 名称 Name: <b>${esc(run.name)}</b>`,
        `📊 进度 Progress: <b>${done}/${total}</b>`,
      ].join('\n')
    );
  }

  // --- Telegram API helpers ----------------------------------------------
  async push(text) {
    if (!this.chatId) return; // nowhere to send yet
    return this.sendMessage(this.chatId, text);
  }

  async sendMessage(chatId, text) {
    try {
      const res = await fetch(API(this.token, 'sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`Telegram sendMessage failed (${res.status}): ${body}`);
      }
    } catch (err) {
      console.error('Telegram sendMessage error:', err.message);
    }
  }

  // --- Command poller (long polling) -------------------------------------
  async _poll() {
    if (this._polling || this._stopped) return;
    this._polling = true;
    while (!this._stopped) {
      try {
        const res = await fetch(API(this.token, 'getUpdates') + `?timeout=30&offset=${this._offset}`, {
          // a little over the long-poll timeout
          signal: AbortSignal.timeout(40000),
        });
        const data = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          for (const upd of data.result) {
            this._offset = upd.update_id + 1;
            await this._handleUpdate(upd).catch(() => {});
          }
        }
      } catch {
        // Network hiccup / timeout — back off briefly and retry.
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    this._polling = false;
  }

  async _handleUpdate(upd) {
    const msg = upd.message || upd.edited_message;
    if (!msg || !msg.text) return;
    const fromChat = String(msg.chat.id);
    const text = msg.text.trim();

    // If we don't yet know the target chat, help the user discover it and
    // refuse to leak run data to arbitrary chats.
    if (!this.chatId) {
      await this.sendMessage(
        fromChat,
        [
          '👋 MuxRunner bot is connected.',
          `Your chat id is: <code>${esc(fromChat)}</code>`,
          'Put it in <code>telegram.config.json</code> as <b>chatId</b> (or set TELEGRAM_CHAT_ID) and restart to enable push + commands.',
        ].join('\n')
      );
      return;
    }

    // Only serve the configured chat.
    if (fromChat !== String(this.chatId)) return;

    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
    switch (cmd) {
      case '/sessions':
      case '/status':
      case '/s':
        await this.sendMessage(fromChat, this._renderSessions());
        break;
      case '/all':
        await this.sendMessage(fromChat, this._renderAll());
        break;
      case '/start':
      case '/help':
      default:
        await this.sendMessage(fromChat, this._renderHelp());
        break;
    }
  }

  _renderHelp() {
    return [
      '⚡ <b>MuxRunner bot</b>',
      '',
      '/sessions — 正在运行的会话、进度与 attach 指令 · live sessions, progress & attach',
      '/all — 最近的运行记录 · recent runs',
      '/help — 显示帮助 · this help',
      '',
      'ℹ️ 指令集启动 / 暂停 / 结束 时会主动推送通知。',
    ].join('\n');
  }

  _renderSessions() {
    const runs = this.manager
      .list()
      .filter((r) => ACTIVE.has(r.status))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (runs.length === 0) return '😴 当前没有活动的会话 · No active sessions right now.';

    const blocks = runs.map((r) => {
      const em = STATUS_EMOJI[r.status] || '•';
      const lines = [
        `${em} <b>${esc(r.name)}</b> — ${esc(r.status)}`,
        `📊 进度 Progress: <b>${r.done}/${r.total}</b>${r.errored ? ' ❌' : ''}`,
        `📡 <code>${esc(r.attach)}</code>`,
      ];
      return lines.join('\n');
    });

    return [`🖥️ <b>活动会话 Active sessions: ${runs.length}</b>`, '', blocks.join('\n\n')].join('\n');
  }

  _renderAll(limit = 10) {
    const runs = this.manager.list().slice(0, limit);
    if (runs.length === 0) return '空空如也 · No runs yet.';
    const lines = runs.map((r) => {
      const em = STATUS_EMOJI[r.status] || '•';
      const dur = fmtDuration(r.durationMs);
      return `${em} <b>${esc(r.name)}</b> — ${esc(r.status)} (${r.done}/${r.total})${dur ? ` · ${dur}` : ''}`;
    });
    return [`🗂️ <b>最近 ${runs.length} 次运行 · Recent runs</b>`, '', lines.join('\n')].join('\n');
  }
}

export const bot = new TelegramBot();
