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

// Prefix for every tmux session this app creates.
export const SESSION_PREFIX = 'muxrunner';
