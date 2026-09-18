/**
 * Telegram Bot Worker v3.68 (No-Receipt Mod, No-Username Fix & Security Hardening)
 * 完整功能版：保留所有备份、配置面板、辅助函数
 * * 修改 1: 修复了无用户名用户无法推送卡片的问题
 * * 修改 2: 彻底移除了管理员回复的“✅ 已回复”提示
 * * 修改 3: 彻底移除了用户发送消息后的“✅ 已送达”回执
 * * 修改 4: 增加 Webhook secret、WebApp initData、nonce、管理员精确匹配与正则安全检查
 */

// --- 1. 静态配置与常量 ---
// 缓存系统，用于减少数据库读写压力，降低 Worker KV/D1 计费
const CACHE = { data: {}, ts: 0, ttl: 60000, user_locks: {}, warn_cd: {}, admin: { ts: 0, ttl: 60000, primary: new Set(), auth: new Set() } };

const DEFAULTS = {
    // 基础设置
    welcome_msg: "欢迎 {name}！使用前请先完成验证。",

    // 验证设置
    enable_verify: "true",
    enable_qa_verify: "true",
    captcha_mode: "turnstile",
    verif_q: "1+1=?\n提示：答案在简介中。",
    verif_a: "3",

    // 风控设置
    block_threshold: "5",
    enable_admin_receipt: "false", // 默认关闭管理员回执

    // 转发类型开关配置
    enable_image_forwarding: "true", enable_link_forwarding: "true", enable_text_forwarding: "true",
    enable_channel_forwarding: "true", enable_forward_forwarding: "true", enable_audio_forwarding: "true", enable_sticker_forwarding: "true",

    // 话题与列表存储占位
    backup_group_id: "", blocked_topic_id: "",
    busy_mode: "false", busy_msg: "当前是非营业时间，消息已收到，管理员稍后回复。",
    block_keywords: "[]", keyword_responses: "[]", authorized_admins: "[]"
};

// 消息类型检查与映射字典
const MSG_TYPES = [
    { check: m => m.forward_from || m.forward_from_chat || m.forward_origin, key: 'enable_forward_forwarding', name: "转发消息", extra: m => (m.forward_from_chat?.type === 'channel' || m.forward_origin?.type === 'channel') ? 'enable_channel_forwarding' : null },
    { check: m => m.audio || m.voice, key: 'enable_audio_forwarding', name: "语音/音频" },
    { check: m => m.sticker || m.animation, key: 'enable_sticker_forwarding', name: "贴纸/GIF" },
    { check: m => m.photo || m.video || m.document, key: 'enable_image_forwarding', name: "媒体文件" },
    { check: m => ([...(m.entities||[]), ...(m.caption_entities||[])]).some(e => ['url','text_link'].includes(e.type)), key: 'enable_link_forwarding', name: "链接" },
    { check: m => m.text || m.caption, key: 'enable_text_forwarding', name: "纯文本" }
];

const REGEX_MAX_PATTERN_LEN = 256;
const REGEX_MAX_TEXT_LEN = 512;
const MAX_BATCH_DELETE = 100;
const API_TIMEOUT_MS = 15000;
const API_MAX_RETRIES = 2;
const TOPIC_LOCK_TIMEOUT_MS = 30000;
const CARD_LOCK_TIMEOUT_MS = 180000;
const DATABASE_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const RULE_PAGE_SIZE = 20;
const REGEX_REJECT_PATTERNS = [
    /\([^)]*\)\s*[+*{]/,
    /\(\s*\.\*\s*\)\s*\+/,
    /\(\s*\.\+\s*\)\s*\+/,
    /\\[1-9]/,
    /\(\?<=[\s\S]*\)/,
    /\(\?<![\s\S]*\)/
];

let migrationPromise = null;

// --- 2. 核心入口 (Entry Point) ---
export default {
    async fetch(req, env, ctx) {
        try {
            await dbInit(env);
            const url = new URL(req.url);

            // GET 请求处理：验证页面加载或连通性测试
            if (req.method === "GET") {
                if (url.pathname === "/verify") return handleVerifyPage(url, env);
                if (url.pathname === "/") return new Response("Bot v3.68 Active", { status: 200 });
            }
            // POST 请求处理：Telegram Webhook 核心逻辑接收端
            if (req.method === "POST") {
                if (url.pathname === "/submit_token") return handleTokenSubmit(req, env);
                if (!isTelegramWebhook(req, env)) return new Response("Forbidden", { status: 403 });
                try {
                    const update = await req.json();
                    ctx.waitUntil(handleUpdate(update, env, ctx).catch(err => console.error("Update Failed:", err?.stack || err)));
                    if (Math.random() < 0.01) ctx.waitUntil(cleanupDatabase(env));
                    return new Response("OK");
                } catch (jsonErr) {
                    console.error("Invalid JSON Update:", jsonErr);
                    return new Response("Bad Request", { status: 400 });
                }
            }
        } catch (e) {
            console.error("Critical Worker Error:", e);
            return new Response(`Internal Server Error: ${e?.message || e}`, { status: 500 });
        }
        return new Response("404 Not Found", { status: 404 });
    }
};

// --- 3. 数据库与工具函数 ---
// 安全解析JSON，避免非规范格式导致脚本执行中断
const safeParse = (str, fallback = {}) => {
    if (!str) return fallback;
    try { return JSON.parse(str); }
    catch (e) { console.error("JSON Parse Error:", e); return fallback; }
};

// SQL 执行封装，支持不同的运行类型 (run, all, first)
const sql = async (env, query, args = [], type = 'run') => {
    try {
        const stmt = env.TG_BOT_DB.prepare(query).bind(...(Array.isArray(args) ? args : [args]));
        return type === 'run' ? await stmt.run() : await stmt[type]();
    } catch (e) {
        console.error(`SQL Error [${query}]:`, e);
        return null;
    }
};

// 获取配置项：优先命中内存缓存以提升响应速度
async function getCfg(key, env) {
    const now = Date.now();
    if (CACHE.ts && (now - CACHE.ts) < CACHE.ttl && CACHE.data[key] !== undefined) return CACHE.data[key];

    const rows = await sql(env, "SELECT * FROM config", [], 'all');
    if (rows && rows.results) {
        CACHE.data = {};
        rows.results.forEach(r => CACHE.data[r.key] = r.value);
        CACHE.ts = now;
    }
    const envKey = key.toUpperCase().replace(/_MSG|_Q|_A/, m => ({'_MSG':'_MESSAGE','_Q':'_QUESTION','_A':'_ANSWER'}[m]));
    return CACHE.data[key] !== undefined ? CACHE.data[key] : (env[envKey] || DEFAULTS[key] || "");
}

// 设置配置项：同步使当前内存缓存失效
async function setCfg(key, val, env) {
    await sql(env, "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, val]);
    CACHE.ts = 0;
    if (key === 'authorized_admins') CACHE.admin.ts = 0;
}

// 删除配置项：同步失效缓存，避免旧值被 getCfg 误读
async function deleteCfg(key, env) {
    await sql(env, "DELETE FROM config WHERE key=?", key);
    delete CACHE.data[key];
    CACHE.ts = 0;
    if (key === 'authorized_admins') CACHE.admin.ts = 0;
}

// 获取或初始化用户信息实体
async function getUser(id, env) {
    let u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, 'first');
    if (!u) {
        try { await sql(env, "INSERT OR IGNORE INTO users (user_id, user_state) VALUES (?, 'new')", id); } catch {}
        u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, 'first');
    }
    if (!u) u = { user_id: id, user_state: 'new', is_blocked: 0, is_muted: 0, block_count: 0, first_message_sent: 0, topic_id: null, topic_creating: 0, topic_lock_at: null, card_creating: 0, card_lock_at: null, user_info_json: "{}" };

    // 布尔状态类型转换及附属 JSON 解析
    u.is_blocked = !!u.is_blocked;
    u.is_muted = !!u.is_muted;
    u.first_message_sent = !!u.first_message_sent;
    u.topic_creating = !!u.topic_creating;
    u.card_creating = !!u.card_creating;
    u.user_info = safeParse(u.user_info_json);
    return u;
}

// 增量更新用户信息记录
async function updUser(id, data, env) {
    const { user_info, card_info, ...fields } = data;
    const keys = Object.keys(fields);
    const assignments = keys.map(k => `${k}=?`);
    const values = keys.map(k => typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]);
    if (user_info || card_info) {
        let infoExpr = "COALESCE(user_info_json, '{}')";
        if (user_info) {
            // 普通资料写入可能来自旧请求；卡片状态只能通过 card_info 显式修改。
            infoExpr = `json_set(?, '$.card_msg_id', json_extract(${infoExpr}, '$.card_msg_id'),
                '$.dummy_msg_id', json_extract(${infoExpr}, '$.dummy_msg_id'),
                '$.join_date', json_extract(${infoExpr}, '$.join_date'))`;
            values.push(JSON.stringify(user_info));
        }
        if (card_info) {
            infoExpr = `json_patch(${infoExpr}, ?)`;
            values.push(JSON.stringify(card_info));
        }
        assignments.push(`user_info_json=${infoExpr}`);
    }
    if (!assignments.length) return;
    const query = `UPDATE users SET ${assignments.join(',')} WHERE user_id=?`;
    values.push(id);
    // 卡片 ID 落库失败必须报错，不能静默当作保存成功。
    if (card_info) return env.TG_BOT_DB.prepare(query).bind(...values).run();
    await sql(env, query, values);
}

// 数据库表结构初始化与防御性兼容处理
async function dbInit(env) {
    if (!env.TG_BOT_DB) return;
    if (migrationPromise) return migrationPromise;
    migrationPromise = migrateDb(env).catch((error) => {
        migrationPromise = null;
        throw error;
    });
    return migrationPromise;
}

async function migrateDb(env) {
    await env.TG_BOT_DB.batch([
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`),
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, user_state TEXT DEFAULT 'new', is_blocked INTEGER DEFAULT 0, is_muted INTEGER DEFAULT 0, block_count INTEGER DEFAULT 0, first_message_sent INTEGER DEFAULT 0, topic_id TEXT, topic_creating INTEGER DEFAULT 0, topic_lock_at INTEGER, card_creating INTEGER DEFAULT 0, card_lock_at INTEGER, user_info_json TEXT, updated_at INTEGER)`),
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS messages (user_id TEXT, message_id TEXT, text TEXT, date INTEGER, topic_message_id TEXT, PRIMARY KEY (user_id, message_id))`),
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS processed_updates (update_id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL)`)
    ]);
    await ensureColumn(env, "users", "is_muted", "INTEGER DEFAULT 0");
    await ensureColumn(env, "users", "topic_creating", "INTEGER DEFAULT 0");
    await ensureColumn(env, "users", "topic_lock_at", "INTEGER");
    await ensureColumn(env, "users", "card_creating", "INTEGER DEFAULT 0");
    await ensureColumn(env, "users", "card_lock_at", "INTEGER");
    await ensureColumn(env, "users", "updated_at", "INTEGER");
    await ensureColumn(env, "messages", "topic_message_id", "TEXT");
    await ensureColumn(env, "processed_updates", "processed_at", "INTEGER DEFAULT 0");
    await safeDbRun(env, `CREATE INDEX IF NOT EXISTS idx_users_topic_id ON users(topic_id)`);
    await safeDbRun(env, `CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date)`);
    await safeDbRun(env, `CREATE INDEX IF NOT EXISTS idx_processed_updates_time ON processed_updates(processed_at)`);
}

