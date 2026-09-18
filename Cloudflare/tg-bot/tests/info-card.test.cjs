const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const vm = require('node:vm');

// Use real SQLite for D1's atomic UPDATE/JSON semantics, and separate VM contexts
// for concurrent Worker instances. Only Telegram's external HTTP API is mocked.
const source = readFileSync(join(__dirname, '../worker.js'), 'utf8').replace('export default {', 'const worker = {');
const exportsSource = `;globalThis.bot = { worker, migrateDb, getUser, updUser, ensureInfoCardBeforeRelay,
    getCfg, setCfg, deleteCfg, handleUpdate,
    rebuildInfoCard, relayToTopic, sendStart, acquireCardLock, releaseCardLock };`;
const profile = { id: 42, first_name: 'Alice', username: 'alice' };
const ok = result => ({ status: 200, json: async () => ({ ok: true, result }) });
const failure = (description, status = 400) => ({ status, json: async () => ({ ok: false, error_code: status, description }) });

async function fixture(t, options = {}) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const calls = [];
    const queries = [];
    let nextId = 100;
    const env = { BOT_TOKEN: 'test', ADMIN_GROUP_ID: '-100', ADMIN_IDS: '99', TELEGRAM_WEBHOOK_SECRET: 'test-secret', TG_BOT_DB: {
        prepare(query) {
            queries.push(query.trim().replace(/\s+/g, ' '));
            let args = [];
            return {
                bind(...values) { args = values; return this; },
                async run() { return { meta: { changes: Number(db.prepare(query).run(...args).changes) } }; },
                async first() { return db.prepare(query).get(...args) || null; },
                async all() {
                    const result = { results: db.prepare(query).all(...args) };
                    await options.onAll?.(query, result);
                    return result;
                }
            };
        },
        batch(statements) { return Promise.all(statements.map(s => s.run())); }
    }};
    const fetch = async (url, init) => {
        const call = { method: url.split('/').pop(), body: JSON.parse(init.body) };
        calls.push(call);
        const override = await options.respond?.(call);
        if (override) return override;
        if (call.method === 'getUserProfilePhotos') return ok({ photos: options.photo === false ? [] : [[{ file_id: 'avatar' }]] });
        if (call.method === 'createForumTopic') return ok({ message_thread_id: 7 });
        if (call.method.startsWith('send') || call.method === 'copyMessage') return ok({ message_id: nextId++ });
        return ok(true);
    };
    function instance() {
        const context = vm.createContext({ fetch, setTimeout, clearTimeout, AbortController, TypeError, Request, Response, URL,
            Date: class extends Date { static now() { return options.now ? options.now() : Date.now(); } },
            console: { log() {}, warn() {}, error() {} } });
        vm.runInContext(source + exportsSource, context, { filename: join(__dirname, '../worker.js') });
        return context.bot;
    }
    const bot = instance();
    await bot.migrateDb(env);
    const info = { name: 'Alice', username: 'alice', ...options.info };
    db.prepare("INSERT INTO users (user_id, topic_id, user_state, user_info_json) VALUES ('42', ?, 'verified', ?)")
        .run(options.topic === undefined ? '7' : options.topic, JSON.stringify(info));
    const cardSends = () => calls.filter(c => ['sendPhoto', 'sendMessage'].includes(c.method)
        && (c.body.caption || c.body.text || '').includes('用户身份卡片'));
    return { bot, env, db, calls, queries, cardSends, instance };
}

function gate() {
    let open;
    const promise = new Promise(resolve => { open = resolve; });
    return { promise, open };
}

for (const textCard of [false, true]) {
    test(`refresh edits an existing ${textCard ? 'text' : 'photo'} card without sending/deleting`, async t => {
        const f = await fixture(t, { info: { card_msg_id: 80, join_date: 1000 }, respond: ({ method }) => {
            if (textCard && method === 'editMessageCaption') return failure('Bad Request: there is no caption in the message to edit');
        }});
        assert.equal(await f.bot.rebuildInfoCard(f.env, '42', '7'), 80);
        assert.equal(f.cardSends().length, 0);
        assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 0);
        assert(f.calls.some(c => c.method === (textCard ? 'editMessageText' : 'editMessageCaption') && c.body.message_id === 80));
    });
}

