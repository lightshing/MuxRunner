# ⚡ MuxRunner

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
  light, polished (non-terminal-looking) UI.
- 🖥️ **Each set runs in its own tmux session** — run many concurrently.
- ▶️ **Strict sequential execution** — line _N+1_ starts only after line _N_
  finishes.
- ⏸️ **Auto-pause on error** — the first non-zero exit halts the rest and marks
  the run as *paused*; remaining commands are flagged *skipped*.
- 🔌 **Attach & take over** — every card shows a copy-paste `tmux attach …`
  command. On error, you land at an interactive prompt **in the same shell
  state** (cwd/env preserved).
- 📡 **Live output** — watch a running session stream in real time over
  WebSocket, or copy the attach command and use your own terminal.
- ♻️ **Sessions are retained** after finishing (success *or* error). Close them
  with one click when you're done.
- 🗂️ **Persistent logs** — the full tmux record is saved to
  `./logs/<name>_<timestamp>.log`, with a structured `.json` sidecar.
- 🕗 **History browser** — parse any past run, expand each command to see its
  output, with errored commands highlighted.

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
> Run MuxRunner from wherever you want your logs (and your commands' default
> working directory) to live.

---

## Usage

1. **Compose** — go to the *Compose* tab, name your set (e.g. `deploy-staging`),
   and type one bash command per line:

   ```
   cd ~/project
   npm ci
   npm run build
   npm test
   ```

2. **Run** — hit *Run command set*. A new tmux session starts and the *Sessions*
   tab opens with a live card.

3. **Watch** — click a card (or *Watch*) to open the live drawer: streaming
   output, per-step status, the attach command, and a *Close session* button.

4. **On error** — if a command fails, the run pauses. Copy the attach command,
   run it in your terminal, and you'll be dropped into the live shell exactly
   where it stopped to investigate or fix things by hand.

5. **History** — the *History* tab lists every run parsed from its log. Expand a
   run, then expand any command to see its captured output. Errored commands are
   marked in red.

---

## Configuration

Environment variables (all optional):

| Variable             | Default       | Description                              |
| -------------------- | ------------- | ---------------------------------------- |
| `MUXRUNNER_PORT`     | `1369`        | HTTP/WebSocket port                      |
| `MUXRUNNER_HOST`     | `127.0.0.1`   | Bind address                             |
| `MUXRUNNER_LOG_DIR`  | `./logs`      | Where logs + metadata are written        |

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
│   └── store.js         # run lifecycle, log tailing, persistence
├── public/              # static front-end (no build step)
│   ├── index.html
│   ├── styles.css
│   └── app.js
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

MIT
