# Orion Script Lib

个人常用脚本集合，当前包含 macOS Homebrew 升级维护、TeleBox 部署管理，以及基于 Cloudflare Worker 的 Telegram Bot 工具。

> 这些脚本大多会安装依赖、改动服务进程或访问第三方 API。运行前请先通读对应脚本，并确认变量、路径、账号信息已经按自己的环境修改。

## 目录结构

```text
.
├── Cloudflare/
│   ├── gitea-raw-bot/
│   │   ├── README.md
│   │   └── src/
│   ├── lskypro-bot/
│   │   ├── README.md
│   │   └── lskypro-telegram-worker.js
│   └── tg-bot/
│       ├── README.md
│       └── worker.js
├── Homebrew/
│   ├── README.md
│   └── brew-upgrade-manager.sh
└── Telebox/
    ├── README.md
    ├── installTeleBox.sh
    ├── telebox.sh
    └── telebox-docker.sh
```

## 脚本说明

| 路径 | 用途 | 适用环境 |
| --- | --- | --- |
| `Homebrew/brew-upgrade-manager.sh` | 更新 Homebrew、执行 `brew doctor`、升级 Formulae 和 Casks、清理旧缓存 | macOS |
| `Telebox/installTeleBox.sh` | TeleBox 一键全新安装脚本，清理旧 TeleBox 后使用 PM2 托管运行 | Debian / Ubuntu |
| `Telebox/telebox.sh` | TeleBox 生产级部署脚本，包含依赖检查、部署、登录、PM2 守护和开机自启 | Debian / Ubuntu |
| `Telebox/telebox-docker.sh` | TeleBox Docker Compose 菜单式管理脚本，支持安装、卸载、启停、重装、日志、备份、恢复 | Linux + Docker |
| `Cloudflare/tg-bot/worker.js` | Telegram 双向客服 Bot 的 Cloudflare Worker 代码，使用 D1 存储配置、用户和消息状态 | Cloudflare Workers |
| `Cloudflare/lskypro-bot/lskypro-telegram-worker.js` | Telegram 图片上传 Bot 的 Cloudflare Worker 代码，把图片上传到 Lsky Pro 并返回 Markdown 链接 | Cloudflare Workers |
| `Cloudflare/gitea-raw-bot/src/index.js` | Gitea Raw 代理与 Telegram 链接转换，通过 Shlink 返回短链 | Cloudflare Workers |

各目录的详细说明：

- `Homebrew/README.md`
- `Telebox/README.md`
- `Cloudflare/gitea-raw-bot/README.md`
- `Cloudflare/tg-bot/README.md`
- `Cloudflare/lskypro-bot/README.md`

## 快速使用

### Homebrew 升级脚本

```bash
chmod +x Homebrew/brew-upgrade-manager.sh
./Homebrew/brew-upgrade-manager.sh
```

如果终端宽度识别异常，可以手动指定宽度：

```bash
./Homebrew/brew-upgrade-manager.sh --width 130
```

注意：

- 脚本会安装或使用 `buo/cask-upgrade`，并执行 `brew cu -yaq` 升级 GUI 应用。
- 脚本内存在 `SUDO_PWD` 变量占位。不要把真实密码提交到公开仓库；更建议本地临时填写、运行后清空，或改造为运行时输入。

### TeleBox 直接部署

推荐使用生产级脚本：

```bash
chmod +x Telebox/telebox.sh
./Telebox/telebox.sh
```

脚本会执行：

- 清理旧 TeleBox 服务和目录。
- 安装 `curl`、`git`、`build-essential`、Node.js 20。
- 克隆 `https://github.com/TeleBoxDev/TeleBox.git` 到 `$HOME/telebox`。
- 引导 Telegram 首次登录。
- 使用 PM2 启动并配置开机自启。

安装完成后常用命令：

```bash
pm2 status telebox
pm2 logs telebox
pm2 restart telebox
pm2 stop telebox
```

