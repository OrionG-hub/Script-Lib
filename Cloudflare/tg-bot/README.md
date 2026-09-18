yi'xia# Telegram Bot Worker

`tg-bot.js` 是一个部署在 Cloudflare Workers 上的 Telegram 双向私聊中继 Bot（版本 v3.68）。它会把用户私聊消息转发到管理员论坛群的独立 topic 中，管理员在对应 topic 内回复即可把消息发回用户，同时提供验证、过滤、封禁、备注、自动回复、备份和 Telegram 内联管理面板。

**核心特点：**
- **无回执体验**：移除了用户侧"已送达"和管理员侧"已回复"回执提示，减少打扰
- **安全加固**：支持 Webhook secret 校验、WebApp initData 验证、nonce 防伪造、管理员精确匹配
- **消息编辑同步**：用户和管理员编辑消息时，对方会收到修改通知
- **双向删除**：用户和管理员都可以通过 `/del` 命令删除消息

## 来源与致谢

本脚本基于 [huliyoudiangou/TG_Chat_Bot-D1](https://github.com/huliyoudiangou/TG_Chat_Bot-D1) 二次修改与自用优化。原项目是一个基于 Cloudflare Worker 和 D1 数据库的 Telegram 双向机器人，并在 GitHub 页面中标注为 forked from [moistrr/TGbot-D1](https://github.com/moistrr/TGbot-D1)。

感谢原作者提供 Cloudflare Worker + D1 + Telegram forum topic 的完整实现思路。本仓库版本主要保留原项目的核心工作流，并针对个人使用习惯做了精简、无回执体验、消息编辑同步和安全加固。

## 本版本调整 (v3.68)

### 用户体验优化
- ✅ 去掉用户侧"已送达"和管理员侧"已回复"回执，减少打扰和额外 API 调用
- ✅ 兼容无 `username` 的 Telegram 用户，资料卡仍可通过 `tg://user?id=...` 建立用户链接
- ✅ 支持用户编辑消息后，在管理员 topic 中记录修改前后内容
- ✅ 支持管理员编辑 topic 内消息后，主动通知用户"对方修改了消息"

### 安全加固
- ✅ 支持 Webhook secret 校验，配置 `TELEGRAM_WEBHOOK_SECRET` 后会拒绝非 Telegram webhook 请求
- ✅ 网页验证提交会校验 Telegram WebApp `initData`，并使用 nonce 防止伪造 `user_id`
- ✅ 管理员 ID 与协管 ID 使用精确匹配，避免字符串片段误判
- ✅ 屏蔽词和自动回复正则使用安全包装，降低坏正则导致 Worker 异常或 ReDoS 的风险
- ✅ 内置正则安全检查机制，拒绝复杂表达式（反向引用、环视等）

### 新增功能
- ✅ **双向消息删除**：用户和管理员都可以通过 `/del` 命令删除消息（详见下方说明）
- ✅ **引用消息支持**：用户使用 `>`、`》` 或 `&gt;` 开头的文本会被渲染为引用块
- ✅ **媒体欢迎语**：支持图片/视频/GIF 作为欢迎语，可设置 caption
- ✅ **话题自愈机制**：当 topic 失效时自动重建并迁移数据

## 核心功能

### 消息转发
- 私聊用户消息转发到管理员群论坛 topic
- 每个用户自动创建独立 topic，并推送用户身份卡片
- 资料卡和 `/card` 刷新均原位编辑；仅在没有卡片或 Telegram 确认原卡已删除时补建。首次建卡使用 D1 锁，避免并发消息重复建卡，普通资料更新不会覆盖已保存的卡片 ID。
- 配置快照缓存 60 秒，缺失配置直接使用默认值，并发加载合并为一次查询；管理员输入状态按主键实时读取。资料卡保存类型，文字卡无需每次先尝试图片编辑接口；卡片时间更新行为保持不变。消息反向映射使用索引加速管理员引用回复和删除查询。
- 管理员在对应 topic 内回复，即可把消息复制回用户私聊
- 支持消息引用关系保持（用户和管理员均可引用回复）

### 验证系统
- 支持 Cloudflare Turnstile 或 Google reCAPTCHA 人机验证
- 支持二次问答验证
- 支持验证码模式动态切换（Turnstile ↔ reCAPTCHA ↔ 关闭）
- 验证状态持久化，无需重复验证

### 消息类型控制
- 支持文本、媒体、链接、转发、频道转发、音频、贴纸/GIF 等类型过滤
- 管理员可单独控制每种消息类型的转发开关
- 管理员不受过滤限制，所有消息类型均可发送

### 智能回复
- 支持关键词自动回复（格式：`关键词===回复内容`）
- 支持屏蔽词计数封禁（可配置阈值）
- 支持忙碌模式自动回复

### 用户管理
- 支持黑名单 topic、用户解封、备注、资料卡置顶
- 支持消息编辑记录同步
- 支持消息备份到指定群或频道
- 内置 Telegram 管理面板，主管理员通过 `/start` 打开

### 双向消息删除
- **用户侧**：引用自己发送的消息，发送 `/del` 命令，可以删除该消息并通知管理员。
- **管理员侧**：
    - **单条删除**：在 topic 中引用消息，发送 `/del` 命令，可以同时删除用户侧和管理员侧的消息。
    - **批量删除**：直接发送 `/del N`（如 `/del 3`），可删除当前话题内最近的 N 条消息（仅限管理员使用，单次最多 100 条）。
    - **全量清空**：主管理员可使用 `/del all` 清空当前话题的所有历史消息。
- **权限控制**：用户只能删除自己发送的消息，无法删除管理员回复的消息；批量删除功能仅对管理员开放。

## 运行环境

- Cloudflare Workers
- Cloudflare D1 数据库绑定
- Telegram Bot Token
- 启用话题的 Telegram 管理群
- 可选：Cloudflare Turnstile 或 Google reCAPTCHA 密钥

本地回归测试使用 Node.js 22.13+，在本目录运行 `npm test`，`npm run test:integration` 单独运行 Webhook 集成测试，`npm run test:coverage` 检查 Worker 覆盖率。测试通过 SQLite 模拟 D1 的原子更新，Telegram API 使用模拟响应，不会发送真实消息。部署后脚本自动补充资料卡锁字段；历史重复卡片不会自动删除。

## 必需环境变量

| 名称 | 说明 |
| --- | --- |
| `BOT_TOKEN` | Telegram Bot Token |
| `ADMIN_IDS` | 主管理员 Telegram user id，多个用英文或中文逗号分隔 |
| `ADMIN_GROUP_ID` | 管理员论坛群 ID，通常是 `-100...` |
| `WORKER_URL` | Worker 公开访问地址，不要带结尾斜杠 |

## 可选环境变量

| 名称 | 说明 |
| --- | --- |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret key |
| `RECAPTCHA_SITE_KEY` | Google reCAPTCHA site key |
| `RECAPTCHA_SECRET_KEY` | Google reCAPTCHA secret key |
| `WELCOME_MESSAGE` | 默认欢迎语，对应配置项 `welcome_msg` |
| `VERIF_QUESTION` | 默认问答验证问题，对应 `verif_q` |
| `VERIF_ANSWER` | 默认问答验证答案，对应 `verif_a` |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram Webhook secret token，配置后会校验请求头 |

大多数运行时配置也可以在管理员面板中调整，并优先保存到 D1。

## D1 绑定

Worker 需要绑定一个 D1 数据库，绑定名必须是：

```text
TG_BOT_DB
```

脚本会自动创建和维护以下表：

- `config`：配置项。
- `users`：用户状态、封禁状态、topic 映射、用户资料。
- `messages`：用户消息与管理员群 topic 消息的映射。

## 默认配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `welcome_msg` | `欢迎 {name}！使用前请先完成验证。` | 欢迎语，支持 `{name}` 或 `{user}`，也可配置为媒体（图片/视频/GIF） |
| `enable_verify` | `true` | 是否启用网页人机验证 |
| `enable_qa_verify` | `true` | 是否启用问答验证 |
| `captcha_mode` | `turnstile` | 验证模式：`turnstile` 或 `recaptcha` |
| `verif_q` | `1+1=?\n提示：答案在简介中。` | 问题验证题目 |
| `verif_a` | `3` | 问题验证答案 |
| `block_threshold` | `5` | 命中屏蔽词多少次后封禁 |
| `busy_mode` | `false` | 是否启用非营业自动回复 |
| `enable_admin_receipt` | `false` | 管理员回执开关，当前版本默认不发送回执 |

**注意**：`welcome_msg` 支持两种格式：
1. 纯文本：直接输入文字，支持 `{name}` 占位符
2. 媒体配置：发送图片/视频/GIF 给机器人，会自动转换为 JSON 配置

## 部署流程

1. 在 Telegram 中创建 Bot，拿到 `BOT_TOKEN`。
2. 创建一个启用 Topics 的 Telegram 群，把 Bot 拉入群。
3. 给 Bot 管理员权限，至少需要发消息、管理话题、置顶消息等能力。
4. 在 Cloudflare 创建 D1 数据库并绑定为 `TG_BOT_DB`。
5. 创建 Worker，把 [tg-bot.js](tg-bot.js) 作为 Worker 代码。
6. 配置环境变量 `BOT_TOKEN`、`ADMIN_IDS`、`ADMIN_GROUP_ID`、`WORKER_URL`。
7. 如果使用网页验证，配置 Turnstile 或 reCAPTCHA 的 site key 与 secret key。
8. 设置 Telegram Webhook。

不使用 secret token 时：

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>"
```

推荐配置 `TELEGRAM_WEBHOOK_SECRET`，并设置 Webhook secret token：

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=<WORKER_URL>" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

9. 访问 Worker 根路径，若返回 `Bot v3.68 Active`，说明 Worker 基本可用。
10. 主管理员私聊 Bot 发送 `/start`，打开控制面板。
11. **首次启动建议**：
    - 在面板中配置欢迎语（可选媒体）
    - 设置验证问题和答案
    - 添加协管管理员（如有需要）
    - 配置自动回复规则
    - 设置屏蔽词列表

## Webhook 路由

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/` | `GET` | 健康检查 |
| `/verify` | `GET` | Telegram Web App 验证页面 |
| `/submit_token` | `POST` | 验证 token 提交 |
| `/` | `POST` | Telegram Webhook 更新入口 |

## 管理员面板

主管理员私聊 Bot 发送 `/start` 后会打开配置面板，包含以下模块：

### 📝 基础配置
- 欢迎语（支持文字或图片/视频/GIF）
- 验证问题与答案
- 验证码模式切换（Cloudflare / Google / 关闭）
- 问题验证开关

### 🤖 自动回复
- 添加或删除关键词自动回复
- 格式：`关键词===回复内容`
- 示例：`价格===请联系人工客服`

### 🚫 屏蔽词
- 添加或删除正则关键词
- 命中后累计计数，达到阈值自动封禁
- 建议使用简单正则，避免复杂表达式

### 🛠 过滤设置
- 控制转发、媒体、语音、贴纸、链接、频道、文本等类型
- 可单独开启/关闭每种消息类型
- 管理员不受过滤限制

### 👮 协管管理
- 维护额外授权管理员列表
- 支持批量输入：`123456,789012`
- 协管拥有回复权限，但无法访问管理面板

### 💾 备份/通知
- 设置备份群 ID，所有消息会异步归档
- 重置黑名单 topic

### 🌙 营业状态
- 切换忙碌模式
- 修改非营业时间自动回复语

## 用户流程

1. 用户私聊 Bot 发送 `/start`。
2. Bot 发送欢迎语（可能是文字或媒体）。
3. 如果启用网页验证，用户点击按钮完成 Turnstile 或 reCAPTCHA。
4. 如果启用问答验证，用户继续回答问题。
5. 验证通过后，用户消息会转发到管理员群中的个人 topic。
6. 管理员在 topic 中回复，Bot 会把回复发送给该用户。
7. 用户或管理员编辑消息时，Bot 会同步对应的编辑提示。
8. **引用消息**：用户可以使用 `>`、`》` 或 `&gt;` 开头来引用之前的内容。
9. **删除消息**：
    - **用户侧**：引用自己发送的消息，发送 `/del` 命令，可以删除该消息并通知管理员。
    - **管理员侧**：
        - 引用消息发送 `/del`：删除指定的单条双向记录。
        - 直接发送 `/del N`：删除当前话题内最近的 N 条消息（例如 `/del 5`，单次上限 100 条）。
        - 主管理员发送 `/del all`：清空当前话题的所有历史记录。
    - **注意**：用户只能删除自己发送的消息，无法删除管理员回复的消息；批量删除功能仅对管理员开放。

### 特殊语法
- **引用块**：以 `>`、`》` 或 `&gt;` 开头的文本会被渲染为 HTML 引用块
- **媒体欢迎语**：管理员可以在面板中上传图片/视频/GIF 作为欢迎语

### ⚠️ 常见问题：用户屏蔽 Bot

如果管理员回复时收到错误提示：**"⚠️ 用户已屏蔽 Bot"**，说明该用户已在 Telegram 中屏蔽了机器人。

**症状：**
- 管理员可以正常接收用户消息
- 管理员回复时显示 "用户已屏蔽 Bot" 错误
- 用户收不到管理员的回复

**原因：**
用户在 Telegram 中点击了"屏蔽机器人"（Block Bot），导致 Bot 无法再主动发消息给用户。即使用户之前发送过消息，屏蔽后 Bot 也无法回复。

**自动标记功能：**
系统会自动检测并标记被屏蔽的用户：
- 当检测到用户屏蔽 Bot 时，会自动在用户卡片上显示屏蔽状态和时间
- 用户卡片会显示 `⛔ 用户屏蔽Bot: 是 (时间)`
- 当用户重新发送消息或管理员解封时，自动清除屏蔽标记

**解决方案：**
需要通过其他方式联系该用户，让其按以下步骤解除屏蔽：
1. 打开与机器人的聊天窗口
2. 点击右上角菜单（三个点或机器人名称）
3. 选择"解除屏蔽"或"Unblock bot"
4. 重新发送 `/start` 命令激活机器人

**预防措施：**
- 在欢迎语中提醒用户不要屏蔽机器人
- 定期检查被屏蔽的用户列表（查看用户卡片上的屏蔽状态）
- 对于重要用户，建议通过其他渠道保持联系

## 安全建议

### 🔐 认证与授权
- 推荐配置 `TELEGRAM_WEBHOOK_SECRET`；未配置时会保持兼容模式，不强制校验 Telegram Webhook secret。
- `ADMIN_IDS` 和协管列表会按逗号拆分后精确匹配，避免子串误判。
- 请妥善保护 `BOT_TOKEN`、验证码 secret、D1 数据库和 Cloudflare 账号权限。

### 🛡️ 防护措施
- 管理员群必须开启 Topics，否则自动创建用户话题会失败。
- `WORKER_URL` 要使用 HTTPS 公开地址，否则 Telegram Web App 验证页面无法正常工作。
- Turnstile 和 reCAPTCHA 至少配置一种；如果关闭网页验证，可只使用问答验证。
- 屏蔽词和自动回复支持正则，但建议保持简单，避免复杂表达式造成匹配性能问题或被拒绝。

### ⚠️ 正则安全
- 系统内置正则安全检查，会拒绝以下模式：
    - 嵌套量词（如 `(a+)+`）
    - 反向引用（如 `\1`）
    - 环视断言（如 `(?<=...)`、`(?<!...)`）
    - 超长模式（>256 字符）
- 这可以有效防止 ReDoS（正则表达式拒绝服务攻击）

### 📊 性能优化
- 系统使用内存缓存减少 D1 数据库读写（缓存 TTL 60 秒）
- 用户 topic 创建有锁机制，防止并发冲突
- 警告消息有 3 秒冷却时间，防止刷量攻击

## 技术细节

### 数据库结构
- **config**：存储配置项（键值对）
- **users**：用户状态、封禁状态、topic 映射、用户资料（JSON）
- **messages**：用户消息与管理员群 topic 消息的双向映射

### 缓存机制
- 配置缓存：TTL 60 秒，减少 D1 查询
- 管理员集合缓存：TTL 60 秒，加速权限检查
- 用户锁机制：防止同一用户并发创建多个 topic

### API 调用策略
- 使用 `copyMessage` 优先，保持消息引用关系
- 降级使用 `forwardMessage`（不支持引用时）
- 错误自愈：topic 失效时自动重建并重试

### 版本历史
- **v3.68**（当前版本）：无回执模式 + 安全加固 + 双向删除
- 基于 [huliyoudiangou/TG_Chat_Bot-D1](https://github.com/huliyoudiangou/TG_Chat_Bot-D1) 二次开发
- 上游 fork 自 [moistrr/TGbot-D1](https://github.com/moistrr/TGbot-D1)

## 许可证与上游

原项目 [huliyoudiangou/TG_Chat_Bot-D1](https://github.com/huliyoudiangou/TG_Chat_Bot-D1) 采用 MIT License。本仓库中的修改版沿用原项目开源精神，仅作个人维护与自用优化；如需完整部署教程、上游更新和问题讨论，请优先参考原作者仓库。