async function ensureColumn(env, tableName, columnName, definition) {
    try {
        await env.TG_BOT_DB.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
    } catch (error) {
        const message = String(error?.message || error).toLowerCase();
        if (!message.includes("duplicate column") && !message.includes("already exists")) {
            console.warn(`Skip migration column ${tableName}.${columnName}:`, error?.message || error);
        }
    }
}

async function safeDbRun(env, query) {
    try {
        await env.TG_BOT_DB.prepare(query).run();
    } catch (error) {
        console.warn(`Skip migration query [${query}]:`, error?.message || error);
    }
}

async function claimUpdate(updateId, env) {
    if (updateId === undefined || updateId === null || !env.TG_BOT_DB) return true;
    const result = await env.TG_BOT_DB.prepare(`
        INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)
    `).bind(String(updateId), Math.floor(Date.now() / 1000)).run();
    return Number(result.meta?.changes || 0) === 1;
}

async function cleanupDatabase(env) {
    if (!env.TG_BOT_DB) return;
    const cutoff = Math.floor(Date.now() / 1000) - DATABASE_RETENTION_SECONDS;
    try {
        await env.TG_BOT_DB.batch([
            env.TG_BOT_DB.prepare("DELETE FROM messages WHERE date < ?").bind(cutoff),
            env.TG_BOT_DB.prepare("DELETE FROM processed_updates WHERE processed_at < ?").bind(cutoff)
        ]);
    } catch (error) {
        console.error("DB cleanup failed:", error);
    }
}

// --- 4. 业务逻辑 (核心流) ---

// Telegram Bot API 原生请求封装
async function api(token, method, body, attempt = 0, retryAmbiguous = true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        let d;
        try {
            d = await r.json();
        } catch {
            throw new Error(`Telegram API 返回非 JSON (${method}, ${r.status})`);
        }
        if (!d.ok) {
            const retryAfter = Number(d.parameters?.retry_after || 0);
            if (d.error_code === 429 && retryAfter > 0 && attempt < API_MAX_RETRIES) {
                await sleep(Math.min(retryAfter * 1000, 10000));
                return api(token, method, body, attempt + 1, retryAmbiguous);
            }
            if (retryAmbiguous && r.status >= 500 && attempt < API_MAX_RETRIES) {
                await sleep(500 * (attempt + 1));
                return api(token, method, body, attempt + 1, retryAmbiguous);
            }
            console.warn(`TG API Error [${method}]:`, d.description);
            throw new Error(d.description || `Telegram API failed (${method})`);
        }
        return d.result;
    } catch (e) {
        if (retryAmbiguous && attempt < API_MAX_RETRIES && (e?.name === "AbortError" || e instanceof TypeError)) {
            await sleep(500 * (attempt + 1));
            return api(token, method, body, attempt + 1, retryAmbiguous);
        }
        throw e?.name === "AbortError" ? new Error(`Telegram API 请求超时 (${method})`) : e;
    } finally {
        clearTimeout(timer);
    }
}

// 自动向 Telegram 注册快捷菜单命令
async function registerCommands(env) {
    try {
        await api(env.BOT_TOKEN, "deleteMyCommands", { scope: { type: "default" } });
        await api(env.BOT_TOKEN, "setMyCommands", { commands: [{ command: "start", description: "开始 / Start" }], scope: { type: "default" } });
        const sets = await getAdminSets(env);
        const admins = [...sets.auth];
        for (const id of admins) await api(env.BOT_TOKEN, "setMyCommands", { commands: [
            { command: "start", description: "⚙️ 管理面板" },
            { command: "help", description: "📄 帮助说明" },
            { command: "ban", description: "封禁当前话题用户" },
            { command: "unban", description: "解除当前话题用户封禁" },
            { command: "card", description: "刷新当前用户资料卡" },
            { command: "terminate", description: "删除当前用户话题" }
        ], scope: { type: "chat", chat_id: id } });
    } catch (e) { console.error("Register Commands Failed:", e); }
}

// 全局更新对象分发调度中心
async function handleUpdate(update, env, ctx) {
    if (!(await claimUpdate(update?.update_id, env))) {
        console.log("Duplicate update ignored:", update?.update_id);
        return;
    }

    const msg = update.message || update.edited_message;
    if (!msg) return update.callback_query ? handleCallback(update.callback_query, env) : null;

    // 监听管理员侧的消息变更事件
    if (update.edited_message && msg.chat.id.toString() === env.ADMIN_GROUP_ID) {
        return handleAdminEdit(msg, env);
    }

    // 监听用户侧的消息变更事件
    if (update.edited_message) return (msg.chat.type === "private") ? handleEdit(msg, env) : null;

    // 会话路由
    if (msg.chat.type === "private") await handlePrivate(msg, env, ctx);
    else if (msg.chat.id.toString() === env.ADMIN_GROUP_ID) {
        const delCmd = parseDelCommand(msg.text || msg.caption || "");
        const adminCmd = parseAdminCommand(msg.text || msg.caption || "");
        if (delCmd) {
            await handleAdminDelete(msg, env, delCmd);
        } else if (adminCmd) {
            await handleAdminCommand(msg, env, adminCmd);
        } else {
            await handleAdminReply(msg, env);
        }
    }
}

// 管理员编辑群组内消息时的逻辑，主动通知用户变更内容
async function handleAdminEdit(msg, env) {
    if (!msg.message_thread_id) return;
    const u = await sql(env, "SELECT user_id FROM users WHERE topic_id = ?", msg.message_thread_id.toString(), 'first');
    if (!u) return;

    const newText = msg.text || msg.caption || "[媒体消息]";
    await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: u.user_id,
        text: `✏️ <b>对方修改了消息</b>\n内容: ${escape(newText)}`,
        parse_mode: "HTML"
    });
}

// 用户侧删除消息处理
async function handleUserDelete(msg, u, env) {
    if (!msg.reply_to_message) {
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: u.user_id,
            text: "⚠️ 请回复要删除的消息后使用 /del 命令",
            reply_to_message_id: msg.message_id
        });
    }

    // 检查是否是 Bot 发送的消息（管理员回复）
    if (msg.reply_to_message.from && msg.reply_to_message.from.is_bot) {
        console.log(`Delete blocked: User tried to delete bot's message`);
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: u.user_id,
            text: "❌ 您只能删除自己发送的消息，无法删除管理员回复的消息",
            reply_to_message_id: msg.message_id
        });
    }

    const targetMsgIdRaw = msg.reply_to_message.message_id;
    const targetMsgId = targetMsgIdRaw.toString();
    console.log(`Delete request: user=${u.user_id}, target_msg_raw=${targetMsgIdRaw} (type: ${typeof targetMsgIdRaw}), target_msg_str=${targetMsgId}`);

    // 查询对应的管理员侧消息ID - 尝试多种可能的格式
    let ref = await sql(env, "SELECT topic_message_id FROM messages WHERE user_id=? AND message_id=?", [u.user_id, targetMsgId], 'first');

    // 如果没找到，尝试用整数查询（以防数据库中存的是数字）
    if (!ref || !ref.topic_message_id) {
        console.log(`First query failed, trying with integer...`);
        ref = await sql(env, "SELECT topic_message_id FROM messages WHERE user_id=? AND message_id=?", [u.user_id, parseInt(targetMsgId)], 'first');
    }

    if (!ref || !ref.topic_message_id) {
        console.log(`Delete failed: No mapping found for user=${u.user_id}, msg=${targetMsgId}`);
        console.log(`Tip: Check database records with: SELECT * FROM messages WHERE user_id='${u.user_id}'`);

        // 帮助用户排查：列出该用户的最近5条消息记录
        try {
            const recentMsgs = await sql(env, "SELECT message_id, topic_message_id, text FROM messages WHERE user_id=? ORDER BY date DESC LIMIT 5", [u.user_id], 'all');
            if (recentMsgs && recentMsgs.results) {
                console.log(`Recent messages for user ${u.user_id}:`, JSON.stringify(recentMsgs.results));
            }
        } catch (e) {
            console.log(`Failed to fetch recent messages:`, e.message);
        }

        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: u.user_id,
            text: "❌ 未找到对应的消息记录，可能该消息未被转发或已被删除",
            reply_to_message_id: msg.message_id
        });
    }

    console.log(`Delete success: Found mapping topic_msg=${ref.topic_message_id}`);

    try {
        // 1. 删除被回复的目标消息（先删目标，再删命令）
        await api(env.BOT_TOKEN, "deleteMessage", {
            chat_id: u.user_id,
            message_id: parseInt(targetMsgId)
        }).catch((e) => console.log("Failed to delete target msg:", e.message));

        // 2. 删除用户侧的 /del 命令消息
        await api(env.BOT_TOKEN, "deleteMessage", {
            chat_id: u.user_id,
            message_id: msg.message_id
        }).catch((e) => console.log("Failed to delete /del cmd:", e.message));

        // 3. 通知管理员（引用原消息）
        await api(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            message_thread_id: u.topic_id,
            text: `🗑️ <b>用户已删除消息</b>`,
            parse_mode: "HTML",
            reply_to_message_id: parseInt(ref.topic_message_id)
        }).catch((e) => console.log("Failed to notify admin:", e.message));

        // 4. 清理数据库记录
        await sql(env, "DELETE FROM messages WHERE user_id=? AND message_id=?", [u.user_id, targetMsgId]);
        console.log(`Delete completed: Cleaned up database record`);

    } catch (e) {
        console.error("User Delete Failed:", e);
        await api(env.BOT_TOKEN, "sendMessage", {
            chat_id: u.user_id,
            text: "❌ 删除失败，请稍后重试",
            reply_to_message_id: msg.message_id
        });
    }
}

// 管理员侧删除消息处理
async function handleAdminDelete(msg, env, delCmd = parseDelCommand(msg.text || msg.caption || "")) {
    if (!msg.message_thread_id || !(await isAuthAdmin(msg.from.id, env))) return;

    if (delCmd?.type === "all") return handleAdminBatchDelete(msg, env, { all: true });
    if (delCmd?.type === "count") return handleAdminBatchDelete(msg, env, { count: delCmd.count });
    if (delCmd?.type === "invalid") {
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: `⚠️ 用法：回复消息使用 /del，或使用 /del N 删除最近 N 条（最多 ${MAX_BATCH_DELETE} 条），/del all 清空当前话题`
        });
    }

    if (!msg.reply_to_message) {
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: "⚠️ 请回复要删除的消息后使用 /del 命令，或使用 /del N 删除最近 N 条"
        });
    }

    const targetTopicMsgId = msg.reply_to_message.message_id;

    // 查询对应的用户侧消息ID
    const ref = await sql(env, "SELECT user_id, message_id FROM messages WHERE topic_message_id=?", targetTopicMsgId.toString(), 'first');

    if (!ref) {
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: "❌ 未找到对应的消息记录"
        });
    }

    try {
        // 1. 删除管理员侧消息（包括 /del 命令本身和被回复的消息）
        await api(env.BOT_TOKEN, "deleteMessage", {
            chat_id: msg.chat.id,
            message_id: msg.message_id
        }).catch(() => {});

        await api(env.BOT_TOKEN, "deleteMessage", {
            chat_id: msg.chat.id,
            message_id: targetTopicMsgId
        }).catch(() => {});

        // 2. 删除用户侧消息
        await api(env.BOT_TOKEN, "deleteMessage", {
            chat_id: ref.user_id,
            message_id: parseInt(ref.message_id)
        }).catch(() => {});

        // 3. 清理数据库记录
        await sql(env, "DELETE FROM messages WHERE user_id=? AND message_id=?", [ref.user_id, ref.message_id]);

    } catch (e) {
        console.error("Admin Delete Failed:", e);
        await api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: "❌ 删除失败，请稍后重试"
        });
    }
}

