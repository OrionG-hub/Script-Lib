/**
 * Telegram Bot Worker v3.66 (Card Delivery Fixed)
 * 完整功能版：保留所有备份、配置面板、辅助函数
 * * 修复内容:
 * 1. [Critical] 修复用户隐私设置导致获取头像失败从而无法发送资料卡片的 Bug
 * 2. [Critical] 修复卡片发送失败时无法感知话题失效的问题
 * 3. [Feature] 检测到无卡片记录时（如之前发送失败），新消息自动触发补发
 * 4. [Feature] 用户更名后自动更新数据库及话题名称
 */

// --- 1. 静态配置与常量 ---
const CACHE = { data: {}, ts: 0, ttl: 60000, user_locks: {}, warn_cd: {} };

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
    enable_admin_receipt: "true",

    // 转发类型开关
    enable_image_forwarding: "true", enable_link_forwarding: "true", enable_text_forwarding: "true",
    enable_channel_forwarding: "true", enable_forward_forwarding: "true", enable_audio_forwarding: "true", enable_sticker_forwarding: "true",

    // 话题与列表
    backup_group_id: "", blocked_topic_id: "",
    busy_mode: "false", busy_msg: "当前是非营业时间，消息已收到，管理员稍后回复。",
    block_keywords: "[]", keyword_responses: "[]", authorized_admins: "[]"
};

const MSG_TYPES = [
    { check: m => m.forward_from || m.forward_from_chat, key: 'enable_forward_forwarding', name: "转发消息", extra: m => m.forward_from_chat?.type === 'channel' ? 'enable_channel_forwarding' : null },
    { check: m => m.audio || m.voice, key: 'enable_audio_forwarding', name: "语音/音频" },
    { check: m => m.sticker || m.animation, key: 'enable_sticker_forwarding', name: "贴纸/GIF" },
    { check: m => m.photo || m.video || m.document, key: 'enable_image_forwarding', name: "媒体文件" },
    { check: m => (m.entities||[]).some(e => ['url','text_link'].includes(e.type)), key: 'enable_link_forwarding', name: "链接" },
    { check: m => m.text, key: 'enable_text_forwarding', name: "纯文本" }
];

// --- 2. 核心入口 (Entry Point) ---
export default {
    async fetch(req, env, ctx) {
        ctx.waitUntil(dbInit(env).catch(err => console.error("DB Init Failed:", err)));
        const url = new URL(req.url);

        try {
            if (req.method === "GET") {
                if (url.pathname === "/verify") return handleVerifyPage(url, env);
                if (url.pathname === "/") return new Response("Bot v3.66 Active", { status: 200 });
            }
            if (req.method === "POST") {
                if (url.pathname === "/submit_token") return handleTokenSubmit(req, env);
                try {
                    const update = await req.json();
                    ctx.waitUntil(handleUpdate(update, env, ctx));
                    return new Response("OK");
                } catch (jsonErr) {
                    console.error("Invalid JSON Update:", jsonErr);
                    return new Response("Bad Request", { status: 400 });
                }
            }
        } catch (e) {
            console.error("Critical Worker Error:", e);
            return new Response("Internal Server Error", { status: 500 });
        }
        return new Response("404 Not Found", { status: 404 });
    }
};

// --- 3. 数据库与工具函数 ---
const safeParse = (str, fallback = {}) => {
    if (!str) return fallback;
    try { return JSON.parse(str); }
    catch (e) { console.error("JSON Parse Error:", e); return fallback; }
};

const sql = async (env, query, args = [], type = 'run') => {
    try {
        const stmt = env.TG_BOT_DB.prepare(query).bind(...(Array.isArray(args) ? args : [args]));
        return type === 'run' ? await stmt.run() : await stmt[type]();
    } catch (e) {
        console.error(`SQL Error [${query}]:`, e);
        return null;
    }
};

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

