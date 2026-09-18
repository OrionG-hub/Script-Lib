// 单个图片/文件默认最大 20 MB；Cloudflare Worker 不适合可靠中转超大文件
const DEFAULT_MAX_FILE_MB = 25;

// 单个 Telegram 相册最多收集并上传 100 张图片
const DEFAULT_MAX_UPLOAD_QUEUE_IMAGES = 100;

const DEFAULT_ALBUM_WAIT_SECONDS = 2;
const DEFAULT_UPLOAD_CONCURRENCY = 2;
const UPLOAD_BUFFER_BUDGET_MB = 50;

// Shlink 自定义短码长度：5 位 Base62，例如 aB7xQ
const SHORT_CODE_LENGTH = 5;

// 短码可用字符：小写字母、大写字母和数字，共 62 种
const SHORT_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// 随机短码碰撞时最多重新生成 8 次
const MAX_SHORT_CODE_ATTEMPTS = 8;

// Telegram 单条消息安全字符上限，低于官方约 4096 的限制
const MAX_TELEGRAM_MESSAGE_LENGTH = 3900;


export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/init") {
            if (!timingSafeEqual(url.searchParams.get("secret"), env.TELEGRAM_WEBHOOK_SECRET)) {
                return textResponse("Unauthorized", 401);
            }
            await initDb(env);
            return textResponse("DB initialized");
        }

        if (request.method === "GET" && url.pathname === "/") {
            return textResponse("Lsky Telegram Worker OK");
        }

        if (request.method !== "POST" || url.pathname !== "/webhook") {
            return textResponse("Not Found", 404);
        }

        if (!timingSafeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TELEGRAM_WEBHOOK_SECRET)) {
            return textResponse("Unauthorized", 401);
        }

        let update;
        try {
            update = await request.json();
        } catch {
            return textResponse("Invalid JSON", 400);
        }

        ctx.waitUntil(handleUpdate(update, env));
        return textResponse("OK");
    },
};

