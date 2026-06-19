# ⚡ MuxRunner

**English** · [简体中文](README.zh-CN.md)

A modern, web-based **command runner** that executes named command sets
sequentially inside **tmux** sessions — with live output, automatic pausing on
error, and fully persistent logs.

Compose a list of bash commands in a clean web UI, give the set a name, and hit
run. MuxRunner spins up a fresh tmux session and runs your commands one line at a
time. If a command exits non-zero, execution **pauses** right there — the session
is kept alive so you can `tmux attach` and take over. Every session is recorded
to a timestamped log file you can browse, expand command-by-command, and inspect
for errors later.

---

## Features

- 🧩 **Compose & name command sets** — one bash command per line, in a clean,
  light, polished (non-terminal-looking) UI. The editor shows **line numbers**
  (soft-wrapped rows are marked with `↪` so you can tell a wrap from a real
  newline) and the Compose view displays the **absolute working directory** the
  fresh tmux session will start in.
- 🖥️ **Each set runs in its own tmux session** — run many concurrently.
- ▶️ **Strict sequential execution** — line _N+1_ starts only after line _N_
  finishes.
- ⏸️ **Auto-pause on error** — the first non-zero exit halts the rest and marks
  the run as *paused*; remaining commands are flagged *skipped*.
- 🔌 **Attach & take over** — every card shows a copy-paste `tmux attach …`
  command. On error, you land at an interactive prompt **in the same shell
  state** (cwd/env preserved).
- 📡 **Live output, parsed in real time** — watch a running session in the
  drawer: each command is its own expandable block whose output streams live as
  it runs (and shows everything captured so far), plus a raw full-stream view.
  While a session is running, the Raw stream mirrors the rendered terminal grid
  (polled from `capture-pane`), so in-place updates — spinners, ticking seconds,
  progress bars — show their current value instead of nothing. Self-refreshing
  lines are also collapsed to their final frame in the parsed log, so a ticking
  counter no longer balloons into a wall of every frame.
  Or copy the attach command and use your own terminal.
- ♻️ **Sessions are retained** after finishing (success *or* error). **End any
  session in one click — straight from its card** (no need to open the drawer) —
  via an in-app confirmation styled like the rest of the UI (no jarring native
  browser dialog).
- 🗂️ **Persistent logs** — the full tmux record is saved to
  `./logs/<name>_<timestamp>.log`, with a structured `.json` sidecar.
- ⏱️ **Wall-clock timing** — each command's run time is measured precisely by
  the shell (bash microsecond clock), plus a total for the whole set. Shown on
  session cards, in the live drawer (per-command + total), and in History.
- ⏲️ **Live elapsed counters** — while a set is running, its card ticks the
  total elapsed time (now − start) once a second, and the live drawer ticks both
  the running total and the **seconds the current command has been executing**.
- 🕗 **History browser** — parse any past run, expand each command to see its
  output, with errored commands highlighted. **Expand/Collapse all**, **copy any
  single command**, and **tick a subset of commands to re-send them (in order)
  into Compose** — edit, then launch a fresh run.
- 🤖 **Telegram bot** — get a push the moment a command set **starts**,
  **pauses on error**, or **ends** — each message carries the set name, command
  count, progress, and the copy-paste `tmux attach …` command. Message the bot
  back with `/sessions` to see what's running, each session's progress, and its
  attach command from your phone. See [Telegram notifications](#telegram-notifications).

---

## Requirements

MuxRunner is intentionally **dependency-light and Docker-free** for easy
portability. You need:

| Tool   | Version    | Notes                                   |
| ------ | ---------- | --------------------------------------- |
| Node.js| ≥ 18       | Uses ES modules + built-in test-free    |
| tmux   | ≥ 3.0      | The execution engine                    |
| bash   | any modern | Commands run under `bash -i`            |

Works on Linux and macOS. (Windows: use WSL.)

---

## Quick start

```bash
git clone <your-repo-url> MuxRunner
cd MuxRunner
npm install
npm start
```

Then open **http://localhost:1369**.

> Logs are written to a `logs/` folder **in the directory you launched from**.
> Run MuxRunner from wherever you want your logs to live.
>
> Your commands run in a tmux session that starts in the **parent of the app
> directory** by default (e.g. `/home/ubuntu` when MuxRunner lives in
> `/home/ubuntu/MuxRunner`) — so commands run from your home, not inside the
> tool's own checkout. Override with `MUXRUNNER_SESSION_CWD` (absolute, or
> relative to the launch directory).

### Run as a service (auto-start on boot)

On a systemd host you can keep MuxRunner running across reboots. Install
`/etc/systemd/system/muxrunner.service`:

```ini
[Unit]
Description=MuxRunner - web-based tmux command runner
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/MuxRunner
ExecStart=/usr/bin/node /home/ubuntu/MuxRunner/server.js
Restart=on-failure
RestartSec=3
StandardOutput=append:/home/ubuntu/MuxRunner/logs/service.log
StandardError=append:/home/ubuntu/MuxRunner/logs/service.log

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now muxrunner.service
systemctl status muxrunner.service
```

