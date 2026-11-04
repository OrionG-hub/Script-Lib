import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const baseEnv = {
    GITEA_URL: 'https://git.example.com', GITEA_OWNER: 'me', ALLOWED_REPOSITORIES: '["repo"]',
    RAW_BASE_URL: 'https://raw.example.com', TOKEN: 'raw-secret', GITEA_TOKEN: 'gitea-secret',
    TELEGRAM_BOT_TOKEN: 'bot-secret', TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    ALLOWED_TELEGRAM_USER_IDS: '123', SHLINK_API_URL: 'https://go.example.com', SHLINK_API_KEY: 'shlink-secret'
};
let calls, entries, pending, privateRepo, handler;
const originalFetch = globalThis.fetch;
const json = (data, status = 200) => Response.json(data, { status });
beforeEach(() => {
    calls = []; entries = new Map(); pending = []; privateRepo = false; handler = undefined;
    globalThis.caches = { default: {
        async match(key) { return entries.get(key.url)?.clone(); },
        async put(key, value) { entries.set(key.url, value); }
    } };
    globalThis.fetch = async (input, init = {}) => {
        const url = String(input); calls.push({ url, ...init });
        const override = await handler?.(url, init);
        if (override) return override;
        if (url === 'https://git.example.com/api/v1/repos/me/repo') {
            if (privateRepo && !init.headers.Authorization) return json({}, 404);
            return json({ default_branch: 'main', private: privateRepo });
        }
        if (url.includes('/branches/')) return url.endsWith('feature%2Ffoo') || url.endsWith('/main') ? json({}) : json({}, 404);
        if (url.includes('/raw/')) return new Response('file contents', { headers: { 'Content-Type': 'application/octet-stream', ETag: 'v1' } });
        if (url === 'https://go.example.com/rest/v3/short-urls') return json({ shortUrl: 'https://go.example.com/abc12' });
        if (url.startsWith('https://api.telegram.org/')) return json({ ok: true });
        throw new Error(`Unexpected network call: ${url}`);
    };
});
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.caches; });
async function run(path, options = {}, env = baseEnv) {
    const response = await worker.fetch(new Request(`https://raw.example.com${path}`, options), env, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
    return response;
}
const webhook = (text, user = 123, secret = 'hook-secret', type = 'private') => ({
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: user }, chat: { id: user, type }, text } })
});
const bodyOf = prefix => JSON.parse(calls.find(call => call.url.startsWith(prefix)).body);

