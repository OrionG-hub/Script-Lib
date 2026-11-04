# Gitea Raw Bot 实现方案

## 已确认需求
- 独立 Worker 小项目，部署目录 Cloudflare/gitea-raw-bot，连接 Git 后提交自动部署。
- Telegram 私聊白名单用户发送 Gitea 文件页面或 Raw 链接，保留分支并通过 Shlink 返回短链。
- 兼容 /{repository}/{path}，非默认分支使用 ref 查询参数。
- 私库沿用 TOKEN；Bot 与 Shlink 目标不包含 TOKEN，访问者自行携带。
- 无需数据库；上游请求超时，禁止跟随带凭据的上游重定向。

## 模块与验证计划
1. src/common.js：配置、路径校验、超时请求和错误；单测覆盖拒绝非法路径及配置。
2. src/raw.js：匿名优先仓库查询、鉴权、ref、流式输出、公共缓存；测试私库鉴权和缓存隔离。
3. src/bot.js：Webhook、白名单、Gitea 分支解析、Shlink；集成测试贯通收消息到回短链，断言凭据不进入链接。
4. src/index.js 与 wrangler.toml：路由及 Git 部署；dry-run 验证打包配置。
5. README：Secrets、变量、Webhook 注册、私库访问与短链查询参数注意事项。

## 边界
单条消息一个链接，不上传文件，不增加管理页面。Webhook 同步完成处理；转换失败回复错误后确认消息，由用户重发；Telegram 回复发送失败返回非 2xx 供 Telegram 重试；不保证跨重试恰好一次回复。公共缓存 TTL 60 秒，每次命中前重新查询仓库权限；私库不缓存。默认分支链接跟随默认分支变化，其他分支链接跟随该分支最新内容。带斜杠分支按最长有效分支名解析，最多探测 20 段；无法解析时返回错误。