Adjust `User`, `WorkingDirectory`, and the `node` path for your host. Service
output goes to `logs/service.log` (and `journalctl -u muxrunner`).

### Restart the service

```bash
sudo systemctl restart muxrunner.service
systemctl status muxrunner.service   # confirm it's active
```

Or, if you're running it directly (not via systemd):

```bash
# Find and stop the existing process
pkill -f "node server.js"
# Start again
npm start
```

---

## Usage

1. **Compose** — go to the *Compose* tab, name your set (e.g. `deploy-staging`),
   and type one bash command per line. The *Starts in* line shows the absolute
   directory the session will begin in, and the gutter numbers each line (a `↪`
   marks a soft-wrapped continuation row):

   ```
   cd ~/project
   npm ci
   npm run build
   npm test
   ```

2. **Run** — hit *Run command set*. A new tmux session starts and the *Sessions*
   tab opens with a live card that ticks the elapsed run time second by second.

3. **Watch** — click a card (or *Watch*) to open the live drawer: streaming
   output, per-step status, the attach command, a live counter on the currently
   running command, and a *Close session* button. You can also **End** a session
   directly from its card.

4. **On error** — if a command fails, the run pauses. Copy the attach command,
   run it in your terminal, and you'll be dropped into the live shell exactly
   where it stopped to investigate or fix things by hand.

5. **History** — the *History* tab lists every run parsed from its log. Expand a
   run, then expand any command to see its captured output. Errored commands are
   marked in red. Use **Expand all / Collapse all** to sweep through runs, the
   **⧉** button to copy any single command, or **tick commands** and hit
   **→ Edit in Compose** to load that exact subset (in order) back into the
   editor for tweaking and re-running as a new task.

---

## Configuration

Environment variables (all optional):