async function handleAdminBatchDelete(msg, env, options = {}) {
    const userRef = await sql(env, "SELECT user_id FROM users WHERE topic_id = ?", msg.message_thread_id.toString(), 'first');
    if (!userRef?.user_id) {
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: "❌ 当前话题未绑定用户"
        });
    }

    const u = await getUser(userRef.user_id, env);
    const keepCardMsgId = u?.user_info?.card_msg_id ? parseInt(u.user_info.card_msg_id) : null;
    const limit = Math.min(Math.max(parseInt(options.count) || 0, 1), MAX_BATCH_DELETE);
    const rows = options.all
        ? await sql(env, "SELECT rowid, message_id, topic_message_id FROM messages WHERE user_id=? ORDER BY date DESC, rowid DESC", [u.user_id], 'all')
        : await sql(env, "SELECT rowid, message_id, topic_message_id FROM messages WHERE user_id=? ORDER BY date DESC, rowid DESC LIMIT ?", [u.user_id, limit], 'all');
    const mapped = rows?.results || [];

    let adminDeleted = 0;
    let userDeleted = 0;

    try {
        // 删除管理员侧命令消息本身
        await api(env.BOT_TOKEN, "deleteMessage", {
            chat_id: msg.chat.id,
            message_id: msg.message_id
        }).catch(() => {});

        if (!mapped.length) {
            return api(env.BOT_TOKEN, "sendMessage", {
                chat_id: msg.chat.id,
                message_thread_id: msg.message_thread_id,
                text: "❌ 当前话题没有可删除的消息记录"
            }).catch(() => {});
        }

        for (const r of mapped) {
            const topicMid = parseInt(r.topic_message_id);
            const userMid = parseInt(r.message_id);

            if (Number.isFinite(topicMid) && (!keepCardMsgId || topicMid !== keepCardMsgId)) {
                await api(env.BOT_TOKEN, "deleteMessage", {
                    chat_id: msg.chat.id,
                    message_id: topicMid
                }).then(() => { adminDeleted += 1; }).catch(() => {});
            }

            if (Number.isFinite(userMid)) {
                await api(env.BOT_TOKEN, "deleteMessage", {
                    chat_id: u.user_id,
                    message_id: userMid
                }).then(() => { userDeleted += 1; }).catch(() => {});
            }
        }

        if (options.all) {
            await sql(env, "DELETE FROM messages WHERE user_id=?", [u.user_id]);
        } else if (mapped.length) {
            const rowIds = mapped.map(r => r.rowid).filter(id => id !== undefined && id !== null);
            const placeholders = rowIds.map(() => "?").join(",");
            await sql(env, `DELETE FROM messages WHERE user_id=? AND rowid IN (${placeholders})`, [u.user_id, ...rowIds]);
        }

        console.log(`Admin batch delete done: all=${!!options.all}, mapped=${mapped.length}, admin=${adminDeleted}, user=${userDeleted}`);
    } catch (e) {
        console.error("Admin Batch Delete Failed:", e);
        await api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: "❌ 批量删除失败，请稍后重试"
        }).catch(() => {});
    }
}

async function handleAdminCommand(msg, env, cmd) {
    if (!msg.message_thread_id || !(await isAuthAdmin(msg.from.id, env))) return;

    const targetUid = cmd.arg || (await sql(env, "SELECT user_id FROM users WHERE topic_id = ?", msg.message_thread_id.toString(), 'first'))?.user_id;
    if (!targetUid) {
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: "❌ 当前话题未绑定用户，也没有指定用户 ID"
        });
    }

    const u = await getUser(targetUid, env);
    if (cmd.command === "ban" || cmd.command === "unban") {
        const isBlocked = cmd.command === "ban";
        await setUserBlocked(env, targetUid, isBlocked);
        const fresh = await getUser(targetUid, env);
        await manageBlacklist(env, fresh, { id: targetUid, username: fresh.user_info.username, first_name: fresh.user_info.name }, isBlocked);
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: isBlocked ? "❌ 已封禁" : "✅ 已解封"
        });
    }

    if (cmd.command === "card") {
        const cardId = await rebuildInfoCard(env, targetUid, msg.message_thread_id.toString());
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: cardId ? "✅ 资料卡已刷新" : "❌ 资料卡刷新失败"
        });
    }

    if (cmd.command === "terminate") {
        await api(env.BOT_TOKEN, "deleteForumTopic", {
            chat_id: env.ADMIN_GROUP_ID,
            message_thread_id: msg.message_thread_id
        }).catch(() => {});
        await updUser(targetUid, { topic_id: null, topic_creating: false, topic_lock_at: null, card_info: { card_msg_id: null, dummy_msg_id: null } }, env);
        await sql(env, "DELETE FROM messages WHERE user_id=?", [targetUid]);
    }
}

// 私聊消息处理总线 (用户侧逻辑入口)
async function handlePrivate(msg, env, ctx) {
    const id = msg.chat.id.toString();
    const text = msg.text || "";
    const isAdm = await isPrimaryAdmin(id, env);
    const u = await getUser(id, env);

    // 人机验证拦截器 (非管理人员未完成验证则阻断)
    if (text !== "/start" && u.user_state !== 'pending_verification' && !isAdm) {
        const isCaptchaOn = await getBool('enable_verify', env);
        const isQAOn = await getBool('enable_qa_verify', env);

        if ((isCaptchaOn || isQAOn) && u.user_state !== 'verified') {
            const now = Date.now();
            const lastWarn = CACHE.warn_cd[id] || 0;
            // 设定3秒冷却限流阈值，防止恶意并发攻击刷量
            if (now - lastWarn < 3000) return;
            CACHE.warn_cd[id] = now;
            return api(env.BOT_TOKEN, "sendMessage", {
                chat_id: id,
                text: "❗️❗️❗️请先进行验证，再发送消息",
                reply_to_message_id: msg.message_id
            });
        }
    }

    // 1. 命令显式路由处理
    if (text === "/start") {
        if (isAdm && ctx) ctx.waitUntil(registerCommands(env));
        if (!isAdm) {
            if (u.topic_id) await syncTopicProfile(u, msg.from, env);
            if (u.user_state === 'verified' && !u.is_blocked) {
                return api(env.BOT_TOKEN, "sendMessage", {
                    chat_id: id,
                    text: "✅ 您已经完成验证，可以直接发送消息，我会帮您转达给管理员。",
                    reply_to_message_id: msg.message_id
                });
            }
            await updUser(id, { user_state: 'new' }, env);
            u.user_state = 'new';
        }
        return isAdm ? handleAdminConfig(id, null, 'menu', null, null, env) : sendStart(id, msg, env);
    }
    if (text === "/help" && isAdm) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "ℹ️ <b>帮助</b>\n• 回复消息即对话\n• /start 打开面板\n• /del 删除单条消息\n• /del N 删除最近 N 条消息\n• /del all 清空当前话题消息（保留用户信息卡片）\n• 管理群话题内支持 /ban /unban /card /terminate", parse_mode: "HTML" });
    if (text === "/del" && !isAdm) return handleUserDelete(msg, u, env);
    if (!isAdm && parseDelCommand(text)) {
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: id,
            text: "⚠️ 用户侧只能回复要删除的消息后使用 /del 命令",
            reply_to_message_id: msg.message_id
        });
    }

    // 2. 封禁拦截层
    if (u.is_blocked) {
        return;
    }

    if (u.is_muted) {
        return;
    }

    // 3. 授权状态补偿验证
    if (await isAuthAdmin(id, env)) {
        if(u.user_state !== "verified") await updUser(id, { user_state: "verified" }, env);
        if(text === "/start" && ctx) ctx.waitUntil(registerCommands(env));
    }

    // 4. 管理员配置状态机判定（面板输入模式截取）
    if (isAdm) {
        const stateStr = await getCfg(`admin_state:${id}`, env);
        if (stateStr) {
            const state = safeParse(stateStr);
            if (state.action === 'input') return handleAdminInput(id, msg, state, env);
        }
    }

    // 5. 常规状态验证路由
    const isCaptchaOn = await getBool('enable_verify', env);
    const isQAOn = await getBool('enable_qa_verify', env);

    if (!isCaptchaOn && !isQAOn) {
        if (u.user_state !== 'verified') await updUser(id, { user_state: "verified" }, env);
        return handleVerifiedMsg(msg, u, env);
    }

    const state = u.user_state;
    if (state === 'pending_verification') return verifyAnswer(id, text, env);
    if (state === 'verified') return handleVerifiedMsg(msg, u, env);

    return sendStart(id, msg, env);
}

// 首次接入：渲染欢迎页面与验证环节
async function sendStart(id, msg, env) {
    const u = await getUser(id, env);
    if (u.topic_id) {
        try {
            await syncTopicProfile(u, msg.from, env);
            await ensureInfoCardBeforeRelay(env, u, msg.from, u.topic_id, msg.date);
        } catch (e) {
            console.error("Start info card failed:", e);
            if (isTopicMissing(e)) await updUser(id, { topic_id: null }, env);
        }
    }

    let welcomeRaw = await getCfg('welcome_msg', env);
    const firstName = (msg.from.first_name || "用户").replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const nameDisplay = escape(firstName);

    let mediaConfig = null;
    let welcomeText = welcomeRaw;
    try {
        if (welcomeRaw.trim().startsWith('{')) {
            mediaConfig = safeParse(welcomeRaw, null);
            if(mediaConfig) welcomeText = mediaConfig.caption || "";
        }
    } catch {}

    welcomeText = welcomeText.replace(/{name}|{user}/g, nameDisplay);

    try {
        if (mediaConfig && mediaConfig.type) {
            const method = `send${mediaConfig.type.charAt(0).toUpperCase() + mediaConfig.type.slice(1)}`;
            let body = { chat_id: id, caption: welcomeText, parse_mode: "HTML" };
            if (mediaConfig.type === 'photo') body.photo = mediaConfig.file_id;
            else if (mediaConfig.type === 'video') body.video = mediaConfig.file_id;
            else if (mediaConfig.type === 'animation') body.animation = mediaConfig.file_id;
            else body = { chat_id: id, text: welcomeText, parse_mode: "HTML" };
            await api(env.BOT_TOKEN, method, body);
        } else {
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: welcomeText, parse_mode: "HTML" });
        }
    } catch (e) {
        await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "Welcome!", parse_mode: "HTML" });
    }

    const url = (env.WORKER_URL || "").replace(/\/$/, '');
    const mode = await getCfg('captcha_mode', env);
    const hasKey = mode === 'recaptcha' ? env.RECAPTCHA_SITE_KEY : env.TURNSTILE_SITE_KEY;
    const isCaptchaOn = await getBool('enable_verify', env);
    const isQAOn = await getBool('enable_qa_verify', env);

    if (isCaptchaOn && url && hasKey) {
        const nonce = genNonce();
        await updUser(id, { user_state: "pending_turnstile", user_info: { ...u.user_info, verify_nonce: nonce, verify_nonce_ts: Date.now() } }, env);
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: id,
            text: "🛡️ <b>安全验证</b>\n请点击下方按钮完成人机验证以继续。",
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "点击进行验证", web_app: { url: `${url}/verify?user_id=${encodeURIComponent(id)}&nonce=${encodeURIComponent(nonce)}` } }]] }
        });
    } else if (isQAOn) {
        await updUser(id, { user_state: "pending_verification" }, env);
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: id,
            text: "❓ <b>安全提问</b>\n请回答：\n" + await getCfg('verif_q', env),
            parse_mode: "HTML"
        });
    } else if (isCaptchaOn || isQAOn) {
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: id,
            text: "⚠️ 验证功能暂时不可用，请联系管理员检查配置"
        });
    }
}

