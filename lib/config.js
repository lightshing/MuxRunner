import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

// Where the app was launched from. Logs land in <cwd>/logs as requested
// ("持久化到当前目录下的log文件夹内").
export const WORK_DIR = process.cwd();

export const PORT = Number(process.env.MUXRUNNER_PORT || process.env.PORT || 1369);
export const HOST = process.env.MUXRUNNER_HOST || '127.0.0.1';

export const LOG_DIR = path.resolve(WORK_DIR, process.env.MUXRUNNER_LOG_DIR || 'logs');
export const RUNNER_DIR = path.resolve(LOG_DIR, '.runners');

// Working directory new tmux sessions start in. Defaults to the parent of the
// app directory (i.e. /home/ubuntu when the app lives in /home/ubuntu/MuxRunner)
// so commands run from the user's home, not inside the tool's own checkout.
// Override with MUXRUNNER_SESSION_CWD (absolute, or relative to WORK_DIR).
export const SESSION_CWD = path.resolve(WORK_DIR, process.env.MUXRUNNER_SESSION_CWD || '..');

// Prefix for every tmux session this app creates.
export const SESSION_PREFIX = 'muxrunner';

// --- Telegram bot config --------------------------------------------------
// Fill in your Bot API token + chat id in `telegram.config.json` (copy from
// telegram.config.example.json). Environment variables override the file:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ENABLED=0|1
// Override the config-file location with MUXRUNNER_TELEGRAM_CONFIG.
function loadTelegramFile() {
  const file = process.env.MUXRUNNER_TELEGRAM_CONFIG || path.resolve(ROOT, 'telegram.config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const _tg = loadTelegramFile();

const _tgEnabledEnv = process.env.TELEGRAM_ENABLED;
const botToken = (process.env.TELEGRAM_BOT_TOKEN || _tg.botToken || '').trim();
const chatId = String(process.env.TELEGRAM_CHAT_ID || _tg.chatId || '').trim();

export const TELEGRAM = {
  // Considered configured only when a real-looking token is present.
  botToken,
  chatId,
  // Master switch: explicit env/file `enabled:false` disables it even if a
  // token is present; otherwise it's on whenever a token exists.
  enabled:
    botToken.length > 0 &&
    botToken !== 'PASTE-YOUR-BOT-TOKEN-HERE' &&
    (_tgEnabledEnv != null ? _tgEnabledEnv !== '0' && _tgEnabledEnv !== 'false' : _tg.enabled !== false),
};