| Variable             | Default       | Description                              |
| -------------------- | ------------- | ---------------------------------------- |
| `MUXRUNNER_PORT`     | `1369`        | HTTP/WebSocket port                      |
| `MUXRUNNER_HOST`     | `127.0.0.1`   | Bind address                             |
| `MUXRUNNER_LOG_DIR`  | `./logs`      | Where logs + metadata are written        |
| `MUXRUNNER_SESSION_CWD` | _(app's parent dir)_ | Working dir new tmux sessions start in |
| `TELEGRAM_BOT_TOKEN` | _(unset)_     | Bot token; overrides `telegram.config.json` |
| `TELEGRAM_CHAT_ID`   | _(unset)_     | Target chat for push; overrides config file |
| `TELEGRAM_ENABLED`   | `1`           | Set `0` to keep the token but disable Telegram |

See [Telegram notifications](#telegram-notifications) for the full setup.

Example:

```bash
MUXRUNNER_PORT=8080 MUXRUNNER_LOG_DIR=/var/muxrunner/logs npm start
```

### Exposing it remotely (reverse proxy / tunnel)

MuxRunner works behind an HTTPS reverse proxy or tunnel (e.g. **Cloudflare
Tunnel**, nginx, Caddy). The front-end automatically uses `wss://` when the page
is served over HTTPS, so the live WebSocket connects correctly — no config
needed. Just make sure your proxy **forwards WebSocket upgrades** for the `/ws`
path (Cloudflare Tunnel does this by default).

```bash
# example: expose the local instance with a Cloudflare tunnel
cloudflared tunnel --url http://localhost:1369
```

> Security note: MuxRunner runs arbitrary shell commands. When exposing it
> beyond your machine, put authentication in front of it (e.g. Cloudflare
> Access) — it has no built-in auth.

---

## Telegram notifications

MuxRunner can push to a **Telegram bot** so you get notified the moment a
command set changes state — and ask it, from your phone, what's running.

### What you get

**Proactive push** (no polling on your end):

| Event              | Message includes                                              |
| ------------------ | ------------------------------------------------------------ |
| 🚀 **Started**     | set name, command count, `tmux attach …`, run id             |
| ⏸️ **Paused** (error) | name, progress (`done/total`), the failed command + exit code, `tmux attach …` |
| ✅ **Ended** (completed) | name, command count, total wall-clock duration, `tmux attach …` |
| ⏹️ **Closed**      | name, progress at close                                      |

**Tap, don't type.** Every bot message carries an inline **button selector** —
just tap **📡 活动会话 / 🗂️ 历史记录 / ❓ 帮助** instead of typing commands. The
typed commands still work too:

| Command                | Reply                                                      |
| ---------------------- | ---------------------------------------------------------- |
| **📡 活动会话** / `/sessions` (`/status`, `/s`) | every active session: status, `done/total` progress, and its `tmux attach …` |
| **🗂️ 历史记录** / `/all`  | finished runs grouped by outcome — ✅ completed, ⏸️ paused, ⏹️ closed |
| **❓ 帮助** / `/help`     | the command list                                           |

Statuses use clean, distinct glyphs — ⏳ starting · ▶️ running · ⏸️ paused ·
✅ completed · ⏹️ closed — instead of garish red/green dots.

### Setup (where to fill in your Bot API info)

1. **Create a bot:** open Telegram, message [@BotFather](https://t.me/BotFather),
   send `/newbot`, and follow the prompts. It hands you a **token** like
   `123456789:AAE...`.
2. **Drop in your token:** copy the template and fill it in —

   ```bash
   cp telegram.config.example.json telegram.config.json
   # edit telegram.config.json → paste your token into "botToken"
   ```

   `telegram.config.json` is **git-ignored**, so your token stays out of the repo.
3. **Find your chat id (the easy way):** leave `chatId` empty, start MuxRunner,
   then send **any** message to your bot. It replies with your numeric chat id —
   paste that into `telegram.config.json` as `chatId` and restart. (A group or
   channel id like `-1001234567890` works too.)
4. **Restart** MuxRunner. On boot it logs `Telegram: enabled` once configured.

That's it — push notifications start flowing and the bot answers commands. Only
the configured `chatId` is served, so run data isn't exposed to other chats.

> Prefer environment variables? `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
> override the config file (handy for the systemd unit via `Environment=`).
> Set `TELEGRAM_ENABLED=0` to keep the token but pause notifications.

---

## How it works

```
Browser ──HTTP/WebSocket──► Express server ──► tmux CLI
   ▲                              │
   │  live output (WS)            │  pipe-pane ──► logs/<name>_<ts>.log
   └──────────────────────────────┘
```

1. On **run**, the server generates a bash *runner script* and writes it to
   `logs/.runners/<id>.sh`. Each user command is embedded **literally** and
   wrapped with sentinel markers (`[MUXRUNNER:START:n]` / `…:END:n:rc=…]`) plus a
   guard so that once a command fails, the rest are skipped.
2. It creates a detached tmux session (`bash -i`), attaches `pipe-pane` to stream
   **all** pane output into the log file, then `source`s the runner script in the
   live shell — so `cd`/env changes persist and you land in the same state on
   error.
3. The server **tails the log file**, parses the markers to track per-command
   status and exit codes, and broadcasts updates + raw output to the browser over
   WebSocket.
4. The sentinel markers double as **log segmentation**, so the History view can
   reconstruct each command's output and exit code straight from the saved log.

This design means MuxRunner is just an orchestrator — the source of truth is the
tmux session and its log file. If the server restarts, history is reloaded from
the `logs/` folder and still-alive sessions are re-adopted.

### Why markers instead of `send-keys` polling?

Embedding markers in a single sourced script gives reliable exit-code capture and
clean per-command boundaries without fragile prompt-scraping, while keeping the
session a normal interactive shell you can attach to at any time.

---

## Project layout

```
MuxRunner/
├── server.js            # HTTP + WebSocket server, REST API
├── lib/
│   ├── config.js        # ports, paths, env config
│   ├── util.js          # ANSI stripping, slugs, timestamps
│   ├── markers.js       # sentinel marker format (shared)
│   ├── script.js        # generates the bash runner script
│   ├── tmux.js          # thin tmux CLI wrapper
│   ├── telegram.js      # Telegram push + bot-command poller
│   └── store.js         # run lifecycle, log tailing, persistence
├── public/              # static front-end (no build step)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── telegram.config.example.json  # copy → telegram.config.json, fill in token
├── logs/                # created at runtime (git-ignored)
│   ├── <name>_<ts>.log  # full tmux record
│   ├── <id>.json        # structured run metadata
│   └── .runners/        # generated runner scripts
└── package.json
```

---

## REST API

| Method | Endpoint                | Purpose                          |
| ------ | ----------------------- | -------------------------------- |
| `GET`  | `/api/runs`             | List all runs (summaries)        |
| `POST` | `/api/runs`             | Create + start a run             |
| `GET`  | `/api/runs/:id`         | Full run metadata + per-command  |
| `GET`  | `/api/runs/:id/live`    | Current pane snapshot            |
| `GET`  | `/api/runs/:id/log`     | Raw log file (text)              |
| `POST` | `/api/runs/:id/close`   | Kill the tmux session            |

WebSocket at `/ws` pushes `snapshot`, `run:update`, and `run:output` messages.

---

## Notes & limitations

- Commands run under `bash -i`; interactive full-screen programs (vim, htop) will
  "work" but are best handled by attaching to the session directly.
- Auto-resume after fixing a paused run is **not** automated by design — you take
  over the live shell and decide what to do. Re-running the set starts a fresh
  session.
- A command that blocks on stdin will simply show as *running*; attach to
  interact with it.

---

## License

[MIT](LICENSE)
