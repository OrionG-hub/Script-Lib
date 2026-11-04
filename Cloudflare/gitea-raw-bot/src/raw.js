import { HttpError, cors, reply, config, segments, allowed, apiRoot, upstream, readJson, safeEqual, encodePath } from './common.js';

const MIME = {
    txt: 'text/plain', conf: 'text/plain', list: 'text/plain', rules: 'text/plain', ini: 'text/plain', toml: 'text/plain',
    yaml: 'text/yaml', yml: 'text/yaml', json: 'application/json', js: 'application/javascript', mjs: 'application/javascript',
    ts: 'application/typescript', css: 'text/css', html: 'text/html', htm: 'text/html', xml: 'application/xml', csv: 'text/csv', md: 'text/markdown'
};
export function giteaHeaders(env, authenticated) {
    const headers = { Accept: 'application/json', 'User-Agent': 'Cloudflare-Gitea-Raw-Proxy' };
    if (authenticated) headers.Authorization = `token ${env.GITEA_TOKEN}`;
    return headers;
}
// Permissions are queried on every request, including before cache hits. A public
// repository becoming private must not remain accessible through stale metadata.
export async function repositoryInfo(cfg, repo, env) {
    allowed(cfg, repo);
    const url = apiRoot(cfg, repo);
    let response = await upstream(url, { headers: giteaHeaders(env, false) });
    let authenticated = false;
    if ([401, 403, 404].includes(response.status) && env.GITEA_TOKEN) {
        await response.body?.cancel();
        authenticated = true;
        response = await upstream(url, { headers: giteaHeaders(env, true) });
    }
    if (!response.ok) throw new HttpError(response.status === 404 ? 'Repository not found or inaccessible.' : 'Gitea repository lookup failed. Check GITEA_TOKEN.', response.status === 404 ? 404 : 502);
    const data = await readJson(response, 'Gitea');
    if (typeof data.default_branch !== 'string' || !data.default_branch) throw new HttpError('Gitea repository has no default branch.', 502);
    const requiresAuth = authenticated || data.private === true;
    if (requiresAuth && !env.GITEA_TOKEN) throw new HttpError('GITEA_TOKEN is required.', 502);
    return { defaultBranch: data.default_branch, requiresAuth };
}
export async function raw(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!['GET', 'HEAD'].includes(request.method)) return reply('Method Not Allowed', 405);
    const url = new URL(request.url);
    if (url.pathname === '/') return reply('Gitea Raw Bot OK\n/{repository}/{path}?ref={branch}');
    const [repo, ...files] = segments(url.pathname);
    if (!files.length) throw new HttpError('Expected /{repository}/{path}');
    const cfg = config(env);
    const info = await repositoryInfo(cfg, repo, env);
    if (info.requiresAuth) {
        if (!env.TOKEN) throw new HttpError('Raw authentication is not configured.', 500);
        const supplied = url.searchParams.get('token') || request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
        if (!await safeEqual(supplied, env.TOKEN)) return reply('Unauthorized.', 401);
    }
    const ref = url.searchParams.get('ref') ?? info.defaultBranch;
    if (!ref || ref.length > 1024 || /[\x00-\x1f\x7f]/.test(ref)) throw new HttpError('Invalid ref.');
    const filePath = files.join('/');
    // Include upstream identity and effective ref; never put access tokens in keys.
    const keyUrl = new URL(`${url.origin}/${encodeURIComponent(repo)}/${encodePath(filePath)}`);
    keyUrl.searchParams.set('ref', ref);
    keyUrl.searchParams.set('_upstream', `${cfg.base}/${cfg.owner}`);
    const cacheKey = new Request(keyUrl, { method: 'GET' });
    const cacheable = !info.requiresAuth && request.method === 'GET' && !request.headers.has('Range');
    if (cacheable) {
        const cached = await caches.default.match(cacheKey);
        if (cached) return cached;
    }
    // The API's ref parameter handles branch names containing slashes unambiguously.
    const target = new URL(`${apiRoot(cfg, repo)}/raw/${encodePath(filePath)}`);
    target.searchParams.set('ref', ref);
    const headers = giteaHeaders(env, info.requiresAuth);
    headers.Accept = '*/*';
    if (request.headers.has('Range')) headers.Range = request.headers.get('Range');
    const upstreamResponse = await upstream(target.href, { method: 'GET', headers });
    if (!upstreamResponse.ok && upstreamResponse.status !== 416) {
        await upstreamResponse.body?.cancel();
        return reply(upstreamResponse.status === 404 ? 'File not found on Gitea.' : 'Gitea raw request failed.', upstreamResponse.status === 404 ? 404 : 502);
    }
    const responseHeaders = new Headers(cors);
    for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified', 'Accept-Ranges']) {
        const value = upstreamResponse.headers.get(name);
        if (value) responseHeaders.set(name, value);
    }
    const ext = files.at(-1).split('.').at(-1).toLowerCase();
    responseHeaders.set('Content-Type', MIME[ext] ? `${MIME[ext]}; charset=utf-8` : upstreamResponse.headers.get('Content-Type') || 'application/octet-stream');
    responseHeaders.set('Cache-Control', info.requiresAuth ? 'private, no-store' : 'public, max-age=60');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    if (request.method === 'HEAD') await upstreamResponse.body?.cancel();
    const response = new Response(request.method === 'HEAD' ? null : upstreamResponse.body, { status: upstreamResponse.status, headers: responseHeaders });
    if (cacheable && response.status === 200) ctx.waitUntil(caches.default.put(cacheKey, response.clone()).catch(() => console.error('Public cache write failed.')));
    return response;
}