async function initDb(env) {
    await env.DB.batch([
        env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `),
        env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS album_groups (
        group_key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        reply_to INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `),
        env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS album_messages (
        group_key TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (group_key, message_id)
      )
    `),
    ]);
}

async function withDbSchema(env, operation) {
    try {
        return await operation();
    } catch (error) {
        if (!/no such table: (processed_messages|album_groups|album_messages)\b/.test(safeError(error))) throw error;
        await initDb(env);
        return operation();
    }
}

async function handleUpdate(update, env) {
    const message = update?.message;
    if (!message?.chat?.id || !message?.from?.id || !message?.message_id) return;

    const chatId = message.chat.id;
    const userId = message.from.id;
    const messageId = message.message_id;

    if (!isAllowedUser(userId, env.ALLOWED_TELEGRAM_USER_IDS)) {
        await sendTelegramText(env, chatId, "未授权。", messageId);
        return;
    }

    if (message.text?.startsWith("/start")) {
        await sendTelegramText(env, chatId, "发送图片或图片文件，我会上传并返回短链。", messageId);
        return;
    }

    if (!hasSupportedImage(message)) return;

    if (message.media_group_id) {
        await queueAlbumMessage(message, env);
        return;
    }

    const messageKey = `${chatId}:${messageId}`;
    if (!(await claimMessage(env, messageKey))) return;

    try {
        const image = await uploadAndShorten(env, message);
        await sendTelegramText(env, chatId, toTelegramCodeBlock(toMarkdownImage(image.shortUrl, image.filename)), messageId, "HTML");
    } catch (error) {
        console.error("single upload failed", safeError(error));
        await sendTelegramText(env, chatId, `上传失败：${userFacingError(error)}`, messageId);
    }
}

async function queueAlbumMessage(message, env) {
    const groupKey = `${message.chat.id}:${message.media_group_id}`;
    const now = Date.now();
    const maxQueueImages = getMaxUploadQueueImages(env);

    const results = await withDbSchema(env, () => env.DB.batch([
        env.DB.prepare(`
    INSERT INTO album_groups (group_key, chat_id, reply_to, status, updated_at)
    VALUES (?, ?, ?, 'collecting', ?)
    ON CONFLICT(group_key) DO UPDATE SET
      updated_at = MAX(album_groups.updated_at, excluded.updated_at),
      reply_to = MIN(album_groups.reply_to, excluded.reply_to)
    WHERE album_groups.status = 'collecting'
      AND NOT EXISTS (SELECT 1 FROM album_messages WHERE group_key = ? AND message_id = ?)
      AND (SELECT COUNT(*) FROM album_messages WHERE group_key = ?) < ?
  `).bind(groupKey, String(message.chat.id), message.message_id, now, groupKey, message.message_id, groupKey, maxQueueImages),
        env.DB.prepare(`
    INSERT OR IGNORE INTO album_messages (group_key, message_id, payload)
    SELECT ?, ?, ?
    WHERE (SELECT COUNT(*) FROM album_messages WHERE group_key = ?) < ?
      AND EXISTS (SELECT 1 FROM album_groups WHERE group_key = ? AND status = 'collecting')
  `).bind(groupKey, message.message_id, JSON.stringify(message), groupKey, maxQueueImages, groupKey),
    ]));

    if (results[1].meta?.changes !== 1) {
        const existing = await env.DB.prepare(`
      SELECT 1 FROM album_messages WHERE group_key = ? AND message_id = ?
    `).bind(groupKey, message.message_id).first();
        if (!existing) {
            await sendTelegramText(env, message.chat.id, `相册已开始处理或队列已满（最多 ${maxQueueImages} 张），请重新发送这张图片。`, message.message_id);
        }
        return;
    }

    await sleep(getAlbumWaitSeconds(env) * 1000);
    await processAlbum(env, groupKey);
}

async function processAlbum(env, groupKey) {
    const group = await env.DB.prepare(`
    UPDATE album_groups SET status = 'processing'
    WHERE group_key = ? AND status = 'collecting' AND updated_at <= ?
    RETURNING *
  `).bind(groupKey, Date.now() - getAlbumWaitSeconds(env) * 1000).first();
    if (!group) return;

    const rows = await env.DB.prepare(`
    SELECT message_id, payload FROM album_messages
    WHERE group_key = ? ORDER BY message_id ASC
  `).bind(groupKey).all();

    const results = await mapWithConcurrency(rows.results, getUploadConcurrency(env), async (row, index) => {
        try {
            const message = JSON.parse(row.payload);
            return { image: await uploadAndShorten(env, message) };
        } catch (error) {
            console.error("album upload failed", { groupKey, index, error: safeError(error) });
            return { error: `${index + 1}. ${userFacingError(error)}` };
        }
    });
    const images = results.filter((result) => result.image).map((result) => result.image);
    const errors = results.filter((result) => result.error).map((result) => result.error);

    let output = images.length
        ? `上传完成：\n\n${images.map((image, index) => `${index + 1}.\n${toTelegramCodeBlock(toMarkdownImage(image.shortUrl, image.filename))}`).join("\n")}`
        : "这一组图片全部上传失败。";
    if (errors.length) output += `\n\n失败：\n${errors.join("\n")}`;

    try {
        await sendTelegramLongText(env, group.chat_id, output, group.reply_to, images.length ? "HTML" : undefined);
    } finally {
        await env.DB.batch([
            env.DB.prepare("DELETE FROM album_messages WHERE group_key = ?").bind(groupKey),
            env.DB.prepare("DELETE FROM album_groups WHERE group_key = ?").bind(groupKey),
        ]);
    }
}

async function claimMessage(env, messageKey) {
    const result = await withDbSchema(env, () => env.DB.prepare(`
    INSERT OR IGNORE INTO processed_messages (message_key, created_at) VALUES (?, ?)
  `).bind(messageKey, Date.now()).run());
    return result.meta?.changes === 1;
}

async function mapWithConcurrency(items, concurrency, callback) {
    const results = new Array(items.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await callback(items[index], index);
        }
    }));
    return results;
}

async function uploadAndShorten(env, message) {
    const startedAt = Date.now();
    const timings = {};
    const image = await uploadTelegramMessageToLsky(env, message, timings);
    const shortenStartedAt = Date.now();
    const shortUrl = await createShortUrl(env, image.url);
    if (env.LOG_UPLOAD_TIMINGS === "true") {
        console.info("upload timings", {
            messageId: message.message_id,
            ...timings,
            shortenMs: Date.now() - shortenStartedAt,
            totalMs: Date.now() - startedAt,
        });
    }
    return { ...image, shortUrl };
}

async function uploadTelegramMessageToLsky(env, message, timings = {}) {
    const image = extractImage(message, env);
    const getFileStartedAt = Date.now();
    const fileInfo = await telegramApi(env, "getFile", { file_id: image.fileId });
    timings.getFileMs = Date.now() - getFileStartedAt;
    if (!fileInfo?.file_path) throw new Error("Telegram 未返回文件路径");

    const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const downloadStartedAt = Date.now();
    const fileResponse = await fetchWithTimeout(fileUrl, {}, getRequestTimeoutMs(env));
    if (!fileResponse.ok || !fileResponse.body) {
        await fileResponse.body?.cancel();
        throw new Error(`下载 Telegram 文件失败 (${fileResponse.status})`);
    }

    const contentLength = Number(fileResponse.headers.get("content-length") || 0);
    const maxBytes = getMaxFileMb(env) * 1024 * 1024;
    if (contentLength && contentLength > maxBytes) {
        await fileResponse.body.cancel();
        throw new Error(`文件超过 ${getMaxFileMb(env)} MB`);
    }

    // Cloudflare Workers 的 multipart FormData 需要 Blob/File；默认限制保持保守，避免大文件占满 Worker 内存。
    const fileBlob = await fileResponse.blob();
    timings.downloadMs = Date.now() - downloadStartedAt;
    if (fileBlob.size > maxBytes) {
        throw new Error(`文件超过 ${getMaxFileMb(env)} MB`);
    }

    const filename = image.filename || guessFilename(fileInfo.file_path, image.mimeType);
    const uploadStartedAt = Date.now();
    const url = await uploadToLsky(env, fileBlob, filename, image.mimeType);
    timings.uploadMs = Date.now() - uploadStartedAt;
    return { url, filename };
}

function extractImage(message, env) {
    const maxBytes = getMaxFileMb(env) * 1024 * 1024;

    if (message.photo?.length) {
        const photo = message.photo.at(-1);
        if (photo.file_size && photo.file_size > maxBytes) throw new Error(`图片超过 ${getMaxFileMb(env)} MB`);
        return {
            fileId: photo.file_id,
            filename: `${photo.file_unique_id || photo.file_id}.jpg`,
            mimeType: "image/jpeg",
        };
    }

    if (message.document) {
        const document = message.document;
        const mimeType = document.mime_type || "application/octet-stream";
        if (!mimeType.startsWith("image/")) throw new Error("请发送图片，或以文件形式发送图片");
        if (document.file_size && document.file_size > maxBytes) throw new Error(`文件超过 ${getMaxFileMb(env)} MB`);
        return {
            fileId: document.file_id,
            filename: document.file_name || document.file_unique_id || document.file_id,
            mimeType,
        };
    }

    throw new Error("请发送图片，或以文件形式发送图片");
}

async function uploadToLsky(env, stream, filename, mimeType) {
    const form = new FormData();
    form.append("file", new File([stream], filename, { type: mimeType }));
    form.append("permission", env.LSKY_PERMISSION || "1");
    if (env.LSKY_STRATEGY_ID) form.append("strategy_id", env.LSKY_STRATEGY_ID);

    const response = await fetchWithTimeout(env.LSKY_API_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${env.LSKY_TOKEN}`,
            Accept: "application/json",
        },
        body: form,
    }, getRequestTimeoutMs(env));

    const raw = await response.text();
    let result;
    try {
        result = JSON.parse(raw);
    } catch {
        throw new Error(`图床返回异常 (${response.status})`);
    }
    if (!response.ok || result.status !== true) throw new Error(`图床上传失败 (${response.status})`);

    const data = result.data || {};
    const url = data.links?.url || data.url || data.pathname || data.path;
    if (!isHttpUrl(url)) throw new Error("图床未返回可用链接");
    return url;
}

