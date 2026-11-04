import { HttpError, reply, required, httpsBase, config, segments, allowed, apiRoot, upstream, readJson, safeEqual, rawLink } from './common.js';
import { repositoryInfo, giteaHeaders } from './raw.js';

const HELP = '发送一个 Gitea 文件链接或 Cloudflare Raw 代理链接，返回保留版本的 Shlink 短链；相同目标复用已有短链。私库短链自动携带 Raw Token，可直接访问。';
async function send(env, chatId, messageId, text) {
    const token = required(env, 'TELEGRAM_BOT_TOKEN');
    const response = await upstream(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true },
            reply_parameters: { message_id: messageId, allow_sending_without_reply: true } })
    });
    if (!response.ok || !(await readJson(response, 'Telegram')).ok) throw new HttpError('Telegram reply failed.', 502);
}
function convertedLink(env, repo, file, ref, defaultBranch, requiresAuth) {
    const target = new URL(rawLink(env, repo, file, ref, defaultBranch));
    if (requiresAuth) target.searchParams.set('token', required(env, 'TOKEN'));
    return { longUrl: target.href, private: requiresAuth };
}
export async function convert(input, env) {
    // Accept only a URL. Proxy links preserve ref; supplied tokens are never reused.
    if (typeof input !== 'string' || /\s/.test(input.trim())) throw new HttpError('请单独发送一个 Gitea 或 Raw 代理文件链接。');
    let url;
    try { url = new URL(input.trim()); } catch { throw new HttpError('请发送有效的 Gitea 或 Raw 代理文件链接。'); }
    const cfg = config(env);
    if (url.username || url.password) throw new HttpError('链接不能包含用户名或密码。');
    const rawBase = new URL(httpsBase(required(env, 'RAW_BASE_URL')));
    if (url.origin === rawBase.origin) {
        const [repo, ...files] = segments(url.pathname);
        if (!files.length) throw new HttpError('请发送包含仓库和文件路径的 Raw 代理链接。');
        allowed(cfg, repo);
        const info = await repositoryInfo(cfg, repo, env);
        const ref = url.searchParams.get('ref') ?? info.defaultBranch;
        if (!ref || ref.length > 1024 || /[\x00-\x1f\x7f]/.test(ref)) throw new HttpError('无效的 ref。');
        return convertedLink(env, repo, files.join('/'), ref, info.defaultBranch, info.requiresAuth);
    }
    const base = new URL(cfg.base);
    const prefix = base.pathname.replace(/\/$/, '');
    if (url.origin !== base.origin || !url.pathname.startsWith(`${prefix}/`)) throw new HttpError('仅支持配置的 Gitea 或 Raw 代理站点。');
    const [owner, repo, mode, kind, ...tail] = segments(url.pathname.slice(prefix.length));
    if (owner !== cfg.owner) throw new HttpError('仅支持配置的仓库所有者。');
    allowed(cfg, repo);
    if (!['src', 'raw'].includes(mode) || !['branch', 'tag', 'commit'].includes(kind) || tail.length < 2) throw new HttpError('请发送文件页面或 Raw 文件链接。');
    const info = await repositoryInfo(cfg, repo, env);
    let ref, file;
    if (kind === 'commit') {
        if (!/^[a-f0-9]{7,64}$/i.test(tail[0])) throw new HttpError('无效的提交 ID。');
        ref = tail[0]; file = tail.slice(1).join('/');
    } else {
        // Gitea resolves slash-containing refs by longest matching ref name.
        // Bound probes so malicious/deep paths cannot exhaust subrequest limits.
        if (tail.length > 21) throw new HttpError('路径过深，请使用提交链接。');
        for (let i = tail.length - 1; i > 0; i--) {
            const candidate = tail.slice(0, i).join('/');
            const endpoint = kind === 'branch' ? 'branches' : 'tags';
            const response = await upstream(`${apiRoot(cfg, repo)}/${endpoint}/${encodeURIComponent(candidate)}`, { headers: giteaHeaders(env, info.requiresAuth) });
            await response.body?.cancel();
            if (response.ok) { ref = candidate; file = tail.slice(i).join('/'); break; }
            if (response.status !== 404) throw new HttpError('Gitea 分支或标签查询失败。', 502);
        }
        if (!ref) throw new HttpError('找不到对应分支或标签。', 404);
    }
    if (kind === 'tag') ref = `refs/tags/${ref}`;
    return convertedLink(env, repo, file, ref, kind === 'branch' ? info.defaultBranch : null, info.requiresAuth);
}
export async function shorten(longUrl, env) {
    const base = httpsBase(required(env, 'SHLINK_API_URL'));
    const response = await upstream(`${base}/rest/v3/short-urls`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': required(env, 'SHLINK_API_KEY') },
        body: JSON.stringify({ longUrl, findIfExists: true, crawlable: false, forwardQuery: true, tags: ['gitea-raw'] })
    });
    if (!response.ok) throw new HttpError('Shlink 短链生成失败。', 502);
    const data = await readJson(response, 'Shlink');
    let result;
    try { result = new URL(data.shortUrl); } catch { throw new HttpError('Shlink 未返回有效短链。', 502); }
    if (result.protocol !== 'https:' || result.username || result.password) throw new HttpError('Shlink 未返回有效 HTTPS 短链。', 502);
    return result.href;
}
export async function webhook(request, env) {
    if (request.method !== 'POST') return reply('Method Not Allowed', 405);
    if (!await safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), required(env, 'TELEGRAM_WEBHOOK_SECRET'))) return reply('Unauthorized.', 401);
    let update;
    try { update = await request.json(); } catch { throw new HttpError('Invalid Telegram update.'); }
    const message = update?.message;
    const ids = required(env, 'ALLOWED_TELEGRAM_USER_IDS').split(',').map(id => id.trim());
    if (!ids.every(id => /^\d+$/.test(id))) throw new HttpError('Invalid Telegram user allowlist.', 500);
    if (!message || message.chat?.type !== 'private' || !ids.includes(String(message.from?.id))) return reply('OK');
    let text;
    if (typeof message.text !== 'string' || /^\/(start|help)(?:@\w+)?(?:\s|$)/.test(message.text)) {
        text = HELP;
    } else {
        try {
            const link = await convert(message.text, env);
            text = await shorten(link.longUrl, env);
        } catch (error) {
            if (!(error instanceof HttpError)) throw error;
            text = error.status === 500 ? '服务配置不完整，请联系管理员。' : error.message;
        }
    }
    // Await delivery. Returning success earlier would lose errors and prevent retries.
    await send(env, message.chat.id, message.message_id, text);
    return reply('OK');
}
