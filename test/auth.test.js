// Login, sessions, API keys, protected feeds and the password-reset switch.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { API_KEY, startArr } from './fixtures/mock-arr.mjs';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'courarr-auth-'));
process.env.CONFIG_DIR = CONFIG_DIR;
process.env.IMDB_RATINGS_URL = 'off'; // never download the real file in tests

const auth = await import('../server/auth.js');
const store = await import('../server/db.js');
const { app } = await import('../server/app.js');

const servers = [];
let C;
let sonarr;
before(async () => {
  sonarr = await startArr('sonarr', 0);
  const s = await new Promise((r) => {
    const srv = app.listen(0, () => r(srv));
  });
  servers.push(s, sonarr.server);
  C = `http://127.0.0.1:${s.address().port}`;
});
after(() => servers.forEach((s) => (s.closeAllConnections?.(), s.close())));

/** A tiny client: remembers its own session cookie, like one browser. */
function browser() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(C + p, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    const text = await res.text();
    let parsed = text || null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* HTML page */
    }
    return { status: res.status, body: parsed, setCookie: set };
  };
  return { call, ui: (method, p, body) => call(method, p, body, { 'X-Courarr': '1' }), get cookie() { return cookie; } };
}

describe('password helpers', () => {
  test('scrypt hashes verify, reject wrong passwords and are salted', () => {
    const h = auth.hashPassword('hunter2hunter2');
    assert.match(h, /^scrypt\$16384\$8\$1\$/);
    assert.ok(auth.verifyPassword('hunter2hunter2', h));
    assert.ok(!auth.verifyPassword('hunter2hunter3', h));
    assert.notEqual(h, auth.hashPassword('hunter2hunter2'), 'random salt');
    assert.ok(!auth.verifyPassword('x', ''), 'no stored hash');
    assert.ok(!auth.verifyPassword('x', 'md5$abc'), 'unknown scheme');
  });

  test('username and password rules', () => {
    assert.equal(auth.passwordProblem('short'), 'Use at least 8 characters');
    assert.equal(auth.passwordProblem('x'.repeat(300)), 'That password is too long');
    assert.equal(auth.passwordProblem(12345678), 'Use at least 8 characters');
    assert.equal(auth.passwordProblem('long enough'), null);
    assert.ok(auth.usernameProblem('a'));
    assert.ok(auth.usernameProblem('has space'));
    assert.equal(auth.usernameProblem('jp.admin@home'), null);
  });

  test('cookies', () => {
    assert.deepEqual(auth.parseCookies('a=1; courarr_session=x%3Dy; junk'), { a: '1', courarr_session: 'x=y' });
    const req = (secure, proto) => ({ secure, get: (h) => (h === 'x-forwarded-proto' ? proto : undefined) });
    assert.equal(auth.sessionCookie(req(false), 't', null), 'courarr_session=t; Path=/; HttpOnly; SameSite=Lax');
    assert.match(auth.sessionCookie(req(false, 'https'), 't', 86_400_000), /; Secure; Max-Age=86400$/);
    assert.match(auth.sessionCookie(req(true), '', 0), /Max-Age=0$/);
  });
});