### TeleBox Docker 部署

```bash
chmod +x Telebox/telebox-docker.sh
sudo ./Telebox/telebox-docker.sh
```

脚本会进入交互式菜单，支持：

- 安装、卸载、关闭、启动、重启、重装 TeleBox。
- 查看日志、进入容器、查看容器信息。
- 备份和恢复 TeleBox 数据。

数据默认保存在：

```text
/root/Docker_Telebox/<容器名称>
```

### Cloudflare Telegram Bot

Worker 代码位于：

```text
Cloudflare/tg-bot/worker.js
```

更完整的部署说明见：

```text
Cloudflare/tg-bot/README.md
```

核心依赖：

- Cloudflare Workers
- Cloudflare D1 数据库，绑定名必须为 `TG_BOT_DB`
- Telegram Bot Token
- 开启话题功能的 Telegram 超级群组
- Cloudflare Turnstile 或 Google reCAPTCHA，可按配置开启或关闭

主要环境变量：

| 变量名 | 说明 |
| --- | --- |
| `BOT_TOKEN` | Telegram Bot Token |
| `ADMIN_IDS` | 管理员 Telegram ID，多个 ID 用英文逗号分隔 |
| `ADMIN_GROUP_ID` | 管理群组 ID，需要是开启话题的超级群组 |
| `WORKER_URL` | Worker 完整访问地址，不带末尾斜杠 |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile 站点密钥 |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile 密钥 |
| `RECAPTCHA_SITE_KEY` | Google reCAPTCHA v2 站点密钥 |
| `RECAPTCHA_SECRET_KEY` | Google reCAPTCHA v2 密钥 |

### Cloudflare Lsky Pro Telegram Bot

Worker 代码位于：

```text
Cloudflare/lskypro-bot/lskypro-telegram-worker.js
```

更完整的部署说明见：

```text
Cloudflare/lskypro-bot/README.md
```

核心依赖：

- Cloudflare Workers
- Cloudflare D1 数据库，绑定名必须为 `DB`
- Telegram Bot Token
- Lsky Pro API Token

主要环境变量：

| 变量名 | 说明 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram Webhook secret token |
| `ALLOWED_TELEGRAM_USER_IDS` | 允许使用 Bot 的 Telegram user id，多个 ID 用英文逗号分隔 |
| `LSKY_API_URL` | Lsky Pro 上传接口地址 |
| `LSKY_TOKEN` | Lsky Pro API Token |
| `LSKY_PERMISSION` | Lsky Pro 图片权限，可选 |
| `LSKY_STRATEGY_ID` | Lsky Pro 存储策略 ID，可选 |
| `MAX_FILE_MB` | 单文件大小上限，默认 `500` |
| `MAX_UPLOAD_QUEUE_IMAGES` | 单个相册最多排队图片数量，默认 `500` |
| `ALBUM_WAIT_SECONDS` | 相册收集等待时间，默认 `5` |

## 安全提示

- 运行脚本前先检查目标路径，尤其是包含清理、重装、卸载逻辑的 TeleBox 脚本。
- 不要把 Bot Token、API Hash、管理员 ID、密码等敏感信息提交到公开仓库。
- Docker 脚本需要 root 权限，并会创建或删除容器与 `/root/Docker_Telebox` 下的数据目录。
- Cloudflare Worker 部署后，请通过 Telegram `setWebhook` 绑定自己的 Worker 地址。
- Lsky Pro 上传 Bot 部署后，请先访问 `/init?secret=<TELEGRAM_WEBHOOK_SECRET>` 初始化 D1 表。

## 维护建议

- 每次修改脚本后，先用 `bash -n <script>` 做语法检查。
- 涉及服务器安装的脚本，建议先在测试 VPS 或临时容器中跑一遍。
- 如果新增脚本，请同步更新本 README 的目录结构和脚本说明表。