// 正常态用户消息防线：敏感词与类型拦截器
async function handleVerifiedMsg(msg, u, env) {
    const id = u.user_id, text = msg.text || msg.caption || "";

    // 如果用户之前被标记为屏蔽 Bot，但现在能发消息，说明已解除屏蔽
    if (u.user_info && u.user_info.bot_blocked) {
        u.user_info.bot_blocked = false;
        delete u.user_info.bot_blocked_ts;
        await updUser(id, { user_info: u.user_info }, env);
        console.log(`Cleared bot_blocked mark for user ${id} after receiving message`);

        // 更新用户卡片显示
        try {
            if (u.topic_id && u.user_info.card_msg_id) {
                const mockTgUser = { id: id, username: u.user_info.username || "", first_name: u.user_info.name || "(未获取)", last_name: "" };
                const newMeta = getUMeta(mockTgUser, u, u.user_info.join_date || (Date.now()/1000));
                await api(env.BOT_TOKEN, "editMessageCaption", {
                    chat_id: env.ADMIN_GROUP_ID,
                    message_id: u.user_info.card_msg_id,
                    caption: newMeta.card,
                    parse_mode: "HTML",
                    reply_markup: getBtns(id, u.is_blocked, newMeta.username, u.is_muted)
                });
            }
        } catch (e) {
            console.log("Failed to update card after bot_blocked cleared:", e.message);
        }
    }

    // 敏感词屏蔽预检系统
    if (text) {
        const kws = await getJsonCfg('block_keywords', env);
        if ((Array.isArray(kws) ? kws : []).some(k => safeRegexTest(k, text))) {
            const c = u.block_count + 1, max = parseInt(await getCfg('block_threshold', env)) || 5;
            const willBlock = c >= max;
            await updUser(id, { block_count: c, is_blocked: willBlock }, env);
            if (willBlock) {
                await manageBlacklist(env, u, msg.from, true);
                return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 已封禁 (发送 /start 可申请解封)" });
            }
            return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `⚠️ 屏蔽词 (${c}/${max})` });
        }
    }

    // 负载类型过滤体系
    for (const t of MSG_TYPES) {
        if (t.check(msg)) {
            const isAdmin = await isAuthAdmin(id, env);
            if ((t.extra && !(await getBool(t.extra(msg), env)) && !isAdmin) ||
                (!t.extra && !(await getBool(t.key, env)) && !isAdmin)) {
                return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `⚠️ 不接收 ${t.name}` });
            }
            break;
        }
    }

    // 勿扰状态静默应答逻辑
    if (await getBool('busy_mode', env)) {
        const now = Date.now();
        if (now - (u.user_info.last_busy_reply || 0) > 300000) {
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "🌙 " + await getCfg('busy_msg', env) });
            await updUser(id, { user_info: { ...u.user_info, last_busy_reply: now } }, env);
        }
    }

    // 关键词自动回复钩子
    if (text) {
        const rules = await getJsonCfg('keyword_responses', env);
        const match = (Array.isArray(rules) ? rules : []).find(r => safeRegexTest(r?.keywords, text));
        if (match) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "自动回复：\n" + match.response });
    }

    // 所有前置校验通过，放行进入转发链路
    await relayToTopic(msg, u, env);
}

async function acquireTopicLock(env, uid) {
    const now = Date.now();
    const staleBefore = now - TOPIC_LOCK_TIMEOUT_MS;
    const result = await env.TG_BOT_DB.prepare(`
        UPDATE users
        SET topic_creating = 1, topic_lock_at = ?, updated_at = ?
        WHERE user_id = ?
          AND (topic_id IS NULL OR topic_id = '')
          AND (topic_creating = 0 OR topic_creating IS NULL OR topic_lock_at IS NULL OR topic_lock_at < ?)
    `).bind(now, Math.floor(now / 1000), uid, staleBefore).run();
    return Number(result.meta?.changes || 0) === 1;
}

async function releaseTopicLock(env, uid) {
    await sql(env, "UPDATE users SET topic_creating = 0, topic_lock_at = NULL, updated_at = ? WHERE user_id = ?", [Math.floor(Date.now() / 1000), uid]);
}

async function waitForExistingTopic(env, uid) {
    for (let i = 0; i < 6; i++) {
        await sleep(1000);
        const fresh = await getUser(uid, env);
        if (fresh.topic_id) return fresh.topic_id;
        if (!fresh.topic_creating) return null;
    }
    return null;
}

async function acquireCardLock(env, uid, tid) {
    const now = Date.now();
    const result = await env.TG_BOT_DB.prepare(`
        UPDATE users
        SET card_creating = 1, card_lock_at = ?
        WHERE user_id = ? AND topic_id = ?
          AND (card_creating = 0 OR card_creating IS NULL OR card_lock_at IS NULL OR card_lock_at < ?)
    `).bind(now, uid, tid, now - CARD_LOCK_TIMEOUT_MS).run();
    return Number(result.meta?.changes || 0) === 1 ? now : null;
}

async function releaseCardLock(env, uid, lockAt) {
    // 只释放自己取得的锁，过期请求不能释放后续请求的锁。
    await env.TG_BOT_DB.prepare(`UPDATE users SET card_creating = 0, card_lock_at = NULL
        WHERE user_id = ? AND card_lock_at = ?`).bind(uid, lockAt).run();
}

// --- 核心：消息转发与话题流控引擎 ---
async function relayToTopic(msg, u, env) {
    const uMeta = getUMeta(msg.from, u, msg.date), uid = u.user_id;
    let tid = u.topic_id;

    // 1. 动态检测并同步用户基础标识信息变更
    if (u.user_info.name !== uMeta.name || u.user_info.username !== uMeta.username) {
        await syncTopicProfile(u, msg.from, env);
    }

    // 2. 线程池资源申请：建立独立话题
    if (!tid) {
        if (CACHE.user_locks[uid]) {
            tid = await waitForExistingTopic(env, uid);
            if (!tid) return api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "系统忙，请稍后再试" });
        }
    }

    if (!tid) {
        CACHE.user_locks[uid] = true;
        let locked = false;
        try {
            const freshU = await getUser(uid, env);
            if (freshU.topic_id) tid = freshU.topic_id;
            else {
                locked = await acquireTopicLock(env, uid);
                if (!locked) {
                    tid = await waitForExistingTopic(env, uid);
                    if (!tid) return api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "系统忙，请稍后再试" });
                }
            }

            if (!tid) {
                const t = await api(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: uMeta.topicName });
                tid = t.message_thread_id.toString();
                u.user_info.card_msg_id = null;
                u.user_info.topic_name = uMeta.topicName;
                const dummy = await api(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_GROUP_ID, message_thread_id: tid, text: "✨ 正在加载用户资料...", disable_notification: true });
                u.user_info.dummy_msg_id = dummy.message_id;
                await updUser(uid, { topic_id: tid, topic_creating: false, topic_lock_at: null, user_info: u.user_info,
                    card_info: { card_msg_id: null, dummy_msg_id: dummy.message_id } }, env);
            }
        } catch (e) {
            console.error("Topic Creation Failed:", e);
            if (locked) await releaseTopicLock(env, uid).catch(() => {});
            return api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "系统忙，请稍后再试" });
        } finally {
            delete CACHE.user_locks[uid];
        }
    }

    try {
        // 资料卡片必须先落到话题里，后续用户消息才不会把卡片顶到下面。
        await ensureInfoCardBeforeRelay(env, u, msg.from, tid, msg.date);

        let forwardedMsg;
        const rawText = msg.text || "";
        let topicReplyToMsgId = undefined;
        if (msg.reply_to_message) {
            const ref = await sql(env, "SELECT topic_message_id FROM messages WHERE user_id=? AND message_id=?", [uid, msg.reply_to_message.message_id.toString()], 'first');
            if (ref?.topic_message_id) {
                topicReplyToMsgId = parseInt(ref.topic_message_id);
                console.log(`Found reply mapping: user_msg=${msg.reply_to_message.message_id} -> topic_msg=${topicReplyToMsgId}`);
            } else {
                console.log(`No reply mapping found for user_msg=${msg.reply_to_message.message_id}`);
            }
        }

        // 特殊引用语法降级渲染支持
        if (rawText && (rawText.startsWith('>') || rawText.startsWith('》') || rawText.startsWith('&gt;'))) {
            let cleanText = rawText.replace(/^[>》]\s?/, '').replace(/^&gt;\s?/, '');
            cleanText = escape(cleanText);

            const customHtml = `<blockquote>${cleanText}</blockquote>`;

            forwardedMsg = await api(env.BOT_TOKEN, "sendMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                message_thread_id: tid,
                text: customHtml,
                parse_mode: "HTML",
                reply_to_message_id: topicReplyToMsgId
            });
        } else {
            // 标准转发处理：统一使用 copyMessage 以支持引用关系
            try {
                const copyParams = {
                    chat_id: env.ADMIN_GROUP_ID,
                    from_chat_id: uid,
                    message_id: msg.message_id,
                    message_thread_id: tid
                };
                if (topicReplyToMsgId) {
                    copyParams.reply_to_message_id = topicReplyToMsgId;
                }
                forwardedMsg = await api(env.BOT_TOKEN, "copyMessage", copyParams);
            } catch(fwdErr) {
                console.log("copyMessage failed, trying forwardMessage:", fwdErr.message);
                // forwardMessage 不支持 reply_to_message_id，只能作为备选
                forwardedMsg = await api(env.BOT_TOKEN, "forwardMessage", {
                    chat_id: env.ADMIN_GROUP_ID,
                    from_chat_id: uid,
                    message_id: msg.message_id,
                    message_thread_id: tid
                });
            }
        }

        // ---------------------------------------------------------------------
        // * 修改点：注释/移除了面向用户的 “✅ 已送达” 反馈回执 API 调用。
        // 此动作去除了多余的底层 fetch() 开销。
        // 原逻辑: api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "✅ 已送达", ... }).catch(()=>{});
        // ---------------------------------------------------------------------

        // 构建映射关联池，支撑双向回复寻址
        if (forwardedMsg && forwardedMsg.message_id) {
            const storeText = msg.text || msg.caption || "[Media]";
            await sql(env, "INSERT OR REPLACE INTO messages (user_id, message_id, text, date, topic_message_id) VALUES (?,?,?,?,?)",
                [uid, msg.message_id.toString(), storeText, msg.date, forwardedMsg.message_id.toString()]);
        }

        // 下游归档链路：数据备份
        await handleBackup(msg, uMeta, env);

    } catch (e) {
        console.error("Relay Failed:", e);
        if (isTopicMissing(e)) {
            await updUser(uid, { topic_id: null, topic_creating: false, topic_lock_at: null }, env); u.topic_id = null; return relayToTopic(msg, u, env);
        } else {
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "❌ 发送失败，系统异常" });
        }
    }
}