describe('first run', () => {
  test('before an account exists, only health, auth and feeds are open', async () => {
    const b = browser();
    assert.equal((await b.call('GET', '/api/health')).status, 200);
    const st = (await b.call('GET', '/api/auth/status')).body;
    assert.deepEqual([st.configured, st.authenticated, st.user], [false, false, null]);
    const lists = await b.call('GET', '/api/lists');
    assert.deepEqual([lists.status, lists.body.code], [401, 'setup']);
    assert.equal((await b.call('POST', '/api/auth/login', { username: 'a', password: 'b' })).status, 409);
    assert.equal((await b.call('GET', '/')).status, 200, 'the page itself loads so it can show the setup screen');
    assert.equal((await b.call('GET', '/feed/nothing')).status, 404, 'feeds never need a login');
  });

  test('creating the account validates, logs in, and can only happen once', async () => {
    const b = browser();
    assert.equal((await b.call('POST', '/api/auth/setup', { username: 'x', password: 'long enough' })).status, 400);
    assert.equal((await b.call('POST', '/api/auth/setup', { username: 'admin', password: 'short' })).status, 400);
    const r = await b.call('POST', '/api/auth/setup', { username: ' admin ', password: 'correct horse' });
    assert.equal(r.status, 201);
    assert.match(r.setCookie, /^courarr_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const st = (await b.call('GET', '/api/auth/status')).body;
    assert.deepEqual([st.configured, st.authenticated, st.user, st.setupComplete], [true, true, 'admin', false]);
    assert.equal((await browser().call('POST', '/api/auth/setup', { username: 'other', password: 'long enough' })).status, 409);
    const s = store.getSettings();
    assert.match(s.apiKey, /^[0-9a-f]{48}$/, 'API key generated');
    assert.match(s.feedKey, /^[0-9a-f]{48}$/);
  });
});

describe('sessions', () => {
  test('login, remember-me, logout and wrong passwords', async () => {
    const b = browser();
    assert.equal((await b.call('GET', '/api/lists')).body.code, 'login');
    const wrong = await b.call('POST', '/api/auth/login', { username: 'admin', password: 'nope nope' });
    assert.deepEqual([wrong.status, wrong.body.error], [401, 'Wrong username or password']);
    assert.equal((await b.call('POST', '/api/auth/login', { username: 'nobody', password: 'correct horse' })).status, 401);
    const short = await b.call('POST', '/api/auth/login', { username: 'ADMIN', password: 'correct horse', remember: false });
    assert.equal(short.status, 200, 'usernames are case-insensitive');
    assert.doesNotMatch(short.setCookie, /Max-Age/, 'a browser-session cookie when not remembered');
    assert.equal((await b.call('GET', '/api/lists')).status, 200);
    assert.equal((await b.call('POST', '/api/auth/logout')).status, 204);
    assert.equal((await b.call('GET', '/api/lists')).status, 401);
  });

  test('changes need the X-Courarr header (no cross-site requests)', async () => {
    const b = browser();
    await b.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const blocked = await b.call('POST', '/api/lists', { name: 'CSRF', target: 'sonarr' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'reload');
    assert.match(blocked.body.error, /out of date.*Reload the page/);
    assert.equal((await b.ui('POST', '/api/lists', { name: 'Allowed', target: 'sonarr' })).status, 201);
    assert.equal((await b.call('GET', '/api/lists')).status, 200, 'reads are fine without it');
  });

  test('expired sessions are refused and cleaned up', async () => {
    const b = browser();
    await b.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    store.db.prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    const expired = () => store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at < ?').get(new Date().toISOString()).n;
    const before = expired();
    assert.equal((await b.call('GET', '/api/lists')).status, 401);
    assert.equal(expired(), before - 1, 'the expired session that was used is deleted');
    await b.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal(expired(), 0, 'logging in sweeps the rest');
  });

  test('the password hash is never sent to the browser', async () => {
    const b = browser();
    await b.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const s = (await b.call('GET', '/api/settings')).body;
    assert.ok(!('authHash' in s));
    assert.equal(s.authUser, 'admin');
    assert.equal((await b.ui('PUT', '/api/settings', { setupComplete: true })).body.setupComplete, true);
  });
});

describe('API key', () => {
  test('scripts use X-Api-Key or ?apikey= (no header or cookie needed)', async () => {
    const key = store.getSettings().apiKey;
    const anon = browser();
    assert.equal((await anon.call('POST', '/api/refresh', undefined, { 'X-Api-Key': key })).status, 202);
    assert.equal((await anon.call('GET', `/api/lists?apikey=${key}`)).status, 200);
    assert.equal((await anon.call('GET', '/api/lists', undefined, { 'X-Api-Key': 'wrong' })).status, 401);
  });

  test('a new key replaces the old one', async () => {
    const b = browser();
    await b.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const old = store.getSettings().apiKey;
    const s = (await b.ui('POST', '/api/auth/keys/api')).body;
    assert.notEqual(s.apiKey, old);
    assert.equal((await browser().call('GET', '/api/lists', undefined, { 'X-Api-Key': old })).status, 401);
    assert.equal((await browser().call('GET', '/api/lists', undefined, { 'X-Api-Key': s.apiKey })).status, 200);
    assert.equal((await b.ui('POST', '/api/auth/keys/other')).status, 404);
  });
});

describe('protected feeds', () => {
  test('feed key required: feeds, feed URLs and linked import lists all follow', async () => {
    const b = browser();
    await b.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await b.ui('PUT', '/api/settings', { sonarrUrl: `http://127.0.0.1:${sonarr.server.address().port}`, sonarrApiKey: API_KEY, feedBaseUrl: 'http://courarr.lan:6161' });
    const list = (await b.ui('POST', '/api/lists', { name: 'Guarded', target: 'sonarr' })).body;
    const il = (await b.ui('PUT', `/api/lists/${list.id}/arr`, { rootFolderPath: '/tv', qualityProfileId: 1 })).body;
    assert.equal(il.url, 'http://courarr.lan:6161/feed/guarded');

    await b.ui('PUT', '/api/settings', { feedKeyRequired: true });
    const key = store.getSettings().feedKey;
    assert.equal(sonarr.state.importLists.get(il.id).fields[0].value, `http://courarr.lan:6161/feed/guarded?key=${key}`, 'linked list updated');
    assert.equal((await b.call('GET', `/api/lists/${list.id}/arr`)).body.feedUrl, `http://courarr.lan:6161/feed/guarded?key=${key}`);

    const anon = browser();
    const denied = await anon.call('GET', '/feed/guarded');
    assert.equal(denied.status, 401);
    assert.match(denied.body.error, /key/);
    assert.equal((await anon.call('GET', '/feed/guarded?key=wrong')).status, 401);
    assert.deepEqual((await anon.call('GET', `/feed/guarded?key=${key}`)).body, []);
    assert.equal((await anon.call('GET', '/feed/guarded', undefined, { 'X-Api-Key': key })).status, 200);

    const fresh = (await b.ui('POST', '/api/auth/keys/feed')).body.feedKey;
    assert.notEqual(fresh, key);
    assert.match(sonarr.state.importLists.get(il.id).fields[0].value, new RegExp(`key=${fresh}$`), 'new key pushed to Sonarr');
    assert.equal((await anon.call('GET', `/feed/guarded?key=${key}`)).status, 401, 'old key stops working');

    await b.ui('PUT', '/api/settings', { feedKeyRequired: false });
    assert.equal(sonarr.state.importLists.get(il.id).fields[0].value, 'http://courarr.lan:6161/feed/guarded');
    assert.equal((await anon.call('GET', '/feed/guarded')).status, 200);
  });
});

describe('changing the login', () => {
  test('needs the current password; a new password signs out other browsers', async () => {
    const mine = browser();
    const other = browser();
    await mine.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await other.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal((await mine.ui('PUT', '/api/auth/account', { current: 'wrong', password: 'new password 1' })).status, 400);
    assert.equal((await mine.ui('PUT', '/api/auth/account', { current: 'correct horse', password: 'short' })).status, 400);
    assert.equal((await mine.ui('PUT', '/api/auth/account', { current: 'correct horse', username: 'no spaces allowed' })).status, 400);
    const r = await mine.ui('PUT', '/api/auth/account', { current: 'correct horse', username: 'owner', password: 'new password 1' });
    assert.deepEqual([r.status, r.body.user], [200, 'owner']);
    assert.equal((await mine.call('GET', '/api/lists')).status, 200, 'this browser stays signed in');
    assert.equal((await other.call('GET', '/api/lists')).status, 401, 'others are signed out');
    assert.equal((await browser().call('POST', '/api/auth/login', { username: 'owner', password: 'new password 1' })).status, 200);
    // renaming alone keeps every session
    await mine.ui('PUT', '/api/auth/account', { current: 'new password 1', username: 'admin' });
    assert.equal((await mine.call('GET', '/api/auth/status')).body.user, 'admin');
  });

  test('too many wrong passwords from one address are blocked for a while', async () => {
    const b = browser();
    for (let i = 0; i < 8; i++) await b.call('POST', '/api/auth/login', { username: 'admin', password: `guess ${i}` });
    const r = await b.call('POST', '/api/auth/login', { username: 'admin', password: 'new password 1' });
    assert.equal(r.status, 429, 'even the right password waits');
    assert.match(r.body.error, /Too many failed attempts/);
  });
});

describe('password reset on start-up', () => {
  const freePort = () =>
    new Promise((r) => {
      const s = net.createServer().listen(0, () => {
        const { port } = s.address();
        s.close(() => r(port));
      });
    });
  const startServer = async (env) => {
    const port = await freePort();
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
      env: { ...process.env, CONFIG_DIR, PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    for (let i = 0; i < 100 && !/listening on/.test(log); i++) await new Promise((r) => setTimeout(r, 50));
    return { child, port, log: () => log };
  };

  test('COURARR_RESET_AUTH=true removes the login so a new one can be created', async () => {
    assert.equal(auth.isConfigured(), true);
    const normal = await startServer({});
    try {
      const st = await (await fetch(`http://127.0.0.1:${normal.port}/api/auth/status`)).json();
      assert.equal(st.configured, true);
    } finally {
      normal.child.kill();
    }
    const reset = await startServer({ COURARR_RESET_AUTH: 'true' });
    try {
      assert.match(reset.log(), /the login was removed/);
      const st = await (await fetch(`http://127.0.0.1:${reset.port}/api/auth/status`)).json();
      assert.equal(st.configured, false);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'all sessions ended');
    } finally {
      reset.child.kill();
    }
  });
});