test('unchanged card is a successful refresh', async t => {
    const f = await fixture(t, { info: { card_msg_id: 80 }, respond: ({ method }) => {
        if (method.startsWith('editMessage')) return failure('Bad Request: message is not modified');
    }});
    assert.equal(await f.bot.rebuildInfoCard(f.env, '42', '7'), 80);
    assert.equal(f.cardSends().length, 0);
});

test('editing permission failure reports failure and never creates a duplicate', async t => {
    const f = await fixture(t, { info: { card_msg_id: 80 }, respond: ({ method }) => {
        if (method.startsWith('editMessage')) return failure("Bad Request: message can't be edited");
    }});
    assert.equal(await f.bot.rebuildInfoCard(f.env, '42', '7'), null);
    assert.equal(f.cardSends().length, 0);
    assert.equal((await f.bot.getUser('42', f.env)).user_info.card_msg_id, 80);
});

test('concurrent first messages across Worker instances create one card before forwarding', async t => {
    const f = await fixture(t, { topic: null });
    const b = f.instance();
    const users = await Promise.all([f.bot.getUser('42', f.env), b.getUser('42', f.env)]);
    const msg = n => ({ chat: { id: 42 }, from: profile, date: 1000, text: 'hello', message_id: n });
    await Promise.all([f.bot.relayToTopic(msg(1), users[0], f.env), b.relayToTopic(msg(2), users[1], f.env)]);
    assert.equal(f.cardSends().length, 1);
    assert.equal(f.calls.filter(c => c.method === 'createForumTopic').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'copyMessage').length, 2);
    const cardIndex = f.calls.findIndex(c => c === f.cardSends()[0]);
    assert(f.calls.every((c, i) => c.method !== 'copyMessage' || i > cardIndex));
    const u = await f.bot.getUser('42', f.env);
    assert(u.user_info.card_msg_id);
    assert.equal(u.card_creating, false);
});

test('concurrent refresh and initial card creation share the same D1 lock', async t => {
    const f = await fixture(t);
    const b = f.instance();
    const u = await f.bot.getUser('42', f.env);
    const ids = await Promise.all([
        f.bot.ensureInfoCardBeforeRelay(f.env, u, profile, '7', 1000),
        b.rebuildInfoCard(f.env, '42', '7')
    ]);
    assert.equal(ids[0], ids[1]);
    assert.equal(f.cardSends().length, 1);
});

test('concurrent replacement of a deleted card creates one replacement', async t => {
    const f = await fixture(t, { info: { card_msg_id: 80 }, respond: ({ method, body }) => {
        if (method.startsWith('editMessage') && body.message_id === 80) return failure('Bad Request: message to edit not found');
    }});
    const b = f.instance();
    const ids = await Promise.all([f.bot.rebuildInfoCard(f.env, '42', '7'), b.rebuildInfoCard(f.env, '42', '7')]);
    assert.equal(ids[0], ids[1]);
    assert.notEqual(ids[0], 80);
    assert.equal(f.cardSends().length, 1);
});

test('late profile writes cannot erase or restore a stale card ID', async t => {
    const f = await fixture(t, { info: { card_msg_id: 80, join_date: 1000, dummy_msg_id: 79 } });
    const stale = await f.bot.getUser('42', f.env);
    await f.bot.updUser('42', { card_info: { card_msg_id: 90, dummy_msg_id: null } }, f.env);
    stale.user_info.note = 'new note';
    await f.bot.updUser('42', { user_info: stale.user_info }, f.env);
    let u = await f.bot.getUser('42', f.env);
    assert.equal(u.user_info.card_msg_id, 90);
    assert.equal(u.user_info.join_date, 1000);
    assert.equal(u.user_info.dummy_msg_id, null);
    assert.equal(u.user_info.note, 'new note');
    await f.bot.updUser('42', { user_info: { name: 'Bob' } }, f.env);
    u = await f.bot.getUser('42', f.env);
    assert.equal(u.user_info.card_msg_id, 90);
});