async function ensureInfoCardBeforeRelay(env, u, tgUser, tid, date) {
    let lockAt = null;
    for (let i = 0; i < 13; i++) {
        lockAt = await acquireCardLock(env, u.user_id, tid);
        if (lockAt !== null) break;
        if (i < 12) await sleep(500);
    }
    if (lockAt === null) throw new Error("资料卡正在更新或话题已变更，请稍后再试");

    try {
        // 锁覆盖读取、编辑/创建及保存；所有入口共享同一生命周期。
        const fresh = await getUser(u.user_id, env);
        if (String(fresh.topic_id) !== String(tid)) throw new Error("资料卡话题已变更");
        Object.assign(u, fresh);
        const profile = tgUser || {
            id: u.user_id, username: u.user_info.username || "",
            first_name: u.user_info.name || "(未获取)", last_name: ""
        };
        const updated = await updateInfoCardInPlace(env, u, profile, date);
        if (updated === null) return null;
        if (!updated) {
            const joinDate = u.user_info.join_date || date || (Date.now() / 1000);
            const cardId = await sendInfoCardToTopic(env, u, profile, tid, joinDate);
            if (!cardId) throw new Error("资料卡创建失败");
            await updUser(u.user_id, { card_info: { card_msg_id: cardId, join_date: joinDate } }, env);
            u.user_info.card_msg_id = cardId;
            u.user_info.join_date = joinDate;
            // 先保存 ID 再置顶，避免置顶耗时或失败扩大重复创建窗口。
            await api(env.BOT_TOKEN, "pinChatMessage", {
                chat_id: env.ADMIN_GROUP_ID, message_id: cardId, message_thread_id: tid
            }).catch(() => {});
        }
        if (u.user_info.dummy_msg_id) {
            await api(env.BOT_TOKEN, "deleteMessage", {
                chat_id: env.ADMIN_GROUP_ID, message_id: u.user_info.dummy_msg_id
            }).catch(() => {});
            await updUser(u.user_id, { card_info: { dummy_msg_id: null } }, env);
            delete u.user_info.dummy_msg_id;
        }
        return u.user_info.card_msg_id;
    } finally {
        await releaseCardLock(env, u.user_id, lockAt);
    }
}

async function updateInfoCardInPlace(env, u, tgUser, date) {
    if (!u?.user_info?.card_msg_id) return false;
    const meta = getUMeta(tgUser, u, date || u.user_info.join_date || (Date.now() / 1000));
    const common = {
        chat_id: env.ADMIN_GROUP_ID,
        message_id: u.user_info.card_msg_id,
        parse_mode: "HTML",
        reply_markup: getBtns(u.user_id, u.is_blocked, meta.username, u.is_muted)
    };

    try {
        await api(env.BOT_TOKEN, "editMessageCaption", { ...common, caption: meta.card });
        return true;
    } catch (captionError) {
        if (isMessageNotModified(captionError)) return true;
        try {
            await api(env.BOT_TOKEN, "editMessageText", { ...common, text: meta.card });
            return true;
        } catch (textError) {
            if (isMessageNotModified(textError)) return true;
            // Recreate only when Telegram confirms the original card is gone.
            if (isMessageMissing(captionError) && isMessageMissing(textError)) return false;
            console.log("Update info card in place failed:", textError.message);
            return null;
        }
    }
}

// --- 核心：发送用户信息复合卡片 ---
async function sendInfoCardToTopic(env, u, tgUser, tid, date) {
    const meta = getUMeta(tgUser, u, date || (Date.now()/1000));
    // Telegram 发消息没有幂等键：超时/断网/5xx 时可能已发送，不盲目重试建卡。
    const sendCard = (method, body) => api(env.BOT_TOKEN, method, body, 0, false);
    let bestPhoto = null;

    // 1. [容错防护] 非阻塞尝试获取目标用户头像
    try {
        const photos = await api(env.BOT_TOKEN, "getUserProfilePhotos", { user_id: u.user_id, limit: 1 });
        if (photos && photos.photos && photos.photos.length > 0) {
            bestPhoto = photos.photos[0][photos.photos[0].length - 1].file_id;
        }
    } catch (e) {}

    try {
        let cardMsg;
        // 2. [边界防护] 校验配文长度防止超出 Telegram 1024字符图片 Caption 上限
        const isCaptionTooLong = meta.card.length > 1000;

        // 根据上下文存在性选择装配发送方式
        if (bestPhoto && !isCaptionTooLong) {
            try {
                cardMsg = await sendCard("sendPhoto", {
                    chat_id: env.ADMIN_GROUP_ID, message_thread_id: tid, photo: bestPhoto, caption: meta.card, parse_mode: "HTML", reply_markup: getBtns(u.user_id, u.is_blocked, meta.username, u.is_muted)
                });
            } catch (err) {
                if (err.message && (err.message.includes("parse") || err.message.includes("MEDIA"))) {
                    cardMsg = await sendCard("sendMessage", {
                        chat_id: env.ADMIN_GROUP_ID, message_thread_id: tid, text: meta.card, parse_mode: "HTML", reply_markup: getBtns(u.user_id, u.is_blocked, meta.username, u.is_muted)
                    });
                } else {
                    throw err;
                }
            }
        } else {
            cardMsg = await sendCard("sendMessage", {
                chat_id: env.ADMIN_GROUP_ID, message_thread_id: tid, text: meta.card, parse_mode: "HTML", reply_markup: getBtns(u.user_id, u.is_blocked, meta.username, u.is_muted)
            });
        }
        return cardMsg.message_id;
    } catch (e) {
        console.error("Send Info Card Failed:", e);
        if (e.message && (e.message.includes("thread") || e.message.includes("not found"))) {
            throw e;
        }
        return null;
    }
}

async function rebuildInfoCard(env, uid, topicId) {
    const u = await getUser(uid, env);
    const tid = topicId || u.topic_id;
    if (!tid || String(tid) !== String(u.topic_id)) return null;
    try {
        return await ensureInfoCardBeforeRelay(env, u, null, tid);
    } catch (error) {
        console.error("Refresh info card failed:", error);
        return null;
    }
}

async function refreshCardMarkup(env, uid) {
    const u = await getUser(uid, env);
    if (!u.user_info.card_msg_id) return;
    await api(env.BOT_TOKEN, "editMessageReplyMarkup", {
        chat_id: env.ADMIN_GROUP_ID,
        message_id: u.user_info.card_msg_id,
        reply_markup: getBtns(uid, u.is_blocked, u.user_info.username, u.is_muted)
    }).catch((error) => {
        if (!isMessageNotModified(error)) console.log("Refresh card markup failed:", error.message);
    });
}

async function setUserBlocked(env, uid, isBlocked) {
    const u = await getUser(uid, env);
    if (!isBlocked && u.user_info.bot_blocked) {
        u.user_info.bot_blocked = false;
        delete u.user_info.bot_blocked_ts;
    }
    await updUser(uid, { is_blocked: isBlocked, block_count: 0, user_info: u.user_info }, env);
    await refreshCardMarkup(env, uid);
}

// --- 5. 通用/黑名单 (管理黑名单控制域) ---
async function manageBlacklist(env, u, tgUser, isBlocking) {
    let bid = await getCfg('blocked_topic_id', env);
    if (!bid && isBlocking) {
        try {
            const t = await api(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: "🚫 黑名单" });
            bid = t.message_thread_id.toString();
            await setCfg('blocked_topic_id', bid, env);
        } catch { return; }
    }
    if (!bid) return;
    if (isBlocking) {
        const meta = getUMeta(tgUser, u, Date.now()/1000);
        const msg = await api(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID, message_thread_id: bid, text: `<b>🚫 用户已屏蔽</b>\n${meta.card}`, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "✅ 解除屏蔽", callback_data: `unblock:${u.user_id}` }]] }
        });
        await updUser(u.user_id, { user_info: { ...u.user_info, blacklist_msg_id: msg.message_id } }, env);
    } else {
        if (u.user_info.blacklist_msg_id) {
            try { await api(env.BOT_TOKEN, "deleteMessage", { chat_id: env.ADMIN_GROUP_ID, message_id: u.user_info.blacklist_msg_id }); } catch (e) { if(e.message && e.message.includes("thread")) await setCfg('blocked_topic_id', "", env); }
            await updUser(u.user_id, { user_info: { ...u.user_info, blacklist_msg_id: null } }, env);
        }
    }
}

// 下游归档链路：异步数据备份到冷频道
async function handleBackup(msg, meta, env) {
    const bid = await getCfg('backup_group_id', env);
    if (!bid) return;
    try {
        const header = `<b>📨 备份</b> ${meta.name} (${meta.userId})`;
        if (msg.text) await api(env.BOT_TOKEN, "sendMessage", { chat_id: bid, text: header + "\n" + escape(msg.text), parse_mode: "HTML" });
        else {
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: bid, text: header, parse_mode: "HTML" });
            await api(env.BOT_TOKEN, "copyMessage", { chat_id: bid, from_chat_id: msg.chat.id, message_id: msg.message_id });
        }
    } catch (e) {}
}

// --- 6. 管理员功能模块 (双向交互枢纽) ---
const withReplyTarget = (replyToMsgId) => {
    const id = parseInt(replyToMsgId);
    return Number.isFinite(id) ? { reply_to_message_id: id } : {};
};

const isReplyTargetError = (e) => {
    const msg = (e?.message || "").toLowerCase();
    const mentionsReply = msg.includes("reply") || msg.includes("replied");
    return mentionsReply && (msg.includes("not found") || msg.includes("invalid"));
};

const isEntityPayloadError = (e) => {
    const msg = (e?.message || "").toLowerCase();
    return msg.includes("entity") || msg.includes("entities") || msg.includes("parse");
};

const withoutReplyTarget = (body) => {
    const next = { ...body };
    delete next.reply_to_message_id;
    return next;
};

const withoutEntityPayload = (body) => {
    const next = { ...body };
    delete next.entities;
    delete next.caption_entities;
    return next;
};

async function apiWithDeliveryFallback(env, method, body) {
    try {
        return await api(env.BOT_TOKEN, method, body);
    } catch (firstErr) {
        const candidates = [];
        const hasReplyTarget = body.reply_to_message_id !== undefined;
        const hasEntityPayload = body.entities || body.caption_entities;

        if (hasReplyTarget && isReplyTargetError(firstErr)) {
            candidates.push({ body: withoutReplyTarget(body), reason: "reply target missing" });
            if (hasEntityPayload) candidates.push({ body: withoutEntityPayload(withoutReplyTarget(body)), reason: "reply target missing + entity fallback" });
        }
        if (hasEntityPayload && isEntityPayloadError(firstErr)) {
            candidates.push({ body: withoutEntityPayload(body), reason: "entity fallback" });
            if (hasReplyTarget) candidates.push({ body: withoutReplyTarget(withoutEntityPayload(body)), reason: "entity fallback + reply target removed" });
        }

        let lastErr = firstErr;
        for (const candidate of candidates) {
            try {
                console.warn(`Delivery fallback [${method}]: ${candidate.reason}`);
                return await api(env.BOT_TOKEN, method, candidate.body);
            } catch (candidateErr) {
                lastErr = candidateErr;
            }
        }
        throw lastErr;
    }
}

