# ⚡ MuxRunner

[English](README.md) · **简体中文**

一款现代化的、基于 Web 的**命令运行器**，它在 **tmux** 会话中顺序执行已命名的
命令集——支持实时输出、出错自动暂停，以及完全持久化的日志。

在简洁的 Web 界面里编排一组 bash 命令，为这组命令起个名字，然后点击运行。
MuxRunner 会启动一个全新的 tmux 会话，逐行执行你的命令。如果某条命令以非零状态
退出，执行会**就地暂停**——会话保持存活，你可以 `tmux attach` 接管现场。每个会话
都会被记录到带时间戳的日志文件中，你可以浏览、逐条命令展开，并在之后排查错误。

---

## 功能特性

- 🧩 **编排并命名命令集**——每行一条 bash 命令，界面简洁、明亮、精致（不像传统
  终端）。编辑器带**行号**显示（软换行的续行用 `↪` 标记，便于区分是自动换行还是真正
  的换行），并且 Compose 页面会展示新建 tmux 会话**起始的绝对工作目录**。
- 🖥️ **每个命令集运行在各自的 tmux 会话中**——可同时并发运行多组。
- ▶️ **严格顺序执行**——只有第 _N_ 行执行完毕，第 _N+1_ 行才会开始。
- ⏸️ **出错自动暂停**——第一条非零退出的命令会中止后续执行，并将本次运行标记为
  *已暂停*；剩余命令被标记为*已跳过*。
- 🔌 **接管现场**——每张卡片都会显示一条可复制粘贴的 `tmux attach …` 命令。出错
  时，你会落在一个交互式提示符上，**且处于完全相同的 shell 状态**（cwd/env 都被
  保留）。
- 📡 **实时输出，实时解析**——在抽屉面板里观察运行中的会话：每条命令都是一个可
  展开的独立区块，其输出随执行实时流式刷新（并显示到目前为止已捕获的全部内容），
  另外还有原始全量流视图。或者复制 attach 命令，用你自己的终端查看。
- ♻️ **会话会被保留**——无论成功还是出错，运行结束后会话都会保留。完成后一键
  关闭即可。
- 🗂️ **持久化日志**——完整的 tmux 记录会被保存到
  `./logs/<name>_<timestamp>.log`，并附带一个结构化的 `.json` 旁挂文件。
- ⏱️ **挂钟计时**——每条命令的运行时长由 shell 精确测量（bash 微秒级时钟），
  并给出整组命令的总耗时。会话卡片、实时抽屉（每条命令 + 总计）以及历史记录中
  都会显示。
- 🕗 **历史浏览器**——可解析任意一次过往运行，展开每条命令查看其输出，出错命令
  会被高亮标红。支持**全部展开/全部折叠**、**复制任意单条命令**，以及**勾选一部分
  命令、按顺序重新发送到“编排”界面**——编辑后再发起一次全新运行。
