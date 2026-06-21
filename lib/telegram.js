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

// Statuses shown by the history view (/all). History is split into exactly two
// kinds: ✅ completed (ran to the end) and ⏹️ closed (the session was stopped).
// Paused runs are still alive, so they live under /sessions, not here.
const HISTORY = ['completed', 'closed'];

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

function fmtTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return new Date(ms).toISOString();
  }
}

// Trim a label so it fits comfortably on an inline button.
function truncate(s, n = 22) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
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

// Clean, semantically-distinct glyphs — no garish red/green dots.
const STATUS_EMOJI = {
  starting: '⏳',
  running: '▶️',
  paused: '⏸️',
  completed: '✅',
  closed: '⏹️',
};

const STATUS_LABEL = {
  starting: '启动中 starting',
  running: '运行中 running',
  paused: '已暂停 paused',
  completed: '已完成 completed',
  closed: '已关闭 closed',
};

const statusTag = (s) => `${STATUS_EMOJI[s] || '•'} ${STATUS_LABEL[s] || s}`;

// Persistent bottom menu (reply keyboard). It stays docked at the bottom of the
// chat across all messages, so individual messages no longer need to carry the
// full command set inline. Tapping a button sends its label as a message, which
// we map back to a command in LABEL_TO_CMD.
const REPLY_KB = {
  keyboard: [
    [{ text: '📡 活动会话' }, { text: '📆 待执行' }],
    [{ text: '🗂️ 历史记录' }, { text: '❓ 帮助' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const LABEL_TO_CMD = {
  '📡 活动会话': 'sessions',
  '📆 待执行': 'pending',
  '🗂️ 历史记录': 'all',
  '❓ 帮助': 'help',
};

// Slash commands registered with Telegram so they show in the ☰ command menu
// next to the input box.
const BOT_COMMANDS = [
  { command: 'sessions', description: '📡 活动会话 · live sessions' },
  { command: 'pending', description: '📆 待执行任务 · scheduled / held tasks' },
  { command: 'all', description: '🗂️ 历史记录 · finished runs' },
  { command: 'help', description: '❓ 帮助 · help' },
];

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

    this._registerCommands();
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

  // Register slash commands + point the ☰ menu button at them, so the command
  // list is one tap away from the input box.
  async _registerCommands() {
    try {
      await fetch(API(this.token, 'setMyCommands'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commands: BOT_COMMANDS }),
      });
      await fetch(API(this.token, 'setChatMenuButton'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ menu_button: { type: 'commands' } }),
      });
    } catch {
      /* best-effort */
    }
  }

  // --- Telegram API helpers ----------------------------------------------
  async push(text) {
    if (!this.chatId) return; // nowhere to send yet
    return this.sendMessage(this.chatId, text, REPLY_KB);
  }

  async sendMessage(chatId, text, replyMarkup = REPLY_KB) {
    try {
      const res = await fetch(API(this.token, 'sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
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

  // Acknowledge a button tap so Telegram stops the loading spinner.
  async answerCallback(id) {
    try {
      await fetch(API(this.token, 'answerCallbackQuery'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callback_query_id: id }),
      });
    } catch {
      /* best-effort */
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
    // Button taps from the inline keyboard arrive as callback queries.
    if (upd.callback_query) {
      const cq = upd.callback_query;
      await this.answerCallback(cq.id);
      const fromChat = String(cq.message?.chat?.id ?? cq.from?.id ?? '');
      if (this.chatId && fromChat !== String(this.chatId)) return;
      await this._dispatch(cq.data || 'help', fromChat);
      return;
    }

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

    // Bottom-menu buttons send their label as text — map those to commands;
    // otherwise treat the first token as a /command.
    const cmd = LABEL_TO_CMD[text] || text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
    await this._dispatch(cmd, fromChat);
  }

  // Run a command, whether it came from typed text (/sessions) or a tapped
  // inline button (callback_data 'sessions').
  async _dispatch(raw, chatId) {
    const data = String(raw);
    // Per-task action buttons from the /pending list.
    if (data.startsWith('start:')) return this._startPending(data.slice(6), chatId);
    if (data.startsWith('cancel:')) return this._cancelPending(data.slice(7), chatId);

    const cmd = data.replace(/^\//, '').toLowerCase();
    switch (cmd) {
      case 'sessions':
      case 'status':
      case 's':
        await this.sendMessage(chatId, this._renderSessions());
        break;
      case 'pending':
      case 'scheduled': {
        const { text, keyboard } = this._renderPending();
        await this.sendMessage(chatId, text, keyboard || REPLY_KB);
        break;
      }
      case 'all':
        await this.sendMessage(chatId, this._renderAll());
        break;
      case 'start':
      case 'help':
      default:
        await this.sendMessage(chatId, this._renderHelp());
        break;
    }
  }

  // Launch a held / scheduled task right now from a button tap.
  async _startPending(id, chatId) {
    try {
      const run = await this.manager.firePending(id);
      const s = run.summary();
      await this.sendMessage(
        chatId,
        [
          '▶️ <b>已开始</b> · Started',
          `📛 名称 Name: <b>${esc(s.name)}</b>`,
          `📡 Attach: <code>${esc(s.attach)}</code>`,
        ].join('\n')
      );
    } catch (err) {
      await this.sendMessage(chatId, `⚠️ 无法开始 · Could not start: ${esc(err.message)}`);
    }
  }

  async _cancelPending(id, chatId) {
    const ok = await this.manager.cancelPending(id);
    await this.sendMessage(
      chatId,
      ok ? '🗑️ 已取消该待执行任务 · Pending task cancelled.' : '该任务已不存在 · Task no longer exists.'
    );
  }

  _triggerLabel(t) {
    if (!t) return '';
    if (t.type === 'hold') return '✋ 手动开始 · manual start';
    if (t.type === 'time' || t.type === 'delay') return `⏰ ${fmtTime(t.runAt)}`;
    if (t.type === 'after') return `🔗 等待 “${esc(t.dependsOnName || '')}” 运行结束后 · after it finishes`;
    return '';
  }

  _renderHelp() {
    return [
      '⚡ <b>MuxRunner bot</b>',
      '',
      '👇 用下方常驻菜单，或左下角 ☰ 命令菜单 · Use the bottom menu or the ☰ command menu.',
      '',
      '📡 <b>活动会话</b> — 正在运行的会话、进度与 attach · live sessions',
      '📆 <b>待执行</b> — 定时 / 触发 / 手动留存的任务，可一键开始 · pending tasks, tap to start',
      '🗂️ <b>历史记录</b> — 已完成 / 已关闭的运行，分类展示 · completed & closed runs',
      '❓ <b>帮助</b> — 显示这条帮助 · this help',
      '',
      'ℹ️ 指令集启动 / 暂停 / 结束 时会主动推送通知。',
    ].join('\n');
  }

  // Pending tasks (deferred / scheduled / held). Each gets a "▶️ start" and a
  // "✕ cancel" inline button so you can launch or drop it from your phone.
  _renderPending() {
    const tasks = this.manager.listPending();
    if (tasks.length === 0) {
      return { text: '🗒️ 没有待执行的任务 · No pending tasks right now.', keyboard: null };
    }
    const lines = [`📆 <b>待执行任务 · Pending tasks: ${tasks.length}</b>`, ''];
    const rows = [];
    tasks.forEach((t, i) => {
      const steps = t.commands.length;
      lines.push(`${i + 1}. <b>${esc(t.name)}</b> · ${steps} 步 steps`);
      lines.push(`   ${this._triggerLabel(t.trigger)}`);
      lines.push('');
      rows.push([
        { text: `▶️ ${i + 1}. ${truncate(t.name)}`, callback_data: `start:${t.id}` },
        { text: '✕', callback_data: `cancel:${t.id}` },
      ]);
    });
    return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
  }

  _renderSessions() {
    const runs = this.manager
      .list()
      .filter((r) => ACTIVE.has(r.status))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (runs.length === 0) return '😴 当前没有活动的会话 · No active sessions right now.';

    const blocks = runs.map((r) => {
      const lines = [
        `${statusTag(r.status)} — <b>${esc(r.name)}</b>`,
        `📊 进度 Progress: <b>${r.done}/${r.total}</b>${r.errored ? ' ❌' : ''}`,
        `📡 <code>${esc(r.attach)}</code>`,
      ];
      return lines.join('\n');
    });

    return [`🖥️ <b>活动会话 Active sessions: ${runs.length}</b>`, '', blocks.join('\n\n')].join('\n');
  }

  // History view: the finished runs, split into two clearly-distinct kinds —
  // ✅ completed and ⏹️ closed — newest first. Each entry carries its progress,
  // duration and finish time so the record reads as a full history, not a teaser.
  _renderAll(perKind = 15) {
    const runs = this.manager.list().filter((r) => HISTORY.includes(r.status));
    if (runs.length === 0) return '空空如也 · No finished runs yet.';

    const sections = HISTORY.map((status) => {
      const group = runs
        .filter((r) => r.status === status)
        .sort((a, b) => (b.finishedAt || b.createdAt || 0) - (a.finishedAt || a.createdAt || 0));
      if (group.length === 0) return null;
      const shown = group.slice(0, perKind);
      const items = shown.map((r) => {
        const dur = fmtDuration(r.durationMs);
        const when = fmtTime(r.finishedAt || r.createdAt);
        const meta = [dur ? `⏱️ ${dur}` : null, when ? `🕒 ${when}` : null].filter(Boolean).join(' · ');
        const head = `• <b>${esc(r.name)}</b> — ${r.done}/${r.total}${r.errored ? ' ❌' : ''}`;
        return meta ? `${head}\n   ${meta}` : head;
      });
      const more = group.length > shown.length ? [`   … 还有 ${group.length - shown.length} 条 more`] : [];
      return [`${statusTag(status)} · ${group.length}`, ...items, ...more].join('\n');
    }).filter(Boolean);

    return [`🗂️ <b>历史记录 · History: ${runs.length}</b>`, '', sections.join('\n\n')].join('\n');
  }
}

export const bot = new TelegramBot();