test('integration: webhook converts slash branch via Shlink without exposing either token', async () => {
    const response = await run('/webhook', webhook('https://git.example.com/me/repo/src/branch/feature/foo/a.txt?token=ignored'));
    assert.equal(response.status, 200);
    const payload = bodyOf('https://go.example.com/rest/');
    assert.equal(payload.longUrl, 'https://raw.example.com/repo/a.txt?ref=feature%2Ffoo');
    assert.equal(payload.forwardQuery, true);
    assert.equal(payload.findIfExists, true);
    assert.ok(!JSON.stringify(payload).includes('secret'));
    assert.match(bodyOf('https://api.telegram.org/').text, /https:\/\/go.example.com\/abc12/);
});
test('integration: private bot link has no credentials and warns about separate token', async () => {
    privateRepo = true;
    assert.equal((await run('/webhook', webhook('https://git.example.com/me/repo/raw/branch/main/a.txt'))).status, 200);
    assert.equal(bodyOf('https://go.example.com/rest/').longUrl, 'https://raw.example.com/repo/a.txt');
    assert.match(bodyOf('https://api.telegram.org/').text, /Token/);
});
test('integration: public raw uses no Gitea token, branch cache is isolated', async () => {
    for (const ref of ['main', 'dev']) {
        const response = await run(`/repo/a.txt?ref=${ref}`);
        assert.equal(await response.text(), 'file contents');
        assert.match(response.headers.get('content-type'), /text\/plain/);
    }
    assert.equal(entries.size, 2);
    assert.ok(calls.every(call => !call.headers?.Authorization));
    const count = calls.filter(call => call.url.includes('/raw/')).length;
    await run('/repo/a.txt?ref=main');
    assert.equal(calls.filter(call => call.url.includes('/raw/')).length, count);
});
test('integration: private auth runs before cache and never caches private content', async () => {
    await run('/repo/a.txt'); // old public response
    privateRepo = true;
    assert.equal((await run('/repo/a.txt')).status, 401);
    assert.equal((await run('/repo/a.txt?token=wrong')).status, 401);
    const response = await run('/repo/a.txt', { headers: { Authorization: 'Bearer raw-secret' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(calls.filter(call => call.url.includes('/raw/')).length, 2);
    assert.equal(calls.at(-1).headers.Authorization, 'token gitea-secret');
});
test('integration: query token works and ranges bypass cache with HEAD body omitted', async () => {
    privateRepo = true;
    assert.equal((await run('/repo/a.txt?token=raw-secret')).status, 200);
    const response = await run('/repo/a.txt?token=raw-secret', { method: 'HEAD', headers: { Range: 'bytes=0-3' } });
    assert.equal(await response.text(), '');
    assert.equal(calls.at(-1).headers.Range, 'bytes=0-3');
    assert.equal(calls.at(-1).method, 'GET');
    assert.equal(entries.size, 0);
});
test('integration: invalid webhook secret and unauthorized chats cannot create links', async () => {
    assert.equal((await run('/webhook', webhook('/start', 123, 'wrong'))).status, 401);
    for (const args of [['/start', 12], ['/start', 123, 'hook-secret', 'group']]) {
        assert.equal((await run('/webhook', webhook(...args))).status, 200);
    }
    assert.equal(calls.length, 0);
});
test('integration: untrusted input never triggers external lookup or shortening', async () => {
    for (const input of ['https://evil.example.com/me/repo/src/branch/main/a', 'https://git.example.com/other/repo/src/branch/main/a', 'https://git.example.com/me/nope/src/branch/main/a', 'https://git.example.com/me/repo/src/branch/main/a%2Fb', 'https://git.example.com/me/repo/src/branch/main/a?token=raw-secret https://evil.example.com']) {
        await run('/webhook', webhook(input));
    }
    assert.ok(calls.every(call => call.url.startsWith('https://api.telegram.org/')));
});
test('integration: commands, malformed input, Shlink failures and Telegram failures are handled', async () => {
    assert.equal((await run('/webhook', webhook('/start'))).status, 200);
    assert.match(bodyOf('https://api.telegram.org/').text, /Gitea/);
    assert.equal((await run('/webhook', { ...webhook('x'), body: '{' })).status, 400);
    handler = url => url.includes('/rest/') ? json({}, 503) : undefined;
    assert.equal((await run('/webhook', webhook('https://git.example.com/me/repo/src/branch/main/a'))).status, 200);
    assert.match(JSON.parse(calls.at(-1).body).text, /Shlink/);
    handler = url => url.includes('api.telegram.org') ? json({ ok: false }, 200) : undefined;
    assert.equal((await run('/webhook', webhook('/help'))).status, 502);
});
test('integration: unknown repository, unsupported methods and preflight are handled', async () => {
    assert.equal((await run('/')).status, 200);
    assert.equal((await run('/repo')).status, 400);
    assert.equal((await run('/other/a')).status, 404);
    assert.equal((await run('/repo/a', { method: 'POST' })).status, 405);
    assert.equal((await run('/repo/a', { method: 'OPTIONS' })).status, 204);
    assert.equal(calls.length, 0);
});
test('integration: repository failures never grant access or expose upstream messages', async () => {
    for (const status of [401, 403, 404, 500]) {
        handler = () => new Response('upstream secret', { status });
        const response = await run('/repo/a');
        assert.equal(response.status, status === 404 ? 404 : 502);
        assert.ok(!(await response.text()).includes('upstream secret'));
    }
    handler = () => json({});
    assert.equal((await run('/repo/a')).status, 502);
});
test('integration: upstream raw errors and partial responses preserve useful statuses', async () => {
    for (const status of [404, 401, 500, 416, 206]) {
        handler = url => url.includes('/raw/') ? new Response('part', { status, headers: { 'Content-Range': 'bytes 0-3/10' } }) : undefined;
        const response = await run('/repo/a.bin', { headers: { Range: 'bytes=0-3' } });
        assert.equal(response.status, [401, 500].includes(status) ? 502 : status);
    }
});

test('integration: tag link remains distinct from a branch with the same name', async () => {
    handler = url => url.includes('/tags/') ? json({}) : undefined;
    assert.equal((await run('/webhook', webhook('https://git.example.com/me/repo/src/tag/v1/a.txt'))).status, 200);
    assert.equal(bodyOf('https://go.example.com/rest/').longUrl, 'https://raw.example.com/repo/a.txt?ref=refs%2Ftags%2Fv1');
});
test('integration: commit links keep the commit rather than tracking default branch', async () => {
    await run('/webhook', webhook('https://git.example.com/me/repo/src/commit/abc1234/a.txt'));
    assert.equal(bodyOf('https://go.example.com/rest/').longUrl, 'https://raw.example.com/repo/a.txt?ref=abc1234');
});
test('integration: upstream network failure produces 502 without leaking details', async () => {
    handler = () => { throw new Error('raw-secret'); };
    const response = await run('/repo/a.txt');
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('raw-secret'));
});
test('integration: invalid upstream JSON and malformed Shlink response are rejected', async () => {
    handler = () => new Response('not json');
    assert.equal((await run('/repo/a.txt')).status, 502);
    for (const shortUrl of [null, 'http://insecure.example.com/a', 'https://user:pass@go.example.com/a']) {
        handler = url => url.includes('/rest/') ? json({ shortUrl }) : undefined;
        await run('/webhook', webhook('https://git.example.com/me/repo/src/branch/main/a'));
        assert.match(JSON.parse(calls.at(-1).body).text, /Shlink/);
    }
});
test('integration: missing private tokens fail closed', async () => {
    privateRepo = true;
    const noGiteaToken = { ...baseEnv, GITEA_TOKEN: '' };
    assert.equal((await run('/repo/a', {}, noGiteaToken)).status, 404);
    assert.equal((await run('/repo/a', {}, { ...baseEnv, TOKEN: '' })).status, 500);
});
test('integration: missing refs and invalid refs do not silently use default branch', async () => {
    await run('/webhook', webhook('https://git.example.com/me/repo/src/branch/missing/a.txt'));
    assert.ok(!calls.some(call => call.url.includes('/rest/')));
    assert.equal((await run('/repo/a.txt?ref=')).status, 400);
});