async function deliverAdminMessageToUser(msg, uid, replyToMsgId, env) {
    const reply = withReplyTarget(replyToMsgId);
    const base = { chat_id: uid, ...reply };

    if (msg.text) {
        const body = { ...base, text: msg.text };
        if (msg.entities) body.entities = msg.entities;
        return apiWithDeliveryFallback(env, "sendMessage", body);
    }

    if (msg.photo) {
        const body = { ...base, photo: msg.photo[msg.photo.length - 1].file_id };
        if (msg.caption) body.caption = msg.caption;
        if (msg.caption_entities) body.caption_entities = msg.caption_entities;
        return apiWithDeliveryFallback(env, "sendPhoto", body);
    }

    const mediaMap = [
        ["animation", "sendAnimation", "animation"],
        ["video", "sendVideo", "video"],
        ["document", "sendDocument", "document"],
        ["audio", "sendAudio", "audio"],
        ["voice", "sendVoice", "voice"],
        ["video_note", "sendVideoNote", "video_note"],
        ["sticker", "sendSticker", "sticker"]
    ];

    for (const [field, method, param] of mediaMap) {
        if (!msg[field]) continue;
        const body = { ...base, [param]: msg[field].file_id };
        if (msg.caption) body.caption = msg.caption;
        if (msg.caption_entities) body.caption_entities = msg.caption_entities;
        return apiWithDeliveryFallback(env, method, body);
    }

    if (msg.location) {
        return apiWithDeliveryFallback(env, "sendLocation", {
            ...base,
            latitude: msg.location.latitude,
            longitude: msg.location.longitude
        });
    }

    if (msg.contact) {
        return apiWithDeliveryFallback(env, "sendContact", {
            ...base,
            phone_number: msg.contact.phone_number,
            first_name: msg.contact.first_name,
            last_name: msg.contact.last_name || ""
        });
    }

    return apiWithDeliveryFallback(env, "copyMessage", {
        chat_id: uid,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id,
        ...reply
    });
}

async function handleAdminReply(msg, env) {
    if (!msg.message_thread_id || msg.from.is_bot || !(await isAuthAdmin(msg.from.id, env))) return;

    const stateStr = await getCfg(`admin_state:${msg.from.id}`, env);
    if (stateStr) {
        const state = safeParse(stateStr);
        if (state.action === 'input_note') {
            const targetUid = state.target;
            const u = await getUser(targetUid, env);
            if (msg.text === '/clear' || msg.text === '清除') delete u.user_info.note;
            else u.user_info.note = msg.text;
            const mockTgUser = { id: targetUid, username: u.user_info.username || "", first_name: u.user_info.name || "(未获取)", last_name: "" };
            const newMeta = getUMeta(mockTgUser, u, u.user_info.join_date || (Date.now()/1000));
            // 更新带有新附注的资料实体卡片
            if (u.topic_id && u.user_info.card_msg_id) {
                try {
                    await api(env.BOT_TOKEN, "editMessageCaption", { chat_id: env.ADMIN_GROUP_ID, message_id: u.user_info.card_msg_id, caption: newMeta.card, parse_mode: "HTML", reply_markup: getBtns(targetUid, u.is_blocked, newMeta.username, u.is_muted) });
                } catch (e) {
                    try { await api(env.BOT_TOKEN, "editMessageText", { chat_id: env.ADMIN_GROUP_ID, message_id: u.user_info.card_msg_id, text: newMeta.card, parse_mode: "HTML", reply_markup: getBtns(targetUid, u.is_blocked, newMeta.username, u.is_muted) }); } catch(e2) {}
                }
            }
            await updUser(targetUid, { user_info: u.user_info }, env);
            await deleteCfg(`admin_state:${msg.from.id}`, env);
            return api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: `✅ 备注已更新` });
        }
    }

    const topicIdStr = msg.message_thread_id.toString();
    console.log(`Admin reply debug: topic_id=${topicIdStr}, admin_msg_id=${msg.message_id}`);

    const userRef = await sql(env, "SELECT user_id FROM users WHERE topic_id = ?", topicIdStr, 'first');
    console.log(`Admin reply debug: userRef=`, userRef);

    const uid = userRef?.user_id;
    if (!uid) {
        console.error(`Admin reply failed: No user found for topic_id=${topicIdStr}`);
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: `❌ 系统错误：未找到关联的用户（topic_id=${topicIdStr}）`
        });
    }

    // 检查用户状态
    const u = await getUser(uid, env);
    console.log(`Admin reply debug: user_state=${u.user_state}, is_blocked=${u.is_blocked}`);

    if (u.is_blocked) {
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: `❌ 该用户已被屏蔽，无法发送消息`
        });
    }

    let replyToMsgId = undefined;
    if (msg.reply_to_message) {
        const ref = await sql(env, "SELECT message_id FROM messages WHERE topic_message_id = ?", msg.reply_to_message.message_id.toString(), 'first');
        if (ref) {
            replyToMsgId = ref.message_id;
            console.log(`Admin reply debug: Found reply mapping topic_msg=${msg.reply_to_message.message_id} -> user_msg=${replyToMsgId}`);
        } else {
            console.log(`Admin reply debug: No reply mapping found for topic_msg=${msg.reply_to_message.message_id}`);
        }
    }

    try {
        console.log(`Admin reply debug: Delivering message to uid=${uid}, replyToMsgId=${replyToMsgId}`);
        const sent = await deliverAdminMessageToUser(msg, uid, replyToMsgId, env);
        console.log(`Admin reply debug: Delivery success, sent.message_id=${sent?.message_id}`);
        if (sent && sent.message_id) {
            const storeText = msg.text || msg.caption || "[Admin Message]";
            await sql(env, "INSERT OR REPLACE INTO messages (user_id, message_id, text, date, topic_message_id) VALUES (?,?,?,?,?)",
                [uid, sent.message_id.toString(), storeText, msg.date || Math.floor(Date.now() / 1000), msg.message_id.toString()]);
        }
        // 此处为管理员端给用户下发消息的主逻辑。根据之前的版本，管理员侧发送成功后的回执代码也已经去除
    } catch (e) {
        console.error("Admin Delivery Failed:", e);
        console.error("Admin Delivery Failed - Error details:", {
            message: e.message,
            stack: e.stack,
            uid: uid,
            topicId: topicIdStr,
            replyToMsgId: replyToMsgId
        });

        // 检测用户是否屏蔽了 Bot
        const isBlocked = e.message && e.message.includes("bot was blocked by the user");

        if (isBlocked) {
            // 自动标记用户为屏蔽状态
            try {
                const u = await getUser(uid, env);
                if (!u.user_info.bot_blocked) {
                    u.user_info.bot_blocked = true;
                    u.user_info.bot_blocked_ts = Date.now();
                    await updUser(uid, { user_info: u.user_info }, env);
                    console.log(`Auto-marked user ${uid} as bot_blocked`);

                    // 更新用户卡片显示
                    if (u.topic_id && u.user_info.card_msg_id) {
                        const mockTgUser = { id: uid, username: u.user_info.username || "", first_name: u.user_info.name || "(未获取)", last_name: "" };
                        const newMeta = getUMeta(mockTgUser, u, u.user_info.join_date || (Date.now()/1000));
                        try {
                            await api(env.BOT_TOKEN, "editMessageCaption", {
                                chat_id: env.ADMIN_GROUP_ID,
                                message_id: u.user_info.card_msg_id,
                                caption: newMeta.card,
                                parse_mode: "HTML",
                                reply_markup: getBtns(uid, u.is_blocked, newMeta.username, u.is_muted)
                            });
                        } catch (editErr) {
                            console.log("Failed to update card after bot_blocked detection:", editErr.message);
                        }
                    }
                }
            } catch (markErr) {
                console.error("Failed to mark user as bot_blocked:", markErr);
            }

            await api(env.BOT_TOKEN, "sendMessage", {
                chat_id: msg.chat.id,
                message_thread_id: msg.message_thread_id,
                text: `⚠️ <b>用户已屏蔽 Bot</b>\n\n该用户已在 Telegram 中屏蔽了本机器人，无法接收消息。\n\n请通过其他方式联系用户，让其：\n1️⃣ 打开与机器人的聊天\n2️⃣ 解除屏蔽\n3️⃣ 重新发送 /start`,
                parse_mode: "HTML"
            });
        } else {
            await api(env.BOT_TOKEN, "sendMessage", {
                chat_id: msg.chat.id,
                message_thread_id: msg.message_thread_id,
                text: `❌ 内部投递失败：${e.message || "Unknown error"}\n\n调试信息：\n用户ID: ${uid}\n话题ID: ${topicIdStr}`
            });
        }
    }
}

async function handleEdit(msg, env) {
    const u = await getUser(msg.from.id.toString(), env);
    if (!u.topic_id) return;

    const old = await sql(env, "SELECT text FROM messages WHERE user_id=? AND message_id=?", [u.user_id, msg.message_id], 'first');
    const newTxt = msg.text || msg.caption || "[非文本]";

    const logText = `✏️ 消息修改\n前: ${escape(old?.text||"?")}\n后: ${escape(newTxt)}`;

    await api(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_GROUP_ID,
        message_thread_id: u.topic_id,
        text: logText,
        parse_mode: "HTML"
    });

    if (old) {
        await sql(env, "UPDATE messages SET text=? WHERE user_id=? AND message_id=?", [newTxt, u.user_id, msg.message_id]);
    }
}

// --- 7. Web验证外设接口组件 ---
async function handleVerifyPage(url, env) {
    const uid = url.searchParams.get('user_id');
    const nonce = url.searchParams.get('nonce') || "";
    const mode = await getCfg('captcha_mode', env);
    const siteKey = mode === 'recaptcha' ? env.RECAPTCHA_SITE_KEY : env.TURNSTILE_SITE_KEY;
    if (!uid || !siteKey) return new Response("Miss Config (Check Mode/Key)", { status: 400 });
    const scriptUrl = mode === 'recaptcha' ? "https://www.google.com/recaptcha/api.js" : "https://challenges.cloudflare.com/turnstile/v0/api.js";
    const divClass = mode === 'recaptcha' ? "g-recaptcha" : "cf-turnstile";
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://telegram.org/js/telegram-web-app.js"></script><script src="${scriptUrl}" async defer></script><style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#fff;font-family:sans-serif}#c{text-align:center;padding:20px;background:#f0f0f0;border-radius:10px}</style></head><body><div id="c"><h3>🛡️ 安全验证</h3><div class="${divClass}" data-sitekey="${escape(siteKey)}" data-callback="S"></div><div id="m"></div></div><script>const tg=window.Telegram.WebApp;tg.ready();const UI_USER_ID=${JSON.stringify(uid)};const UI_NONCE=${JSON.stringify(nonce)};function S(t){document.getElementById('m').innerText='验证中...';fetch('/submit_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,userId:UI_USER_ID,nonce:UI_NONCE,initData:tg.initData||''})}).then(r=>r.json()).then(d=>{if(d.success){document.getElementById('m').innerText='✅';setTimeout(()=>{tg.close();window.close();},1000)}else{document.getElementById('m').innerText='❌'}}).catch(e=>{document.getElementById('m').innerText='Error'})}</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function handleTokenSubmit(req, env) {
    try {
        const { token, userId, nonce, initData } = await req.json();
        const parsed = await verifyTelegramInitData(initData || "", env.BOT_TOKEN, 600);
        const verifiedUserId = parsed?.userId?.toString();
        if (!verifiedUserId || (userId && userId.toString() !== verifiedUserId)) throw new Error("Invalid Telegram initData");
        const user = await getUser(verifiedUserId, env);
        if (user.is_blocked && !(await isAuthAdmin(verifiedUserId, env))) throw new Error("Blocked user");
        if (!nonce || user.user_info.verify_nonce !== nonce || Date.now() - (user.user_info.verify_nonce_ts || 0) > 15 * 60 * 1000) {
            throw new Error("Invalid verification nonce");
        }
        const mode = await getCfg('captcha_mode', env);
        let success = false;
        const verifyUrl = mode === 'recaptcha' ? 'https://www.google.com/recaptcha/api/siteverify' : 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const params = mode === 'recaptcha' ? new URLSearchParams({ secret: env.RECAPTCHA_SECRET_KEY, response: token }) : JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token });
        const headers = mode === 'recaptcha' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { 'Content-Type': 'application/json' };
        const r = await fetch(verifyUrl, { method: 'POST', headers, body: params });
        const d = await r.json();
        success = d.success;
        if (!success) throw new Error("Invalid Token");

        if (await getBool('enable_qa_verify', env)) {
            await updUser(verifiedUserId, { user_state: "pending_verification", user_info: { ...user.user_info, verify_nonce: "", verify_nonce_ts: 0 } }, env);
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: verifiedUserId, text: "✅ 验证通过！\n请回答：\n" + await getCfg('verif_q', env) });
        } else {
            await updUser(verifiedUserId, { user_state: "verified", user_info: { ...user.user_info, verify_nonce: "", verify_nonce_ts: 0 } }, env);
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: verifiedUserId, text: "✅ 验证通过！\n现在您可以直接发送消息，我会帮您转达给管理员。" });
        }
        return new Response(JSON.stringify({ success: true }));
    } catch (e) {
        console.error("Token Submit Failed:", e);
        return new Response(JSON.stringify({ success: false }), { status: 400 });
    }
}