test('card ID is durable before pinning completes', async t => {
    const entered = gate(), finish = gate();
    const f = await fixture(t, { respond: async ({ method }) => {
        if (method === 'pinChatMessage') { entered.open(); await finish.promise; }
    }});
    const refresh = f.bot.rebuildInfoCard(f.env, '42', '7');
    await entered.promise;
    const u = await f.bot.getUser('42', f.env);
    assert(u.user_info.card_msg_id);
    assert.equal(u.card_creating, true);
    finish.open();
    await refresh;
    assert.equal((await f.bot.getUser('42', f.env)).card_creating, false);
});

test('failed send releases lock and does not blindly retry ambiguous delivery', async t => {
    const f = await fixture(t, { respond: ({ method }) => {
        if (method === 'sendPhoto') throw new TypeError('connection lost');
    }});
    assert.equal(await f.bot.rebuildInfoCard(f.env, '42', '7'), null);
    assert.equal(f.cardSends().length, 1);
    const u = await f.bot.getUser('42', f.env);
    assert.equal(u.card_creating, false);
    assert(!u.user_info.card_msg_id);
});

test('old lock holder cannot release a newer lease', async t => {
    const f = await fixture(t);
    f.db.prepare("UPDATE users SET card_creating=1, card_lock_at=1 WHERE user_id='42'").run();
    const lockAt = await f.bot.acquireCardLock(f.env, '42', '7');
    assert(lockAt > 1);
    await f.bot.releaseCardLock(f.env, '42', 1);
    assert.equal((await f.bot.getUser('42', f.env)).card_lock_at, lockAt);
    await f.bot.releaseCardLock(f.env, '42', lockAt);
    assert.equal((await f.bot.getUser('42', f.env)).card_creating, false);
});

test('refresh from a stale topic never moves or creates a card', async t => {
    const f = await fixture(t, { info: { card_msg_id: 80 } });
    assert.equal(await f.bot.rebuildInfoCard(f.env, '42', '999'), null);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.bot.getUser('42', f.env)).topic_id, '7');
});

test('ordinary forwarding errors do not rebuild the user topic or card', async t => {
    const f = await fixture(t, { info: { card_msg_id: 80 }, respond: ({ method }) => {
        if (['copyMessage', 'forwardMessage'].includes(method)) return failure('Bad Request: message to copy not found');
    }});
    const u = await f.bot.getUser('42', f.env);
    await f.bot.relayToTopic({ chat: { id: 42 }, from: profile, date: 1000, text: 'hello', message_id: 5 }, u, f.env);
    assert.equal(f.cardSends().length, 0);
    assert.equal(f.calls.filter(c => c.method === 'createForumTopic').length, 0);
    assert.equal((await f.bot.getUser('42', f.env)).topic_id, '7');
});

test('integration: webhook → D1 → Telegram, duplicate update and refresh callback', async t => {
    const f = await fixture(t, { topic: null });
    const b = f.instance();
    async function webhook(bot, update) {
        const pending = [];
        const req = new Request('https://test.invalid/', {
            method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' },
            body: JSON.stringify(update)
        });
        const response = await bot.worker.fetch(req, f.env, { waitUntil: p => pending.push(p) });
        assert.equal(response.status, 200);
        await Promise.all(pending);
    }
    const update = n => ({ update_id: n, message: {
        message_id: n, date: 1000, chat: { id: 42, type: 'private' }, from: profile, text: 'hello'
    }});
    await Promise.all([webhook(f.bot, update(1)), webhook(b, update(2))]);
    await webhook(b, update(1));
    assert.equal(f.calls.filter(c => c.method === 'copyMessage').length, 2);
    assert.equal(f.cardSends().length, 1);
    const u = await f.bot.getUser('42', f.env);
    await webhook(b, { update_id: 3, callback_query: {
        id: 'callback', from: { id: 99 }, data: 'refresh_card:42',
        message: { chat: { id: -100 }, message_id: u.user_info.card_msg_id, message_thread_id: 7 }
    }});
    assert.equal(f.cardSends().length, 1);
    assert(f.calls.some(c => c.method === 'editMessageCaption' && c.body.message_id === u.user_info.card_msg_id));
    assert(f.calls.some(c => c.body.text === '✅ 资料卡已刷新'));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
});