async function setCfg(key, val, env) {
    await sql(env, "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, val]);
    CACHE.ts = 0;
}

async function getUser(id, env) {
    let u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, 'first');
    if (!u) {
        try { await sql(env, "INSERT OR IGNORE INTO users (user_id, user_state) VALUES (?, 'new')", id); } catch {}
        u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, 'first');
    }
    if (!u) u = { user_id: id, user_state: 'new', is_blocked: 0, block_count: 0, first_message_sent: 0, topic_id: null, user_info_json: "{}" };

    u.is_blocked = !!u.is_blocked;
    u.first_message_sent = !!u.first_message_sent;
    u.user_info = safeParse(u.user_info_json);
    return u;
}

async function updUser(id, data, env) {
    if (data.user_info) {
        data.user_info_json = JSON.stringify(data.user_info);
        delete data.user_info;
    }
    const keys = Object.keys(data);
    if (!keys.length) return;
    const query = `UPDATE users SET ${keys.map(k => `${k}=?`).join(',')} WHERE user_id=?`;
    const values = [...keys.map(k => typeof data[k] === 'boolean' ? (data[k]?1:0) : data[k]), id];
    await sql(env, query, values);
}

async function dbInit(env) {
    if (!env.TG_BOT_DB) return;
    await env.TG_BOT_DB.batch([
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`),
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, user_state TEXT DEFAULT 'new', is_blocked INTEGER DEFAULT 0, block_count INTEGER DEFAULT 0, first_message_sent INTEGER DEFAULT 0, topic_id TEXT, user_info_json TEXT)`),
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS messages (user_id TEXT, message_id TEXT, text TEXT, date INTEGER, PRIMARY KEY (user_id, message_id))`)
    ]);
    try { await sql(env, "ALTER TABLE messages ADD COLUMN topic_message_id TEXT"); } catch (e) {}
}

// --- 4. 业务逻辑 (核心流) ---

async function api(token, method, body) {
    try {
        const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        const d = await r.json();
        if (!d.ok) { console.warn(`TG API Error [${method}]:`, d.description); throw new Error(d.description); }
        return d.result;
    } catch (e) { throw e; }
}

async function registerCommands(env) {
    try {
        await api(env.BOT_TOKEN, "deleteMyCommands", { scope: { type: "default" } });
        await api(env.BOT_TOKEN, "setMyCommands", { commands: [{ command: "start", description: "开始 / Start" }], scope: { type: "default" } });
        const list = [...(env.ADMIN_IDS||"").split(/[,，]/), ...(safeParse(await getCfg('authorized_admins', env), []))];
        const admins = [...new Set(list.map(i=>i.trim()).filter(Boolean))];
        for (const id of admins) await api(env.BOT_TOKEN, "setMyCommands", { commands: [{ command: "start", description: "⚙️ 管理面板" }, { command: "help", description: "📄 帮助说明" }], scope: { type: "chat", chat_id: id } });
    } catch (e) { console.error("Register Commands Failed:", e); }
}

async function handleUpdate(update, env, ctx) {
    const msg = update.message || update.edited_message;
    if (!msg) return update.callback_query ? handleCallback(update.callback_query, env) : null;

    if (update.edited_message && msg.chat.id.toString() === env.ADMIN_GROUP_ID) {
        return handleAdminEdit(msg, env);
    }

    if (update.edited_message) return (msg.chat.type === "private") ? handleEdit(msg, env) : null;

    if (msg.chat.type === "private") await handlePrivate(msg, env, ctx);
    else if (msg.chat.id.toString() === env.ADMIN_GROUP_ID) await handleAdminReply(msg, env);
}

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

// 私聊消息处理 (用户侧)
async function handlePrivate(msg, env, ctx) {
    const id = msg.chat.id.toString();
    const text = msg.text || "";
    const isAdm = (env.ADMIN_IDS || "").includes(id);
    const u = await getUser(id, env);

    if (text !== "/start" && !isAdm) {
        const isCaptchaOn = await getBool('enable_verify', env);
        const isQAOn = await getBool('enable_qa_verify', env);

        if ((isCaptchaOn || isQAOn) && u.user_state !== 'verified') {
            const now = Date.now();
            const lastWarn = CACHE.warn_cd[id] || 0;
            if (now - lastWarn < 3000) return;
            CACHE.warn_cd[id] = now;
            return api(env.BOT_TOKEN, "sendMessage", {
                chat_id: id,
                text: "❗️❗️❗️请先进行验证，再发送消息",
                reply_to_message_id: msg.message_id
            });
        }
    }

    // 1. 命令处理
    if (text === "/start") {
        if (isAdm && ctx) ctx.waitUntil(registerCommands(env));
        if (!isAdm) {
            await updUser(id, { user_state: 'new' }, env);
            u.user_state = 'new';
        }
        return isAdm ? handleAdminConfig(id, null, 'menu', null, null, env) : sendStart(id, msg, env);
    }
    if (text === "/help" && isAdm) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "ℹ️ <b>帮助</b>\n• 回复消息即对话\n• /start 打开面板", parse_mode: "HTML" });

    // 2. [自愈逻辑] 封禁用户重置
    if (u.is_blocked) {
        return;
    }

    // 3. 管理员特权
    if (await isAuthAdmin(id, env)) {
        if(u.user_state !== "verified") await updUser(id, { user_state: "verified" }, env);
        if(text === "/start" && ctx) ctx.waitUntil(registerCommands(env));
    }

    // 4. 管理员状态机
    if (isAdm) {
        const stateStr = await getCfg(`admin_state:${id}`, env);
        if (stateStr) {
            const state = safeParse(stateStr);
            if (state.action === 'input') return handleAdminInput(id, msg, state, env);
        }
    }

    // 5. 验证逻辑 (正常流程)
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

async function sendStart(id, msg, env) {
    const u = await getUser(id, env);
    if (u.topic_id) {
        // 尝试发送卡片，如果这里失败说明话题可能丢了，会在 sendInfoCardToTopic 内部抛错或返回
        try {
            const success = await sendInfoCardToTopic(env, u, msg.from, u.topic_id);
            if (!success) await updUser(id, { topic_id: null }, env);
        } catch (e) { await updUser(id, { topic_id: null }, env); }
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
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: id,
            text: "🛡️ <b>安全验证</b>\n请点击下方按钮完成人机验证以继续。",
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "点击进行验证", web_app: { url: `${url}/verify?user_id=${id}` } }]] }
        });
    } else if (!isCaptchaOn && isQAOn) {
        await updUser(id, { user_state: "pending_verification" }, env);
        return api(env.BOT_TOKEN, "sendMessage", {
            chat_id: id,
            text: "❓ <b>安全提问</b>\n请回答：\n" + await getCfg('verif_q', env),
            parse_mode: "HTML"
        });
    }
}

async function handleVerifiedMsg(msg, u, env) {
    const id = u.user_id, text = msg.text || "";

    if (text) {
        const kws = await getJsonCfg('block_keywords', env);
        if (kws.some(k => new RegExp(k, 'gi').test(text))) {
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

    if (await getBool('busy_mode', env)) {
        const now = Date.now();
        if (now - (u.user_info.last_busy_reply || 0) > 300000) {
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "🌙 " + await getCfg('busy_msg', env) });
            await updUser(id, { user_info: { ...u.user_info, last_busy_reply: now } }, env);
        }
    }

    if (text) {
        const rules = await getJsonCfg('keyword_responses', env);
        const match = rules.find(r => new RegExp(r.keywords, 'gi').test(text));
        if (match) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "自动回复：\n" + match.response });
    }

    await relayToTopic(msg, u, env);
}

// --- 核心：消息转发与话题管理 (包含修复后的逻辑) ---
async function relayToTopic(msg, u, env) {
    const uMeta = getUMeta(msg.from, u, msg.date), uid = u.user_id;
    let tid = u.topic_id;

    // 1. 检测用户名变更
    if (u.user_info.name !== uMeta.name || u.user_info.username !== uMeta.username) {
        u.user_info.name = uMeta.name; u.user_info.username = uMeta.username;
        await updUser(uid, { user_info: u.user_info }, env);
        // 如果有话题，尝试重命名
        if (u.topic_id) api(env.BOT_TOKEN, "editForumTopic", { chat_id: env.ADMIN_GROUP_ID, message_thread_id: u.topic_id, name: uMeta.topicName }).catch(e=>{});
    }

    if (!tid) {
        if (CACHE.user_locks[uid]) return;
        CACHE.user_locks[uid] = true;
        try {
            const freshU = await getUser(uid, env);
            if (freshU.topic_id) tid = freshU.topic_id;
            else {
                const t = await api(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: uMeta.topicName });
                tid = t.message_thread_id.toString();
                u.user_info.card_msg_id = null;
                const dummy = await api(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_GROUP_ID, message_thread_id: tid, text: "✨ 正在加载用户资料...", disable_notification: true });
                u.user_info.dummy_msg_id = dummy.message_id;
                await updUser(uid, { topic_id: tid, user_info: u.user_info }, env);
            }
        } catch (e) {
            console.error("Topic Creation Failed:", e);
            delete CACHE.user_locks[uid];
            return api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "系统忙，请稍后再试" });
        }
        delete CACHE.user_locks[uid];
    }

    try {
        let forwardedMsg;
        const rawText = msg.text || "";

        if (rawText && (rawText.startsWith('>') || rawText.startsWith('》') || rawText.startsWith('&gt;'))) {
            let cleanText = rawText.replace(/^[>》]\s?/, '').replace(/^&gt;\s?/, '');
            cleanText = escape(cleanText);

            const customHtml = `<blockquote>${cleanText}</blockquote>`;

            forwardedMsg = await api(env.BOT_TOKEN, "sendMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                message_thread_id: tid,
                text: customHtml,
                parse_mode: "HTML"
            });
        } else {
            try {
                forwardedMsg = await api(env.BOT_TOKEN, "forwardMessage", {
                    chat_id: env.ADMIN_GROUP_ID, from_chat_id: uid, message_id: msg.message_id, message_thread_id: tid
                });
            } catch(fwdErr) {
                forwardedMsg = await api(env.BOT_TOKEN, "copyMessage", {
                    chat_id: env.ADMIN_GROUP_ID, from_chat_id: uid, message_id: msg.message_id, message_thread_id: tid
                });
            }
        }

        // [Fix] 卡片发送逻辑增强
        try {
            let infoDirty = false;
            // 检测到没有卡片记录（包括之前发送失败的情况），或者新话题，尝试发送
            if (!u.user_info.card_msg_id) {
                try {
                    const cardId = await sendInfoCardToTopic(env, u, msg.from, tid, msg.date);
                    if (cardId) {
                        u.user_info.card_msg_id = cardId;
                        u.user_info.join_date = msg.date || (Date.now()/1000);
                        infoDirty = true;
                    }
                } catch (innerErr) {
                    // 如果话题不存在，向外抛出，触发下方的重置逻辑
                    if (innerErr.message && (innerErr.message.includes("thread") || innerErr.message.includes("not found"))) {
                        throw innerErr;
                    }
                }
            }
            if (u.user_info.dummy_msg_id) {
                await api(env.BOT_TOKEN, "deleteMessage", { chat_id: env.ADMIN_GROUP_ID, message_id: u.user_info.dummy_msg_id }).catch(() => {});
                delete u.user_info.dummy_msg_id; infoDirty = true;
            }
            if (infoDirty) await updUser(uid, { user_info: u.user_info }, env);
        } catch (processErr) {
            // 捕获到话题失效，重置 topic_id
            if (processErr.message && (processErr.message.includes("thread") || processErr.message.includes("not found"))) {
                await updUser(uid, { topic_id: null }, env);
                u.topic_id = null;
                return relayToTopic(msg, u, env); // 递归重试，将创建新话题并补发卡片
            }
        }

        api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "✅ 已送达", reply_to_message_id: msg.message_id, disable_notification: true }).catch(()=>{});

        if (forwardedMsg && forwardedMsg.message_id) {
            const storeText = msg.text || "[Media]";
            await sql(env, "INSERT OR REPLACE INTO messages (user_id, message_id, text, date, topic_message_id) VALUES (?,?,?,?,?)",
                [uid, msg.message_id, storeText, msg.date, forwardedMsg.message_id.toString()]);
        }
        await handleBackup(msg, uMeta, env);

    } catch (e) {
        console.error("Relay Failed:", e);
        if (e.message && (e.message.includes("thread") || e.message.includes("not found") || e.message.includes("Bad Request"))) {
            await updUser(uid, { topic_id: null }, env); u.topic_id = null; return relayToTopic(msg, u, env);
        } else {
            api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "❌ 发送失败，请稍后再试" });
        }
    }
}

// --- 核心：发送用户信息卡片 (终极修复版) ---
async function sendInfoCardToTopic(env, u, tgUser, tid, date) {
    const meta = getUMeta(tgUser, u, date || (Date.now()/1000));
    let bestPhoto = null;

    // 1. [防护] 独立尝试获取头像，失败不影响主流程
    try {
        const photos = await api(env.BOT_TOKEN, "getUserProfilePhotos", { user_id: u.user_id, limit: 1 });
        if (photos && photos.photos && photos.photos.length > 0) {
            bestPhoto = photos.photos[0][photos.photos[0].length - 1].file_id;
        }
    } catch (e) {
        // 头像获取失败，忽略
    }

    try {
        let cardMsg;
        // 2. [防护] 检查长度：图片配文限制 1024 字符。如果超过，强制转为 sendMessage
        const isCaptionTooLong = meta.card.length > 1000;

        if (bestPhoto && !isCaptionTooLong) {
            try {
                cardMsg = await api(env.BOT_TOKEN, "sendPhoto", {
                    chat_id: env.ADMIN_GROUP_ID, message_thread_id: tid, photo: bestPhoto, caption: meta.card, parse_mode: "HTML", reply_markup: getBtns(u.user_id, u.is_blocked)
                });
            } catch (err) {
                // 4. [防护] HTML 解析错误或图片问题，降级发送纯文本
                if (err.message && (err.message.includes("parse") || err.message.includes("MEDIA"))) {
                    cardMsg = await api(env.BOT_TOKEN, "sendMessage", {
                        chat_id: env.ADMIN_GROUP_ID, message_thread_id: tid, text: meta.card, parse_mode: "HTML", reply_markup: getBtns(u.user_id, u.is_blocked)
                    });
                } else {
                    throw err; // 抛出其他错误（如 topic not found）
                }
            }
        } else {
            cardMsg = await api(env.BOT_TOKEN, "sendMessage", {
                chat_id: env.ADMIN_GROUP_ID, message_thread_id: tid, text: meta.card, parse_mode: "HTML", reply_markup: getBtns(u.user_id, u.is_blocked)
            });
        }
        try { await api(env.BOT_TOKEN, "pinChatMessage", { chat_id: env.ADMIN_GROUP_ID, message_id: cardMsg.message_id, message_thread_id: tid }); } catch (pinErr) {}
        return cardMsg.message_id;
    } catch (e) {
        console.error("Send Info Card Failed:", e);
        // 3. [防护] 关键错误识别：如果话题不存在，抛出异常通知主流程
        if (e.message && (e.message.includes("thread") || e.message.includes("not found"))) {
            throw e;
        }
        return null;
    }
}

// --- 5. 通用/黑名单 (保持原逻辑) ---
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

async function handleBackup(msg, meta, env) {
    const bid = await getCfg('backup_group_id', env);
    if (!bid) return;
    try {
        const header = `<b>📨 备份</b> ${meta.name} (${meta.userId})`;
        if (msg.text) await api(env.BOT_TOKEN, "sendMessage", { chat_id: bid, text: header + "\n" + msg.text, parse_mode: "HTML" });
        else {
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: bid, text: header, parse_mode: "HTML" });
            await api(env.BOT_TOKEN, "copyMessage", { chat_id: bid, from_chat_id: msg.chat.id, message_id: msg.message_id });
        }
    } catch (e) {}
}

// --- 6. 管理员功能 (保持原逻辑) ---
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
            if (u.topic_id && u.user_info.card_msg_id) {
                try {
                    await api(env.BOT_TOKEN, "editMessageCaption", { chat_id: env.ADMIN_GROUP_ID, message_id: u.user_info.card_msg_id, caption: newMeta.card, parse_mode: "HTML", reply_markup: getBtns(targetUid, u.is_blocked) });
                } catch (e) {
                    try { await api(env.BOT_TOKEN, "editMessageText", { chat_id: env.ADMIN_GROUP_ID, message_id: u.user_info.card_msg_id, text: newMeta.card, parse_mode: "HTML", reply_markup: getBtns(targetUid, u.is_blocked) }); } catch(e2) {}
                }
            }
            await updUser(targetUid, { user_info: u.user_info }, env);
            await setCfg(`admin_state:${msg.from.id}`, "", env);
            return api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: `✅ 备注已更新` });
        }
    }

    const uid = (await sql(env, "SELECT user_id FROM users WHERE topic_id = ?", msg.message_thread_id.toString(), 'first'))?.user_id;
    if (!uid) return;

    let replyToMsgId = undefined;
    if (msg.reply_to_message) {
        const ref = await sql(env, "SELECT message_id FROM messages WHERE topic_message_id = ?", msg.reply_to_message.message_id.toString(), 'first');
        if (ref) replyToMsgId = ref.message_id;
    }

    try {
        await api(env.BOT_TOKEN, "copyMessage", { chat_id: uid, from_chat_id: msg.chat.id, message_id: msg.message_id, reply_to_message_id: replyToMsgId });
        if (await getBool('enable_admin_receipt', env)) api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "✅ 已回复", reply_to_message_id: msg.message_id, disable_notification: true }).catch(()=>{});
    } catch (e) { api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "❌ 发送失败" }); }
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

// --- 7. Web验证接口 (保持原逻辑) ---
async function handleVerifyPage(url, env) {
    const uid = url.searchParams.get('user_id');
    const mode = await getCfg('captcha_mode', env);
    const siteKey = mode === 'recaptcha' ? env.RECAPTCHA_SITE_KEY : env.TURNSTILE_SITE_KEY;
    if (!uid || !siteKey) return new Response("Miss Config (Check Mode/Key)", { status: 400 });
    const scriptUrl = mode === 'recaptcha' ? "https://www.google.com/recaptcha/api.js" : "https://challenges.cloudflare.com/turnstile/v0/api.js";
    const divClass = mode === 'recaptcha' ? "g-recaptcha" : "cf-turnstile";
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://telegram.org/js/telegram-web-app.js"></script><script src="${scriptUrl}" async defer></script><style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#fff;font-family:sans-serif}#c{text-align:center;padding:20px;background:#f0f0f0;border-radius:10px}</style></head><body><div id="c"><h3>🛡️ 安全验证</h3><div class="${divClass}" data-sitekey="${siteKey}" data-callback="S"></div><div id="m"></div></div><script>const tg=window.Telegram.WebApp;tg.ready();function S(t){document.getElementById('m').innerText='验证中...';fetch('/submit_token',{method:'POST',body:JSON.stringify({token:t,userId:'${uid}'})}).then(r=>r.json()).then(d=>{if(d.success){document.getElementById('m').innerText='✅';setTimeout(()=>{tg.close();window.close();},1000)}else{document.getElementById('m').innerText='❌'}}).catch(e=>{document.getElementById('m').innerText='Error'})}</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function handleTokenSubmit(req, env) {
    try {
        const { token, userId } = await req.json();
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
            await updUser(userId, { user_state: "pending_verification" }, env);
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "✅ 验证通过！\n请回答：\n" + await getCfg('verif_q', env) });
        } else {
            await updUser(userId, { user_state: "verified" }, env);
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "✅ 验证通过！\n现在您可以直接发送消息，我会帮您转达给管理员。" });
        }
        return new Response(JSON.stringify({ success: true }));
    } catch { return new Response(JSON.stringify({ success: false }), { status: 400 }); }
}

async function verifyAnswer(id, ans, env) {
    if (ans.trim() === (await getCfg('verif_a', env)).trim()) {
        await updUser(id, { user_state: "verified" }, env);
        await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "✅ 验证通过！\n现在您可以直接发送消息，我会帮您转达给管理员。" });
    } else await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 错误" });
}

// --- 8. 菜单回调 (保持原逻辑) ---
async function handleCallback(cb, env) {
    const { data, message: msg, from } = cb;
    const [act, p1, p2, p3] = data.split(':');

    if (act === 'note' && p1 === 'set') {
        await setCfg(`admin_state:${from.id}`, JSON.stringify({ action: 'input_note', target: p2 }), env);
        return api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "⌨️ 请回复备注内容 (回复 /clear 清除):" });
    }

    if (act === 'config') {
        if (!(env.ADMIN_IDS||"").includes(from.id.toString())) return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权", show_alert: true });

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

    if (msg.chat.id.toString() === env.ADMIN_GROUP_ID) {
        await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
        if (act === 'pin_card') api(env.BOT_TOKEN, "pinChatMessage", { chat_id: msg.chat.id, message_id: msg.message_id, message_thread_id: msg.message_thread_id });
        else if (['block','unblock'].includes(act)) {
            const isB = act === 'block'; const uid = p1; const u = await getUser(uid, env); const bid = await getCfg('blocked_topic_id', env);
            await updUser(uid, { is_blocked: isB, block_count: 0 }, env);
            if (u.user_info.card_msg_id) {
                api(env.BOT_TOKEN, "editMessageReplyMarkup", { chat_id: env.ADMIN_GROUP_ID, message_id: u.user_info.card_msg_id, reply_markup: getBtns(uid, isB) }).catch(()=>{});
            }
            await manageBlacklist(env, u, { id: uid, username: u.user_info.username, first_name: u.user_info.name }, isB);
            if (!isB && msg.message_thread_id && bid && msg.message_thread_id.toString() === bid) api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "✅ 已解除屏蔽" });
            else api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: isB ? "❌ 已屏蔽" : "✅ 已解封" });
        }
    }
}

// --- 9. 管理配置面板 (保持原逻辑) ---
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
            if (['ar','kw','auth'].includes(key)) return render(`列表: ${key}`, await getListKB(key, env));
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
            const realK = key==='kw'?'block_keywords':(key==='auth'?'authorized_admins':'keyword_responses'); let l = await getJsonCfg(realK, env); l = l.filter(i => (i.id||i).toString() !== val); await setCfg(realK, JSON.stringify(l), env); return render(`列表: ${key}`, await getListKB(key, env));
        }
        if (type === 'edit' || type === 'add') {
            await setCfg(`admin_state:${cid}`, JSON.stringify({ action: 'input', key: key + (type==='add'?'_add':'') }), env);
            let promptText = `请输入 ${key} 的值 (/cancel 取消):`;
            if (key === 'ar' && type === 'add') promptText = `请输入自动回复规则，格式：\n<b>关键词===回复内容</b>\n\n例如：价格===请联系人工客服\n(/cancel 取消)`;
            if (key === 'welcome_msg') promptText = `请发送新的欢迎语 (/cancel 取消):\n\n• 支持 <b>文字</b> 或 <b>图片/视频/GIF</b>\n• 支持占位符: {name}\n• 直接发送媒体即可`;
            return api(env.BOT_TOKEN, "editMessageText", { chat_id: cid, message_id: mid, text: promptText, parse_mode: "HTML" });
        }
    } catch (e) { api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: mid, text: "Error", show_alert: true }); }
}

async function getFilterKB(env) {
    const s = async k => (await getBool(k, env)) ? "✅" : "❌";
    const b = (t, k, v) => ({ text: `${t} ${v}`, callback_data: `config:toggle:${k}:${v==="❌"}` });
    const keys = ['enable_admin_receipt', 'enable_forward_forwarding', 'enable_image_forwarding', 'enable_audio_forwarding', 'enable_sticker_forwarding', 'enable_link_forwarding', 'enable_channel_forwarding', 'enable_text_forwarding'];
    const vals = await Promise.all(keys.map(k => s(k)));
    return { inline_keyboard: [[b("回执", keys[0], vals[0]), b("转发", keys[1], vals[1])], [b("媒体", keys[2], vals[2]), b("语音", keys[3], vals[3])], [b("贴纸", keys[4], vals[4]), b("链接", keys[5], vals[5])], [b("频道", keys[6], vals[6]), b("文本", keys[7], vals[7])], [{ text: "🔙 返回", callback_data: "config:menu" }]] };
}

async function getListKB(type, env) {
    const k = type==='ar'?'keyword_responses':(type==='kw'?'block_keywords':'authorized_admins');
    const l = await getJsonCfg(k, env);
    const btns = l.map((i, idx) => [{ text: `🗑 ${type==='ar'?i.keywords:i}`, callback_data: `config:del:${type}:${i.id||i}` }]);
    btns.push([{ text: "➕ 添加", callback_data: `config:add:${type}` }], [{ text: "🔙 返回", callback_data: "config:menu" }]);
    return { inline_keyboard: btns };
}

async function handleAdminInput(id, msg, state, env) {
    const txt = msg.text || "";
    if (txt === '/cancel') { await sql(env, "DELETE FROM config WHERE key=?", `admin_state:${id}`); return handleAdminConfig(id, null, 'menu', null, null, env); }
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
            if (k === 'ar') { const [kk, rr] = txt.split('==='); if(kk && rr) list.push({keywords:kk, response:rr, id:Date.now()}); else return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 格式错误，请使用：关键词===回复内容" }); }
            else list.push(txt);
            val = JSON.stringify(list); k = realK;
        } else if (k === 'authorized_admins') { val = JSON.stringify(txt.split(/[,，]/).map(s => s.trim()).filter(Boolean)); }
        await setCfg(k, val, env); await sql(env, "DELETE FROM config WHERE key=?", `admin_state:${id}`);
        const displayVal = (val.startsWith('{') && k === 'welcome_msg') ? "[媒体配置]" : val.substring(0,100);
        await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `✅ ${k} 已更新:\n${displayVal}` });
        await handleAdminConfig(id, null, 'menu', null, null, env);
    } catch (e) { api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `❌ 失败: ${e.message}` }); }
}

// --- 10. 工具函数 (Pure Functions) ---
const getBool = async (k, e) => (await getCfg(k, e)) === 'true';
const getJsonCfg = async (k, e) => safeParse(await getCfg(k, e), []);
const escape = t => (t||"").toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const isAuthAdmin = async (id, e) => {
    const idStr = id.toString();
    if ((e.ADMIN_IDS||"").includes(idStr)) return true;
    const list = await getJsonCfg('authorized_admins', e);
    return list.includes(idStr);
};

const getUMeta = (tgUser, dbUser, d) => {
    const id = tgUser.id.toString(); const firstName = tgUser.first_name || ""; const lastName = tgUser.last_name || ""; let name = (firstName + " " + lastName).trim(); if (!name) name = "未命名用户";
    const safeName = `<code>${escape(name)}</code>`; const note = dbUser.user_info && dbUser.user_info.note ? `\n📝 <b>备注:</b> ${escape(dbUser.user_info.note)}` : "";
    const labelDisplay = tgUser.username ? `@${tgUser.username}` : "无用户名"; const timeStr = new Date(d*1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    return { userId: id, name, username: tgUser.username, topicName: name.substring(0, 128), card: `<b>🪪 用户资料</b>\n---\n👤: ${safeName}\n🏷️: ${labelDisplay}\n🆔: <code>${id}</code>${note}\n🕒: <code>${timeStr}</code>` };
};

const getBtns = (id, blk) => ({ inline_keyboard: [[{ text: "👤 打开主页", url: `tg://user?id=${id}` }], [{ text: blk?"✅ 解封":"🚫 屏蔽", callback_data: `${blk?'unblock':'block'}:${id}` }], [{ text: "✏️ 备注", callback_data: `note:set:${id}` }, { text: "📌 置顶", callback_data: `pin_card:${id}` }]] });