async function verifyAnswer(id, ans, env) {
    if (ans.trim() === (await getCfg('verif_a', env)).trim()) {
        await updUser(id, { user_state: "verified" }, env);
        return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "✅ 验证通过！\n现在您可以直接发送消息，我会帮您转达给管理员。" });
    } else return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 错误" });
}

// --- 8. 菜单回调调度控制室 ---
async function handleCallback(cb, env) {
    const { data, message: msg, from } = cb;
    const [act, p1, p2, p3] = data.split(':');

    if (act === 'note' && p1 === 'set') {
        if (!msg || msg.chat.id.toString() !== env.ADMIN_GROUP_ID || !(await isAuthAdmin(from.id, env))) {
            return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无操作权限", show_alert: true });
        }
        try {
            await setCfg(`admin_state:${from.id}`, JSON.stringify({ action: 'input_note', target: p2 }), env);
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "⌨️ 请回复备注内容 (回复 /clear 清除):" });
            return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "请直接回复备注内容" });
        } catch (e) {
            console.error("Set Note State Failed:", e);
            await deleteCfg(`admin_state:${from.id}`, env).catch(() => {});
            return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "操作失败，请重试", show_alert: true });
        }
    }

    if (act === 'config') {
        if (!(await isPrimaryAdmin(from.id, env))) return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无操作权限", show_alert: true });

        if (p1 === 'rotate_mode') {
            const currentMode = await getCfg('captcha_mode', env);
            const isEnabled = await getBool('enable_verify', env);
            let nextMode = 'turnstile'; let nextEnable = 'true'; let toast = "已切换: Cloudflare";
            if (isEnabled) {
                if (currentMode === 'turnstile') { nextMode = 'recaptcha'; toast = "已切换: Google Recaptcha"; }
                else { nextEnable = 'false'; nextMode = currentMode; toast = "验证码功能已关闭"; }
            } else { nextMode = 'turnstile'; nextEnable = 'true'; toast = "已切换: Cloudflare"; }
            await setCfg('captcha_mode', nextMode, env); await setCfg('enable_verify', nextEnable, env);
            await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: toast });
            return handleAdminConfig(msg.chat.id, msg.message_id, 'menu', 'base', null, env);
        }
        await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
        return handleAdminConfig(msg.chat.id, msg.message_id, p1, p2, p3, env);
    }

    if (msg && msg.chat.id.toString() === env.ADMIN_GROUP_ID) {
        if (!(await isAuthAdmin(from.id, env))) {
            return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无操作权限", show_alert: true });
        }
        await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
        if (act === 'pin_card') await api(env.BOT_TOKEN, "pinChatMessage", { chat_id: msg.chat.id, message_id: msg.message_id, message_thread_id: msg.message_thread_id });
        else if (act === 'refresh_card') {
            const cardId = await rebuildInfoCard(env, p1, msg.message_thread_id?.toString());
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: cardId ? "✅ 资料卡已刷新" : "❌ 资料卡刷新失败" });
        }
        else if (['mute','unmute'].includes(act)) {
            const muted = act === 'mute';
            const uid = p1;
            await updUser(uid, { is_muted: muted }, env);
            await refreshCardMarkup(env, uid);
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: muted ? "🔕 已静音" : "🔔 已取消静音" });
        }
        else if (['block','unblock'].includes(act)) {
            const isB = act === 'block'; const uid = p1;
            await setUserBlocked(env, uid, isB);
            const fresh = await getUser(uid, env);
            await manageBlacklist(env, fresh, { id: uid, username: fresh.user_info.username, first_name: fresh.user_info.name }, isB);
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: isB ? "❌ 已屏蔽" : "✅ 已解封" });
        }
    }
}

// --- 9. 管理控制后台面板渲染 ---
async function handleAdminConfig(cid, mid, type, key, val, env) {
    const render = (txt, kb) => api(env.BOT_TOKEN, mid?"editMessageText":"sendMessage", { chat_id: cid, message_id: mid, text: txt, parse_mode: "HTML", reply_markup: kb });
    const back = { text: "🔙 返回", callback_data: "config:menu" };
    try {
        if (!type || type === 'menu') {
            if (!key) return render("⚙️ <b>控制面板</b>", { inline_keyboard: [[{text:"📝 基础",callback_data:"config:menu:base"},{text:"🤖 自动回复",callback_data:"config:menu:ar"}], [{text:"🚫 屏蔽词",callback_data:"config:menu:kw"},{text:"🛠 过滤",callback_data:"config:menu:fl"}], [{text:"👮 协管",callback_data:"config:menu:auth"},{text:"💾 备份/通知",callback_data:"config:menu:bak"}], [{text:"🌙 营业状态",callback_data:"config:menu:busy"}]] });
            if (key === 'base') {
                const mode = await getCfg('captcha_mode', env); const captchaOn = await getBool('enable_verify', env); const qaOn = await getBool('enable_qa_verify', env);
                let statusText = "❌ 已关闭"; if (captchaOn) statusText = mode === 'recaptcha' ? "Google" : "Cloudflare";
                return render(`基础配置\n验证码模式: ${statusText}\n问题验证: ${qaOn?"✅":"❌"}`, { inline_keyboard: [[{text:"欢迎语",callback_data:"config:edit:welcome_msg"},{text:"问题",callback_data:"config:edit:verif_q"},{text:"答案",callback_data:"config:edit:verif_a"}], [{text: `验证码模式: ${statusText} (点击切换)`, callback_data:`config:rotate_mode`}], [{text: `问题验证: ${qaOn?"✅ 开启":"❌ 关闭"}`, callback_data:`config:toggle:enable_qa_verify:${!qaOn}`}], [back]] });
            }
            if (key === 'fl') return render("🛠 <b>过滤设置</b>", await getFilterKB(env));
            if (['ar','kw','auth'].includes(key)) return render(`列表: ${key}`, await getListKB(key, env, Number(val || 0)));
            if (key === 'bak') {
                const bid = await getCfg('backup_group_id', env), blk = await getCfg('blocked_topic_id', env);
                return render(`💾 <b>备份与通知</b>\n备份群: ${bid||"无"}\n黑名单话题: ${blk?`✅ (${blk})`:"⏳"}`, { inline_keyboard: [[{text:"设备份群",callback_data:"config:edit:backup_group_id"},{text:"清备份",callback_data:"config:cl:backup_group_id"}],[{text:"重置黑名单",callback_data:"config:cl:blocked_topic_id"}],[back]] });
            }
            if (key === 'busy') {
                const on = await getBool('busy_mode', env), msg = await getCfg('busy_msg', env);
                return render(`🌙 <b>营业状态</b>\n当前: ${on?"🔴 休息中":"🟢 营业中"}\n回复语: ${escape(msg)}`, { inline_keyboard: [[{text:`切换为 ${on?"🟢 营业":"🔴 休息"}`,callback_data:`config:toggle:busy_mode:${!on}`}], [{text:"✏️ 修改回复语",callback_data:"config:edit:busy_msg"}], [back]] });
            }
        }
        if (type === 'toggle') { await setCfg(key, val, env); return key==='busy_mode' ? handleAdminConfig(cid,mid,'menu','busy',null,env) : (key==='enable_qa_verify' ? handleAdminConfig(cid,mid,'menu','base',null,env) : render("🛠 <b>过滤设置</b>", await getFilterKB(env))); }
        if (type === 'cl') { await setCfg(key, key==='authorized_admins'?'[]':'', env); return handleAdminConfig(cid, mid, 'menu', key==='blocked_topic_id'?'bak':(key==='authorized_admins'?'auth':'bak'), null, env); }
        if (type === 'del') {
            const realK = key==='kw'?'block_keywords':(key==='auth'?'authorized_admins':'keyword_responses');
            let l = await getJsonCfg(realK, env);
            if (key === 'ar') l = l.filter(i => (i.id || "").toString() !== val);
            else {
                const index = Number(val);
                l = Number.isInteger(index) ? l.filter((_, i) => i !== index) : l.filter(i => (i.id||i).toString() !== val);
            }
            await setCfg(realK, JSON.stringify(l), env);
            return render(`列表: ${key}`, await getListKB(key, env));
        }
        if (type === 'edit' || type === 'add') {
            await setCfg(`admin_state:${cid}`, JSON.stringify({ action: 'input', key: key + (type==='add'?'_add':'') }), env);
            let promptText = `请输入 ${key} 的值 (/cancel 取消):`;
            if (key === 'ar' && type === 'add') promptText = `请输入自动回复规则，格式：\n<b>关键词===回复内容</b>\n\n例如：价格===请联系人工客服\n(/cancel 取消)`;
            if (key === 'welcome_msg') promptText = `请发送新的欢迎语 (/cancel 取消):\n\n• 支持 <b>文字</b> 或 <b>图片/视频/GIF</b>\n• 支持占位符: {name}\n• 直接发送媒体即可`;
            return api(env.BOT_TOKEN, "editMessageText", { chat_id: cid, message_id: mid, text: promptText, parse_mode: "HTML" });
        }
    } catch (e) {
        console.error("Admin Config Failed:", e);
        await deleteCfg(`admin_state:${cid}`, env).catch(() => {});
        return api(env.BOT_TOKEN, "sendMessage", { chat_id: cid, text: "❌ 面板加载失败，请稍后重试" });
    }
}

async function getFilterKB(env) {
    const s = async k => (await getBool(k, env)) ? "✅" : "❌";
    const b = (t, k, v) => ({ text: `${t} ${v}`, callback_data: `config:toggle:${k}:${v==="❌"}` });
    const keys = ['enable_admin_receipt', 'enable_forward_forwarding', 'enable_image_forwarding', 'enable_audio_forwarding', 'enable_sticker_forwarding', 'enable_link_forwarding', 'enable_channel_forwarding', 'enable_text_forwarding'];
    const vals = await Promise.all(keys.map(k => s(k)));
    return { inline_keyboard: [[b("回执", keys[0], vals[0]), b("转发", keys[1], vals[1])], [b("媒体", keys[2], vals[2]), b("语音", keys[3], vals[3])], [b("贴纸", keys[4], vals[4]), b("链接", keys[5], vals[5])], [b("频道", keys[6], vals[6]), b("文本", keys[7], vals[7])], [{ text: "🔙 返回", callback_data: "config:menu" }]] };
}

