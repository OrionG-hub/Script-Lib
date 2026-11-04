export class HttpError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
export const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified',
    'Access-Control-Max-Age': '86400'
};
export function reply(text, status = 200) {
    return new Response(text, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
export function required(env, key) {
    if (typeof env[key] !== 'string' || !env[key].trim()) throw new HttpError(`Missing configuration: ${key}`, 500);
    return env[key].trim();
}
export function httpsBase(value) {
    let url;
    try { url = new URL(value); } catch { throw new HttpError('Invalid service URL.', 500); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new HttpError('Service URLs must use HTTPS without credentials or query parameters.', 500);
    return url.href.replace(/\/+$/, '');
}
export function segments(path) {
    try {
        const parts = path.replace(/^\//, '').split('/').map(decodeURIComponent);
        if (parts.some(part => !part || part === '.' || part === '..' || /[/\\\x00-\x1f\x7f]/.test(part))) throw new Error();
        return parts;
    } catch { throw new HttpError('Invalid path.'); }
}
export const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
export function config(env) {
    const base = httpsBase(required(env, 'GITEA_URL'));
    const owner = required(env, 'GITEA_OWNER');
    let repos;
    try { repos = JSON.parse(required(env, 'ALLOWED_REPOSITORIES')); } catch { throw new HttpError('ALLOWED_REPOSITORIES must be a JSON array.', 500); }
    const name = value => typeof value === 'string' && /^[\w.-]+$/.test(value) && value !== '.' && value !== '..';
    if (!name(owner) || !Array.isArray(repos) || !repos.length || repos.some(repo => !name(repo))) throw new HttpError('Invalid owner or repository allowlist.', 500);
    return { base, owner, repos };
}
export function allowed(cfg, repo) {
    if (!cfg.repos.includes(repo)) throw new HttpError('Repository not found.', 404);
}
export function apiRoot(cfg, repo) {
    return `${cfg.base}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(repo)}`;
}
export async function upstream(url, options = {}) {
    try {
        // Workers supports only follow/manual; reject redirects before forwarding credentials.
        const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new Error('Upstream redirect rejected.');
        }
        return response;
    } catch { throw new HttpError('Upstream request failed or timed out.', 502); }
}
export async function readJson(response, service) {
    try { return await response.json(); } catch { throw new HttpError(`${service} returned invalid JSON.`, 502); }
}
export async function safeEqual(a, b) {
    if (!a || !b) return false;
    const hash = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    const [aHash, bHash] = await Promise.all([hash(a), hash(b)]);
    const left = new Uint8Array(aHash), right = new Uint8Array(bHash);
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
    return diff === 0;
}
export function rawLink(env, repo, path, ref, defaultBranch) {
    const base = httpsBase(required(env, 'RAW_BASE_URL'));
    if (new URL(base).pathname !== '/') throw new HttpError('RAW_BASE_URL must not include a path.', 500);
    const url = new URL(`${base}/${encodeURIComponent(repo)}/${encodePath(path)}`);
    if (ref !== defaultBranch) url.searchParams.set('ref', ref);
    return url.href;
}