const configReads = f => f.queries.filter(q => q === 'SELECT * FROM config').length;

test('missing config keys reuse one snapshot and preserve default/env/empty value precedence', async t => {
    const f = await fixture(t);
    f.env.BUSY_MESSAGE = 'environment reply';
    assert.equal(await f.bot.getCfg('enable_verify', f.env), 'true');
    assert.equal(await f.bot.getCfg('busy_msg', f.env), 'environment reply');
    assert.equal(await f.bot.getCfg('unknown_key', f.env), '');
    assert.equal(configReads(f), 1);
    await f.bot.setCfg('busy_msg', '', f.env);
    assert.equal(await f.bot.getCfg('busy_msg', f.env), '');
    await f.bot.deleteCfg('busy_msg', f.env);
    assert.equal(await f.bot.getCfg('busy_msg', f.env), 'environment reply');
    assert.equal(configReads(f), 3);
});

test('concurrent cold config reads share one database query', async t => {
    const f = await fixture(t);
    const values = await Promise.all(Array.from({ length: 20 }, () => f.bot.getCfg('enable_verify', f.env)));
    assert(values.every(v => v === 'true'));
    assert.equal(configReads(f), 1);
});

test('expired config snapshot reloads once and sees external changes', async t => {
    let now = Date.now();
    const f = await fixture(t, { now: () => now });
    assert.equal(await f.bot.getCfg('busy_mode', f.env), 'false');
    f.db.prepare('INSERT INTO config (key,value) VALUES (?,?)').run('busy_mode', 'true');
    assert.equal(await f.bot.getCfg('busy_mode', f.env), 'false');
    now += 60001;
    assert.equal(await f.bot.getCfg('busy_mode', f.env), 'true');
    assert.equal(configReads(f), 2);
});

for (const deleting of [false, true]) {
    test(`config ${deleting ? 'delete' : 'write'} invalidates an in-flight stale snapshot`, async t => {
        const entered = gate(), finish = gate();
        let blocked = false;
        const f = await fixture(t, { onAll: async query => {
            if (query === 'SELECT * FROM config' && !blocked) {
                blocked = true; entered.open(); await finish.promise;
            }
        }});
        f.db.prepare('INSERT INTO config (key,value) VALUES (?,?)').run('busy_msg', 'old');
        const pending = f.bot.getCfg('busy_msg', f.env);
        await entered.promise;
        if (deleting) await f.bot.deleteCfg('busy_msg', f.env);
        else await f.bot.setCfg('busy_msg', 'new', f.env);
        const laterReader = f.bot.getCfg('busy_msg', f.env);
        finish.open();
        assert.equal(await pending, deleting ? '当前是非营业时间，消息已收到，管理员稍后回复。' : 'new');
        assert.equal(await laterReader, await pending);
        assert.equal(configReads(f), 2);
    });
}

test('failed config read is not cached and can recover on next request', async t => {
    let fail = true;
    const f = await fixture(t, { onAll: async query => {
        if (query === 'SELECT * FROM config' && fail) { fail = false; throw new Error('database unavailable'); }
    }});
    f.db.prepare('INSERT INTO config (key,value) VALUES (?,?)').run('busy_mode', 'true');
    assert.equal(await f.bot.getCfg('busy_mode', f.env), 'false');
    assert.equal(await f.bot.getCfg('busy_mode', f.env), 'true');
    assert.equal(configReads(f), 2);
});

test('admin input state stays fresh across Worker instances including missing keys', async t => {
    const f = await fixture(t), b = f.instance();
    const key = 'admin_state:99';
    assert.equal(await f.bot.getCfg(key, f.env), '');
    await b.setCfg(key, '{"action":"input_note","target":"42"}', f.env);
    assert.equal(await f.bot.getCfg(key, f.env), '{"action":"input_note","target":"42"}');
    await b.deleteCfg(key, f.env);
    assert.equal(await f.bot.getCfg(key, f.env), '');
    assert.equal(configReads(f), 0);
});

