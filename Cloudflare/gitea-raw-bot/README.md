# Gitea Raw Bot

Cloudflare Worker：代理 Gitea Raw 文件，Telegram 私聊发送文件链接后，通过 Shlink 返回短链，并引用原消息回复。无需 D1、KV 或 R2。

## 使用方式

发送以下任一链接给 Bot，每条消息一个链接：

```text
https://git.example.com/owner/repository/src/branch/main/config.yaml
https://git.example.com/owner/repository/src/branch/feature/foo/config.yaml
https://git.example.com/owner/repository/raw/branch/main/config.yaml
https://git.example.com/owner/repository/src/tag/v1.0/config.yaml
https://git.example.com/owner/repository/src/commit/abc1234/config.yaml
https://raw.example.com/repository/config.yaml
https://raw.example.com/repository/config.yaml?ref=feature%2Ffoo
```

Bot 使用去掉最后一个扩展名的文件名作为短码，例如 `Clash.yaml` → `https://go.example.com/Clash`；大小写保留，空格转为连字符。相同目标复用已有文件名短链；原随机短链继续有效。

名称被其他目标占用时，Bot 提示冲突，不覆盖、不自动加序号。可发送 `/short MyClash 链接` 指定新名称；之后单独发送该文件的 Gitea 或 Raw 链接也会返回已指定的短链。名称支持 1–128 个中英文、数字、点、下划线或连字符，不能是 `.` 或 `..`。

文件名短链使用 `gitea-raw` 和 `gitea-raw-named` 标签记录在 Shlink 中。Bot 先查询同目标的文件名短链，再使用 `customSlug` 与 `findIfExists` 创建或复用；不会删除或覆盖旧短链。

Gitea 原链接与对应的 Cloudflare Raw 代理链接会使用相同目标，复用已有短链；没有记录时才创建。代理链接保留 `ref`，默认分支的显式 `ref` 会省略，输入中的 Token、其他查询参数和片段不沿用；私库统一使用配置中的 TOKEN。

- 默认分支：`https://raw.example.com/repository/config.yaml`。
- 其他分支：`https://raw.example.com/repository/config.yaml?ref=feature%2Ffoo`。
- 标签：`?ref=refs%2Ftags%2Fv1.0`，避免与同名分支混淆。
- 提交：`?ref=abc1234`。

默认分支链接跟随仓库当前默认分支；其他分支链接跟随该分支最新内容。需要固定文件版本时发送提交链接。

## 通过 Cloudflare Git 自动部署

1. 将本项目提交到你自己的 Git 仓库。
2. Cloudflare Dashboard → Workers & Pages → 创建 Worker → 导入仓库（Workers Builds，非 Pages）。
3. 设置：

   | 配置 | 值 |
   | --- | --- |
   | 项目根目录 / Root directory | `Cloudflare/gitea-raw-bot` |
   | Worker 名称 | `gitea-raw-bot`，与 `wrangler.toml` 一致 |
   | 构建命令 | 留空；依赖由平台安装 |
   | 部署命令 | `npm run deploy` |
   | Node.js | 22.13 或更高，推荐 22 LTS |

4. 首次部署后，在 **Worker 运行时设置 → Variables and Secrets** 配置下表内容。构建环境变量不能代替 Worker 运行时变量。
5. 绑定自定义域名（可选），将 `RAW_BASE_URL` 设置为最终访问域名；也可使用 `https://gitea-raw-bot.<账号>.workers.dev`。
6. 保存配置并重新部署，注册 Telegram Webhook。之后向连接的生产分支提交代码即可自动部署。

`keep_vars = true` 保留 Dashboard 设置的普通变量；Secret 由 Cloudflare 独立保存。配置文件不包含真实域名、账号或凭据。

### 普通变量

| 名称 | 示例 / 说明 |
| --- | --- |
| `GITEA_URL` | `https://git.example.com`，支持 `/gitea` 等安装子路径 |
| `GITEA_OWNER` | 仓库所有者，只暴露一个用户或组织 |
| `ALLOWED_REPOSITORIES` | JSON 数组，例如 `["configs","scripts"]`，精确匹配 |
| `RAW_BASE_URL` | `https://raw.example.com`，不带路径或查询参数，必须指向这个 Worker |
| `ALLOWED_TELEGRAM_USER_IDS` | `123456789,987654321`，Telegram 数字用户 ID，非用户名 |
| `SHLINK_API_URL` | `https://go.example.com`，Shlink 根地址，支持安装子路径 |

### Secrets

| 名称 | 说明 |
| --- | --- |
| `TOKEN` | **原 Raw Worker 的访问 Token**；私库访问必需 |
| `GITEA_TOKEN` | Gitea 仅读取仓库的 Token；代理私库必需，公开仓库不使用 |
| `TELEGRAM_BOT_TOKEN` | BotFather 生成的 Bot Token |
| `TELEGRAM_WEBHOOK_SECRET` | 自行生成，1～256 位字母、数字、下划线或连字符 |
| `SHLINK_API_KEY` | Shlink API Key，需有创建短链权限 |