- 🤖 **Telegram 机器人**——当命令集**开始**、**因错误暂停**或**结束**时，第一时间
  收到推送——每条消息都带有命令集名称、命令数量、进度以及可复制粘贴的
  `tmux attach …` 命令。在手机上回复机器人 `/sessions`，即可查看正在运行的会话、
  每个会话的进度及其 attach 命令。详见
  [Telegram 通知](#telegram-通知)。

---

## 环境要求

MuxRunner 刻意做到**依赖精简、无需 Docker**，以便于移植。你需要：

| 工具    | 版本       | 说明                                    |
| ------- | ---------- | --------------------------------------- |
| Node.js | ≥ 18       | 使用 ES 模块                            |
| tmux    | ≥ 3.0      | 执行引擎                                |
| bash    | 任意现代版 | 命令运行在 `bash -i` 之下              |

支持 Linux 与 macOS。（Windows：请使用 WSL。）

---

## 快速开始

```bash
git clone <your-repo-url> MuxRunner
cd MuxRunner
npm install
npm start
```

然后打开 **http://localhost:1369**。

> 日志会写入**你启动程序所在目录**下的 `logs/` 文件夹。你想让日志存在哪里，就从
> 哪里启动 MuxRunner。
>
> 你的命令默认运行在一个 tmux 会话中，该会话**起始于应用目录的父目录**（例如当
> MuxRunner 位于 `/home/ubuntu/MuxRunner` 时为 `/home/ubuntu`）——这样命令就从你的
> home 目录运行，而不是在工具自身的代码目录里。可用 `MUXRUNNER_SESSION_CWD`
> 覆盖（绝对路径，或相对于启动目录的路径）。

### 作为服务运行（开机自启）

在使用 systemd 的主机上，你可以让 MuxRunner 在重启后依然运行。安装
`/etc/systemd/system/muxrunner.service`：

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

然后启用并启动它：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now muxrunner.service
systemctl status muxrunner.service
```

请根据你的主机调整 `User`、`WorkingDirectory` 以及 `node` 的路径。服务输出会写入
`logs/service.log`（也可通过 `journalctl -u muxrunner` 查看）。

### 重启服务

```bash
sudo systemctl restart muxrunner.service
systemctl status muxrunner.service   # 确认已处于 active 状态
```

或者，如果你是直接运行的（未通过 systemd）：

```bash
# 找到并停止现有进程
pkill -f "node server.js"
# 重新启动
npm start
```

---

## 使用方法

1. **编排**——进入 *Compose* 标签页，给命令集起个名字（例如 `deploy-staging`），
   然后每行输入一条 bash 命令。*Starts in* 一行会显示会话起始的绝对目录，左侧行号栏
   会为每一行编号（软换行的续行以 `↪` 标记）：

   ```
   cd ~/project
   npm ci
   npm run build
   npm test
   ```

2. **运行**——点击 *Run command set*。一个新的 tmux 会话会启动，并打开 *Sessions*
   标签页，显示一张实时卡片。

3. **观察**——点击卡片（或 *Watch*）打开实时抽屉：流式输出、每一步的状态、attach
   命令，以及一个 *Close session* 按钮。

4. **出错时**——如果某条命令失败，运行会暂停。复制 attach 命令，在你的终端里运行
   它，你就会被精确地放回到停下来的那个实时 shell 中，手动排查或修复。

5. **历史**——*History* 标签页会列出每一次运行（从其日志解析得到）。展开一次运行，
   再展开任意命令以查看其捕获的输出。出错命令会标红。使用**全部展开 / 全部折叠**
   快速浏览各次运行，用 **⧉** 按钮复制任意单条命令，或**勾选命令**后点击
   **→ Edit in Compose**，将那一部分命令（按顺序）加载回编辑器，进行调整并作为
   一次新任务重新运行。

---

## 配置

环境变量（均为可选）：

| 变量                 | 默认值        | 说明                                     |
| -------------------- | ------------- | ---------------------------------------- |
| `MUXRUNNER_PORT`     | `1369`        | HTTP/WebSocket 端口                      |
| `MUXRUNNER_HOST`     | `127.0.0.1`   | 绑定地址                                 |
| `MUXRUNNER_LOG_DIR`  | `./logs`      | 日志与元数据的写入位置                   |
| `MUXRUNNER_SESSION_CWD` | _(应用父目录)_ | tmux 会话的起始工作目录              |
| `TELEGRAM_BOT_TOKEN` | _(未设置)_    | 机器人 token；覆盖 `telegram.config.json` |
| `TELEGRAM_CHAT_ID`   | _(未设置)_    | 推送的目标聊天；覆盖配置文件             |
| `TELEGRAM_ENABLED`   | `1`           | 设为 `0` 可保留 token 但禁用 Telegram    |

完整设置请参见 [Telegram 通知](#telegram-通知)。

示例：

```bash
MUXRUNNER_PORT=8080 MUXRUNNER_LOG_DIR=/var/muxrunner/logs npm start
```

### 远程暴露（反向代理 / 隧道）

MuxRunner 可在 HTTPS 反向代理或隧道（例如 **Cloudflare Tunnel**、nginx、Caddy）
之后工作。当页面经由 HTTPS 提供时，前端会自动使用 `wss://`，因此实时 WebSocket
能正确连接——无需任何配置。只需确保你的代理为 `/ws` 路径**转发 WebSocket 升级
请求**即可（Cloudflare Tunnel 默认就会这样做）。

```bash
# 示例：用 Cloudflare 隧道暴露本地实例
cloudflared tunnel --url http://localhost:1369
```

> 安全提示：MuxRunner 会运行任意 shell 命令。当你把它暴露到本机之外时，请在它前面
> 加上认证（例如 Cloudflare Access）——它本身没有内置认证。

---

## Telegram 通知

MuxRunner 可以推送到 **Telegram 机器人**，让你在命令集状态变化的第一时间收到通知——
并且可以从手机上询问它当前正在运行什么。

### 你能获得什么

**主动推送**（你这边无需轮询）：

| 事件                  | 消息包含的内容                                                |
| --------------------- | ------------------------------------------------------------ |
| 🚀 **已开始**         | 命令集名称、命令数量、`tmux attach …`、运行 id               |
| ⏸️ **已暂停**（出错） | 名称、进度（`done/total`）、失败的命令 + 退出码、`tmux attach …` |
| ✅ **已结束**（完成） | 名称、命令数量、总挂钟时长、`tmux attach …`                  |
| ⏹️ **已关闭**         | 名称、关闭时的进度                                            |

**点按即可，无需输入。** 每条机器人消息都带有内联**按钮选择器**——直接点按
**📡 活动会话 / 🗂️ 历史记录 / ❓ 帮助**，无需手动输入命令。手动输入的命令依然有效：

| 命令                   | 回复                                                       |
| ---------------------- | ---------------------------------------------------------- |
| **📡 活动会话** / `/sessions`（`/status`、`/s`） | 每个活动会话：状态、`done/total` 进度，及其 `tmux attach …` |
| **🗂️ 历史记录** / `/all`  | 已完成的运行，按结果分组——✅ 已完成、⏸️ 已暂停、⏹️ 已关闭 |
| **❓ 帮助** / `/help`     | 命令列表                                                   |

状态使用清晰、易区分的字形——⏳ 启动中 · ▶️ 运行中 · ⏸️ 已暂停 ·
✅ 已完成 · ⏹️ 已关闭——而非刺眼的红/绿圆点。

### 设置（在哪里填入你的 Bot API 信息）

1. **创建机器人：** 打开 Telegram，给 [@BotFather](https://t.me/BotFather) 发消息，
   发送 `/newbot`，按提示操作。它会给你一个形如 `123456789:AAE...` 的 **token**。
2. **填入你的 token：** 复制模板并填写——

   ```bash
   cp telegram.config.example.json telegram.config.json
   # 编辑 telegram.config.json → 把你的 token 粘贴到 "botToken"
   ```

   `telegram.config.json` 已被 **git 忽略**，因此你的 token 不会进入仓库。
3. **获取你的 chat id（最简单的方法）：** 先把 `chatId` 留空，启动 MuxRunner，
   然后给你的机器人发**任意**一条消息。它会回复你的数字 chat id——把它粘贴到
   `telegram.config.json` 的 `chatId` 中并重启。（群组或频道 id，例如
   `-1001234567890`，同样可用。）
4. **重启** MuxRunner。配置完成后，它在启动时会打印一次 `Telegram: enabled`。

就这样——推送通知会开始送达，机器人也会响应命令。只有配置的 `chatId` 会被服务，
因此运行数据不会暴露给其他聊天。

> 更喜欢用环境变量？`TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 会覆盖配置文件
> （便于通过 `Environment=` 用于 systemd 单元）。设置 `TELEGRAM_ENABLED=0` 可保留
> token 但暂停通知。

---

## 工作原理

```
浏览器 ──HTTP/WebSocket──► Express 服务器 ──► tmux CLI
   ▲                              │
   │  实时输出 (WS)               │  pipe-pane ──► logs/<name>_<ts>.log
   └──────────────────────────────┘
```

1. 在**运行**时，服务器生成一个 bash *运行脚本*，写入
   `logs/.runners/<id>.sh`。每条用户命令都被**原样**嵌入，并用哨兵标记
   （`[MUXRUNNER:START:n]` / `…:END:n:rc=…]`）包裹，外加一个守卫，确保一旦某条
   命令失败，后续命令都会被跳过。
2. 它创建一个分离（detached）的 tmux 会话（`bash -i`），挂上 `pipe-pane` 把**全部**
   pane 输出流式写入日志文件，然后在这个实时 shell 中 `source` 该运行脚本——这样
   `cd`/env 的更改得以保留，出错时你也会落在完全相同的状态中。
3. 服务器**追踪（tail）日志文件**，解析标记以跟踪每条命令的状态与退出码，并通过
   WebSocket 把更新及原始输出广播到浏览器。
4. 这些哨兵标记同时充当**日志分段**，因此历史视图可以直接从已保存的日志中重建出
   每条命令的输出与退出码。

这种设计意味着 MuxRunner 只是一个编排器——真相之源是 tmux 会话及其日志文件。
如果服务器重启，历史会从 `logs/` 文件夹重新加载，仍然存活的会话会被重新接管。

### 为什么用标记而不是 `send-keys` 轮询？

把标记嵌入到单个被 source 的脚本中，可以在不依赖脆弱的提示符抓取的前提下，可靠地
捕获退出码并获得干净的逐命令边界，同时让会话保持为一个普通的交互式 shell，你随时
都能 attach 进去。

---

## 项目结构

```
MuxRunner/
├── server.js            # HTTP + WebSocket 服务器，REST API
├── lib/
│   ├── config.js        # 端口、路径、环境配置
│   ├── util.js          # ANSI 清理、slug、时间戳
│   ├── markers.js       # 哨兵标记格式（共享）
│   ├── script.js        # 生成 bash 运行脚本
│   ├── tmux.js          # tmux CLI 的轻量封装
│   ├── telegram.js      # Telegram 推送 + 机器人命令轮询器
│   └── store.js         # 运行生命周期、日志追踪、持久化
├── public/              # 静态前端（无构建步骤）
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── telegram.config.example.json  # 复制为 telegram.config.json 并填入 token
├── logs/                # 运行时创建（git 忽略）
│   ├── <name>_<ts>.log  # 完整 tmux 记录
│   ├── <id>.json        # 结构化运行元数据
│   └── .runners/        # 生成的运行脚本
└── package.json
```

---

## REST API

| 方法   | 端点                    | 用途                             |
| ------ | ----------------------- | -------------------------------- |
| `GET`  | `/api/runs`             | 列出所有运行（摘要）             |
| `POST` | `/api/runs`             | 创建并启动一次运行               |
| `GET`  | `/api/runs/:id`         | 完整运行元数据 + 每条命令        |
| `GET`  | `/api/runs/:id/live`    | 当前 pane 快照                   |
| `GET`  | `/api/runs/:id/log`     | 原始日志文件（文本）             |
| `POST` | `/api/runs/:id/close`   | 杀掉该 tmux 会话                 |

`/ws` 处的 WebSocket 会推送 `snapshot`、`run:update` 和 `run:output` 消息。

---

## 说明与限制

- 命令运行在 `bash -i` 之下；交互式全屏程序（vim、htop）虽然“能用”，但最好直接
  attach 到会话中处理。
- 出于设计考虑，修复一个已暂停的运行后**不会**自动续跑——你接管实时 shell 并自行
  决定怎么做。重新运行该命令集会启动一个全新的会话。
- 一条阻塞在 stdin 上的命令只会显示为 *running*；attach 进去与它交互即可。

---

## 许可证

[MIT](LICENSE)