test('reverse message lookup uses the index without changing returned mapping', async t => {
    const f = await fixture(t);
    f.db.prepare('INSERT INTO messages (user_id,message_id,topic_message_id) VALUES (?,?,?)').run('42','10','500');
    const query = 'SELECT user_id,message_id FROM messages WHERE topic_message_id=?';
    assert.equal(f.db.prepare(query).get('500').message_id, '10');
    assert(f.db.prepare('EXPLAIN QUERY PLAN ' + query).all('500')
        .some(row => row.detail.includes('USING INDEX idx_messages_topic_message_id')));
    await f.bot.migrateDb(f.env); // The migration remains safe to run again.
    assert.equal(f.db.prepare(query).get('500').user_id, '42');
});

test('legacy text card remembers type after first edit and skips caption calls thereafter', async t => {
    const f = await fixture(t, { info: { card_msg_id: 80 }, respond: ({ method }) => {
        if (method === 'editMessageCaption') return failure('Bad Request: there is no caption in the message to edit');
        if (method === 'editMessageText') return failure('Bad Request: message is not modified');
    }});
    await f.bot.rebuildInfoCard(f.env, '42', '7');
    assert.equal((await f.bot.getUser('42', f.env)).user_info.card_type, 'text');
    f.calls.length = 0;
    assert.equal(await f.instance().rebuildInfoCard(f.env, '42', '7'), 80);
    assert.deepEqual(f.calls.map(c => c.method), ['editMessageText']);
    assert.equal(f.cardSends().length, 0);
});

test('new text cards store type immediately and stale profile writes cannot erase it', async t => {
    const f = await fixture(t, { photo: false });
    const stale = await f.bot.getUser('42', f.env);
    await f.bot.rebuildInfoCard(f.env, '42', '7');
    await f.bot.updUser('42', { user_info: { ...stale.user_info, note: 'test' } }, f.env);
    assert.equal((await f.bot.getUser('42', f.env)).user_info.card_type, 'text');
    f.calls.length = 0;
    await f.bot.rebuildInfoCard(f.env, '42', '7');
    assert.deepEqual(f.calls.map(c => c.method), ['editMessageText']);
});

test('known missing text card can be replaced with a photo card', async t => {
    const f = await fixture(t, { info: { card_msg_id: 80, card_type: 'text' }, respond: ({ method, body }) => {
        if (method === 'editMessageText' && body.message_id === 80) return failure('Bad Request: message to edit not found');
    }});
    const id = await f.bot.rebuildInfoCard(f.env, '42', '7');
    assert.notEqual(id, 80);
    const info = (await f.bot.getUser('42', f.env)).user_info;
    assert.equal(info.card_type, 'photo');
    assert.equal(info.card_msg_id, id);
    assert.equal(f.cardSends().length, 1);
});

test('integration: warm default-config messages use six D1 statements and retain timestamp edits', async t => {
    const f = await fixture(t, { info: { card_msg_id: 80, card_type: 'text', join_date: 1000 } });
    const update = n => ({ update_id: n, message: {
        message_id: n, date: 1000 + n, chat: { id: 42, type: 'private' }, from: profile, text: 'hello'
    }});
    await f.bot.handleUpdate(update(1), f.env, {});
    const previousText = f.calls.find(c => c.method === 'editMessageText').body.text;
    f.queries.length = 0; f.calls.length = 0;
    await f.bot.handleUpdate(update(2), f.env, {});
    assert.equal(f.queries.length, 6);
    assert.equal(configReads(f), 0);
    assert.deepEqual(f.calls.map(c => c.method), ['editMessageText', 'copyMessage']);
    assert.notEqual(f.calls[0].body.text, previousText);
    assert.equal(f.calls[0].body.message_id, 80);
    assert.equal(f.cardSends().length, 0);
});