async function createShortUrl(env, longUrl) {
    ensureAllowedShortenTarget(longUrl, env);

    for (let attempt = 0; attempt < MAX_SHORT_CODE_ATTEMPTS; attempt++) {
        const customSlug = randomBase62(SHORT_CODE_LENGTH);
        const response = await fetchWithTimeout(`${trimTrailingSlash(env.SHLINK_API_URL)}/rest/v3/short-urls`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Api-Key": env.SHLINK_API_KEY,
            },
            body: JSON.stringify({
                longUrl,
                customSlug,
                tags: ["lsky"],
                findIfExists: true,
                crawlable: false,
                forwardQuery: true,
            }),
        }, getRequestTimeoutMs(env));

        const raw = await response.text();
        let result;
        try {
            result = JSON.parse(raw);
        } catch {
            throw new Error(`短链服务返回异常 (${response.status})`);
        }

        if (response.ok && isHttpUrl(result.shortUrl)) return result.shortUrl;
        if (response.status === 409 || response.status === 422) continue;
        throw new Error(`短链创建失败 (${response.status})`);
    }

    throw new Error("短链冲突过多，请重试");
}

function ensureAllowedShortenTarget(url, env) {
    const allowedHosts = String(env.SHORTEN_ALLOWED_HOSTS || "img.orionc.me")
        .split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !allowedHosts.includes(parsed.hostname.toLowerCase())) {
        throw new Error("图床链接域名不在短链白名单中");
    }
}

