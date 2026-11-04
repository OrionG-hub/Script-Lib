import test from 'node:test';
import assert from 'node:assert/strict';
import { config, segments, safeEqual, rawLink } from '../src/common.js';

test('paths preserve unicode and dots within names but reject traversal and separators', () => {
    assert.deepEqual(segments('/repo/a..b/%E4%B8%AD.txt'), ['repo', 'a..b', '中.txt']);
    for (const path of ['/repo/%2e%2e/a', '/repo/a%2Fb', '/repo/%5cfoo', '/repo/%00', '/repo/%zz', '/repo//a']) {
        assert.throws(() => segments(path));
    }
});
test('config requires HTTPS and restricts repository names', () => {
    const env = { GITEA_URL: 'https://git.example.com/gitea/', GITEA_OWNER: 'me', ALLOWED_REPOSITORIES: '["repo"]' };
    assert.equal(config(env).base, 'https://git.example.com/gitea');
    for (const extra of [{ GITEA_URL: 'file:///tmp' }, { GITEA_URL: 'https://user:pass@git.example.com' }, { GITEA_OWNER: '../me' }, { ALLOWED_REPOSITORIES: 'oops' }, { ALLOWED_REPOSITORIES: '{}' }, { ALLOWED_REPOSITORIES: '["../repo"]' }]) {
        assert.throws(() => config({ ...env, ...extra }));
    }
});
test('token comparison does not accept a prefix or an empty token', async () => {
    assert.equal(await safeEqual('secret', 'secret'), true);
    assert.equal(await safeEqual('secretx', 'secret'), false);
    assert.equal(await safeEqual('', ''), false);
});
test('raw URL keeps nondefault branch and never embeds token', () => {
    const env = { RAW_BASE_URL: 'https://raw.example.com', TOKEN: 'secret' };
    assert.equal(rawLink(env, 'repo', '中.txt', 'main', 'main'), 'https://raw.example.com/repo/%E4%B8%AD.txt');
    assert.equal(rawLink(env, 'repo', 'a b.txt', 'feature/foo', 'main'), 'https://raw.example.com/repo/a%20b.txt?ref=feature%2Ffoo');
});