所有服务地址均要求 HTTPS。对上游请求禁止跟随重定向，避免凭据被转发；请填写最终地址。Gitea 使用支持 Raw API `ref` 参数与 branches/tags API 的版本；已按当前 Gitea API 核对，旧版本请先验证。

### 注册 Telegram Webhook

在本地终端设置环境变量后执行（命令不会把值直接写入命令历史）：

```bash
export RAW_BASE_URL='https://raw.example.com'
read -rs TELEGRAM_BOT_TOKEN
read -rs TELEGRAM_WEBHOOK_SECRET
export TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
python3 - <<'PY'
import json, os, urllib.request
url = 'https://api.telegram.org/bot' + os.environ['TELEGRAM_BOT_TOKEN'] + '/setWebhook'
data = json.dumps({
    'url': os.environ['RAW_BASE_URL'].rstrip('/') + '/webhook',
    'secret_token': os.environ['TELEGRAM_WEBHOOK_SECRET'],
    'allowed_updates': ['message'],
}).encode()
try:
    request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
    print('Webhook registered' if result.get('ok') else 'Webhook registration failed')
except Exception:
    raise SystemExit('Webhook registration failed; check configuration and network')
PY
```

两个 `read` 提示处依次粘贴 Bot Token 和 Webhook secret 并回车；输入不回显。只需首次部署、修改域名或更换 secret 后重新注册。生产 Worker 与预览 Worker 应使用不同 Bot，避免覆盖同一个 Webhook。

访问根路径返回 `Gitea Raw Bot OK` 仅代表 Worker 可达。再用白名单账号私聊 Bot，发送 `/start` 和一个文件地址完成真实联调。

## 私库访问：沿用 Raw TOKEN

**私库短链自动携带配置中的 Raw TOKEN，无需手动追加参数。** Bot 将 `token` 写入 Shlink 保存的 Raw 目标地址，回复保持为简洁短链；分支、标签和提交信息仍保留。公开仓库目标不附加 Token，输入链接中的查询参数不会被沿用。

已有不带 Token 的旧短链不会自动修改，请重新发送文件链接生成可直接访问的短链。更换 TOKEN 后也需重新生成私库短链。

也可以直接访问 Raw，使用 `Authorization: Bearer <TOKEN>`。注意多数 HTTP 客户端跨域跳转时会移除 Authorization；使用请求头鉴权时，先取得 Shlink 的 `Location`，确认它属于自己的 Raw 域名，再向该 Raw 地址发送 Bearer 请求。不要为方便跳转而向任意域名转发凭据。

私库短链包含访问权限，只分享给有权访问的人；目标中的 Token 会保存在 Shlink 中，也可能进入浏览器历史和代理日志。项目关闭 Worker 自动 invocation 日志，并且不自行记录完整 URL 或凭据。

## 路由与缓存

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/` | GET / HEAD | 健康检查 |
| `/webhook` | POST | 校验 Webhook secret，仅处理白名单用户私聊 |
| `/{repository}/{path}` | GET / HEAD / OPTIONS | Raw 代理；可选 `ref`、`token` 参数 |

- 每次 Raw 请求先匿名查询仓库信息，仅匿名无法访问时才尝试 Gitea Token。
- 公共文件缓存 60 秒，按上游实例、所有者、仓库、完整文件路径与 ref 隔离。
- 每次命中公共缓存前重新检查仓库访问权限；私库不使用公共缓存，返回 `private, no-store`。
- Range 请求透传并绕过缓存；HEAD 不返回正文。不会转发客户端 Authorization 给 Gitea。
- 默认公开 CORS，私库仍受 Token 保护。
- 同一个 TOKEN 可访问白名单内全部私库，不提供每个文件独立权限。

## 本地开发与验证

```bash
cd Cloudflare/gitea-raw-bot
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 后启动
npm run dev
```

`.dev.vars`、`.wrangler/` 已忽略，不要把真实凭据提交到仓库。

```bash
npm test
npm run test:integration
npm run test:coverage
npm run check
```

单元测试与集成测试使用 Node.js 22.13+。集成测试执行实际 Worker 入口及转换流程，模拟外部 Gitea、Telegram、Shlink 与 Cache API，不会向真实 Telegram 发送消息。覆盖率门槛：行 85%、函数 90%、分支 75%。`check` 运行 Wrangler dry-run，仅验证配置与打包，不发布。

真实环境仍需验证 Gitea Token 权限、带斜杠分支解析、Shlink 参数转发和 Telegram Webhook。

## 使用边界

每条消息只接受一个完整链接；不上传文件，不创建仓库，不展开任意第三方短链。带斜杠分支按最长存在的分支名解析，最多探测 20 段；过深路径请改用提交链接。

Webhook 同步等待外部服务和 Telegram 回复；单次外部请求超时 15 秒，没有持久队列或跨重试去重。转换或短链生成失败时，Bot 提示错误并确认消息，需要用户重发；Telegram 回复发送失败才返回非 2xx。异常重试可能产生重复回复，慢服务或多次分支探测可能触发 Telegram 重试。需要更高并发或严格去重时再增加持久队列。Shlink 创建失败会提示错误，不返回伪造短链。

Gitea Raw API 返回 Git blob 内容，Git LFS 文件可能是指针文件。本项目未增加 LFS 下载流程。