function randomBase62(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length]).join("");
}

async function telegramApi(env, method, payload) {
    const response = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
    }, getRequestTimeoutMs(env));

    const raw = await response.text();
    let result;
    try {
        result = JSON.parse(raw);
    } catch {
        throw new Error(`Telegram ${method} 返回异常 (${response.status})`);
    }
    if (!response.ok || result.ok !== true) throw new Error(`Telegram ${method} 调用失败`);
    return result.result;
}

async function sendTelegramText(env, chatId, text, replyToMessageId, parseMode) {
    if (!chatId) return;
    const payload = { chat_id: chatId, text, disable_web_page_preview: true };
    if (parseMode) payload.parse_mode = parseMode;
    if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
    await telegramApi(env, "sendMessage", payload);
}

async function sendTelegramLongText(env, chatId, text, replyToMessageId, parseMode) {
    const chunks = splitTelegramText(text, MAX_TELEGRAM_MESSAGE_LENGTH);
    for (const [index, chunk] of chunks.entries()) {
        await sendTelegramText(env, chatId, chunk, index === 0 ? replyToMessageId : undefined, parseMode);
    }
}

function splitTelegramText(text, limit) {
    const chunks = [];
    let current = "";
    for (const line of String(text || "").split("\n")) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length <= limit) {
            current = next;
            continue;
        }
        if (current) chunks.push(current);
        current = "";
        for (let offset = 0; offset < line.length; offset += limit) chunks.push(line.slice(offset, offset + limit));
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [""];
}

function hasSupportedImage(message) {
    return Boolean(message?.photo?.length || message?.document?.mime_type?.startsWith("image/"));
}

function isAllowedUser(userId, allowList) {
    return String(allowList || "").split(",").map((item) => item.trim()).filter(Boolean).includes(String(userId));
}

function getMaxFileMb(env) {
    const value = Number(env.MAX_FILE_MB || DEFAULT_MAX_FILE_MB);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_FILE_MB;
}

function getMaxUploadQueueImages(env) {
    const value = Number(env.MAX_UPLOAD_QUEUE_IMAGES || DEFAULT_MAX_UPLOAD_QUEUE_IMAGES);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_UPLOAD_QUEUE_IMAGES;
}

function getAlbumWaitSeconds(env) {
    const value = Number(env.ALBUM_WAIT_SECONDS || DEFAULT_ALBUM_WAIT_SECONDS);
    return Number.isFinite(value) && value >= 2 ? value : DEFAULT_ALBUM_WAIT_SECONDS;
}

function getUploadConcurrency(env) {
    const value = Number(env.UPLOAD_CONCURRENCY || DEFAULT_UPLOAD_CONCURRENCY);
    const requested = Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_UPLOAD_CONCURRENCY;
    const memoryLimit = Math.max(1, Math.floor(UPLOAD_BUFFER_BUDGET_MB / getMaxFileMb(env)));
    return Math.min(requested, memoryLimit, 4);
}

function getRequestTimeoutMs(env) {
    const value = Number(env.REQUEST_TIMEOUT_SECONDS || 60);
    return (Number.isFinite(value) && value > 0 ? value : 60) * 1000;
}

function toMarkdownImage(url, filename = "image") {
    return `![${escapeMarkdownAlt(filename)}](${url})`;
}

function escapeMarkdownAlt(value) {
    return String(value || "image").replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

function toTelegramCodeBlock(text) {
    return `<pre>${escapeHtml(text)}</pre>`;
}

function escapeHtml(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function guessFilename(filePath, mimeType) {
    const base = filePath.split("/").pop() || "image";
    if (base.includes(".")) return base;
    const extensions = { "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
    return `${base}.${extensions[mimeType] || "jpg"}`;
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function trimTrailingSlash(value) {
    return String(value || "").replace(/\/+$/, "");
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error?.name === "AbortError") throw new Error("请求超时");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function timingSafeEqual(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    let result = 0;
    for (let index = 0; index < left.length; index++) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
    return result === 0;
}

function userFacingError(error) {
    return error instanceof Error && error.message ? error.message.slice(0, 160) : "服务异常，请稍后重试";
}

function safeError(error) {
    return error instanceof Error ? error.message : String(error);
}

function textResponse(text, status = 200) {
    return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