async function getListKB(type, env, page = 0) {
    const k = type==='ar'?'keyword_responses':(type==='kw'?'block_keywords':'authorized_admins');
    const l = await getJsonCfg(k, env);
    const list = Array.isArray(l) ? l : [];
    const totalPages = Math.max(1, Math.ceil(list.length / RULE_PAGE_SIZE));
    const currentPage = Math.min(Math.max(Math.floor(page) || 0, 0), totalPages - 1);
    const start = currentPage * RULE_PAGE_SIZE;
    const pageItems = list.slice(start, start + RULE_PAGE_SIZE);
    const btns = pageItems.map((i, idx) => {
        const absoluteIndex = start + idx;
        const label = type === 'ar' ? i.keywords : i;
        const preview = Array.from(String(label || "")).slice(0, 24).join("");
        const deleteKey = type === 'ar' ? (i.id || absoluteIndex) : absoluteIndex;
        return [{ text: `🗑 ${absoluteIndex + 1}. ${preview}`, callback_data: `config:del:${type}:${deleteKey}` }];
    });
    const nav = [];
    if (currentPage > 0) nav.push({ text: "⬅️ 上一页", callback_data: `config:menu:${type}:${currentPage - 1}` });
    if (currentPage < totalPages - 1) nav.push({ text: "下一页 ➡️", callback_data: `config:menu:${type}:${currentPage + 1}` });
    if (nav.length) btns.push(nav);
    btns.push([{ text: "➕ 添加", callback_data: `config:add:${type}` }], [{ text: "🔙 返回", callback_data: "config:menu" }]);
    return { inline_keyboard: btns };
}

async function handleAdminInput(id, msg, state, env) {
    const txt = msg.text || "";
    if (txt === '/cancel') { await deleteCfg(`admin_state:${id}`, env); return handleAdminConfig(id, null, 'menu', null, null, env); }
    let k = state.key, val = txt;
    try {
        if (k === 'welcome_msg') {
            if (msg.photo || msg.video || msg.animation) {
                let fileId, type;
                if (msg.photo) { type = 'photo'; fileId = msg.photo[msg.photo.length - 1].file_id; }
                else if (msg.video) { type = 'video'; fileId = msg.video.file_id; }
                else if (msg.animation) { type = 'animation'; fileId = msg.animation.file_id; }
                val = JSON.stringify({ type: type, file_id: fileId, caption: msg.caption || "" });
            } else { val = txt; }
        }
        else if (k.endsWith('_add')) {
            k = k.replace('_add', ''); const realK = k==='ar'?'keyword_responses':(k==='kw'?'block_keywords':'authorized_admins'); const list = await getJsonCfg(realK, env);
            if (k === 'ar') { const [kk, rr] = txt.split('==='); if(kk && rr) list.push({keywords:kk, response:rr, id:Date.now()}); else return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 格式识别异常，请使用：关键词===回复内容" }); }
            else list.push(txt);
            val = JSON.stringify(list); k = realK;
        } else if (k === 'authorized_admins') { val = JSON.stringify(txt.split(/[,，]/).map(s => s.trim()).filter(Boolean)); }
        await setCfg(k, val, env); await deleteCfg(`admin_state:${id}`, env);
        const displayVal = (val.startsWith('{') && k === 'welcome_msg') ? "[媒体配置组合]" : val.substring(0,100);
        await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `✅ ${k} 规则已写入:\n${displayVal}` });
        await handleAdminConfig(id, null, 'menu', null, null, env);
    } catch (e) { await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `❌ 指令提交受阻: ${e.message}` }); }
}

// --- 10. 工具函数池 (Pure Functions) ---
const getBool = async (k, e) => (await getCfg(k, e)) === 'true';
const getJsonCfg = async (k, e) => safeParse(await getCfg(k, e), []);
const escape = t => (t||"").toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function parseIdsToSet(str) {
    return new Set((str || "").toString().split(/[,，]/).map(s => s.trim()).filter(Boolean));
}

async function getAdminSets(env) {
    const now = Date.now();
    if (CACHE.admin.ts && now - CACHE.admin.ts < CACHE.admin.ttl) return CACHE.admin;

    const primary = parseIdsToSet(env.ADMIN_IDS || "");
    const authList = await getJsonCfg('authorized_admins', env);
    const auth = new Set([...primary, ...((Array.isArray(authList) ? authList : []).map(x => x.toString()))]);
    CACHE.admin = { ts: now, ttl: CACHE.admin.ttl, primary, auth };
    return CACHE.admin;
}

const isPrimaryAdmin = async (id, e) => (await getAdminSets(e)).primary.has(id.toString());
const isAuthAdmin = async (id, e) => (await getAdminSets(e)).auth.has(id.toString());

function parseDelCommand(raw) {
    const s = (raw || "").trim().toLowerCase();
    if (!s.startsWith("/del")) return null;
    const cmd = s.split(/\s+/, 2)[0];
    if (!/^\/del(@[a-z0-9_]+)?$/i.test(cmd)) return null;
    const rest = s.slice(cmd.length).trim();
    if (!rest) return { type: "single" };
    if (rest === "all") return { type: "all" };
    if (/^\d+$/.test(rest)) {
        const count = parseInt(rest, 10);
        return count > 0 && count <= MAX_BATCH_DELETE ? { type: "count", count } : { type: "invalid" };
    }
    return { type: "invalid" };
}

function parseAdminCommand(raw) {
    const s = (raw || "").trim();
    const match = s.match(/^\/(ban|unban|card|terminate)(?:@[a-z0-9_]+)?(?:\s+(-?\d+))?\s*$/i);
    return match ? { command: match[1].toLowerCase(), arg: match[2] || "" } : null;
}

function safeRegexTest(pattern, text) {
    try {
        if (!pattern || typeof pattern !== "string") return false;
        const p = pattern.trim();
        if (!p || p.length > REGEX_MAX_PATTERN_LEN) return false;
        if (REGEX_REJECT_PATTERNS.some(re => re.test(p))) return false;
        const t = (text || "").toString();
        return new RegExp(p, 'gi').test(t.length > REGEX_MAX_TEXT_LEN ? t.slice(0, REGEX_MAX_TEXT_LEN) : t);
    } catch {
        return false;
    }
}

function isMessageNotModified(error) {
    return String(error?.message || "").toLowerCase().includes("message is not modified");
}

function isMessageMissing(error) {
    const message = String(error?.message || "").toLowerCase();
    return message.includes("message to edit not found");
}

function isTopicMissing(error) {
    return /message thread not found|message_thread_invalid|topic_deleted/i.test(String(error?.message || ""));
}

function isTelegramWebhook(req, env) {
    const secret = (env.TELEGRAM_WEBHOOK_SECRET || "").toString();
    if (!secret) return true;
    const header = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    return timingSafeEqualStr(header, secret);
}

function timingSafeEqualStr(a, b) {
    const aa = (a || "").toString();
    const bb = (b || "").toString();
    let out = aa.length ^ bb.length;
    const len = Math.max(aa.length, bb.length);
    for (let i = 0; i < len; i++) out |= (aa.charCodeAt(i) || 0) ^ (bb.charCodeAt(i) || 0);
    return out === 0;
}

function genNonce(bytes = 24) {
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmacSha256(key, data) {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey("raw", key instanceof Uint8Array ? key : enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data)));
}

function hex(bytes) {
    return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTelegramInitData(initData, botToken, maxAgeSec = 600) {
    if (!initData || !botToken) return null;
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash") || "";
    if (!receivedHash) return null;
    params.delete("hash");

    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate || Math.abs(Math.floor(Date.now() / 1000) - authDate) > maxAgeSec) return null;

    const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = await hmacSha256("WebAppData", botToken);
    const calcHash = hex(await hmacSha256(secret, checkString));
    if (!timingSafeEqualStr(calcHash, receivedHash)) return null;

    const user = safeParse(params.get("user"), null);
    return user?.id ? { userId: user.id.toString(), user } : null;
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// HTML `<a>` 标签组装逻辑：穿透安全审查拦截，对无用户名账号建立伪链接
const getUMeta = (tgUser, dbUser, d) => {
    const id = tgUser.id.toString();
    const firstName = tgUser.first_name || "";
    const lastName = tgUser.last_name || "";
    let name = (firstName + " " + lastName).trim();
    if (!name) name = "未命名匿名用户";

    // 文本级伪链接构建协议
    const safeName = `<a href="tg://user?id=${id}"><b>${escape(name)}</b></a>`;
    const note = dbUser.user_info && dbUser.user_info.note ? `\n📝 <b>附加备注:</b> ${escape(dbUser.user_info.note)}` : "";
    const labelDisplay = tgUser.username ? `@${tgUser.username}` : "未设公开ID";
    const timeStr = new Date(d*1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

    // 检测并显示屏蔽状态
    let blockStatus = "";
    if (dbUser.is_blocked) {
        blockStatus = `\n🚫 <b>管理员屏蔽:</b> 是`;
    }
    if (dbUser.user_info && dbUser.user_info.bot_blocked) {
        const blockTime = new Date(dbUser.user_info.bot_blocked_ts || d*1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        blockStatus += `\n⛔ <b>用户屏蔽Bot:</b> 是 (${blockTime})`;
    }

    return {
        userId: id,
        name,
        username: tgUser.username,
        topicName: name.substring(0, 128),
        card: `<b>🪪 用户身份卡片</b>\n---\n👤: ${safeName}\n🏷️: ${labelDisplay}\n🆔: <code>${id}</code>${note}${blockStatus}\n🕒: <code>${timeStr}</code>`
    };
};

async function syncTopicProfile(u, tgUser, env) {
    const meta = getUMeta(tgUser, u, Date.now() / 1000);
    const nextInfo = { ...(u.user_info || {}) };
    let dirty = false;

    if (nextInfo.name !== meta.name) {
        nextInfo.name = meta.name;
        dirty = true;
    }
    if (nextInfo.username !== meta.username) {
        nextInfo.username = meta.username;
        dirty = true;
    }

    if (u.topic_id && meta.topicName && nextInfo.topic_name !== meta.topicName) {
        await api(env.BOT_TOKEN, "editForumTopic", {
            chat_id: env.ADMIN_GROUP_ID,
            message_thread_id: u.topic_id,
            name: meta.topicName
        }).catch(() => {});
        nextInfo.topic_name = meta.topicName;
        dirty = true;
    }

    if (dirty) {
        u.user_info = nextInfo;
        await updUser(u.user_id, { user_info: nextInfo }, env);
    }

    return meta;
}

// 动态键盘矩阵构建：受限 API 规避检查点
const getBtns = (id, blk, username, muted = false) => {
    const btns = [];

    // username 条件控制路由：缺少公开标识符强制屏蔽按钮注册
    if (username) {
        btns.push([{ text: "👤 访问个人主页", url: `https://t.me/${username}` }]);
    }

    btns.push([{ text: blk ? "✅ 执行解封" : "🚫 执行屏蔽", callback_data: `${blk ? 'unblock' : 'block'}:${id}` }]);
    btns.push([{ text: muted ? "🔔 取消静音" : "🔕 静音", callback_data: `${muted ? 'unmute' : 'mute'}:${id}` }, { text: "🔄 刷新资料卡", callback_data: `refresh_card:${id}` }]);
    btns.push([{ text: "✏️ 录入备注", callback_data: `note:set:${id}` }, { text: "📌 提升置顶", callback_data: `pin_card:${id}` }]);

    return { inline_keyboard: btns };
};
