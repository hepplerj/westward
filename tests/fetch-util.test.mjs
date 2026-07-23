import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetcher } from '../scripts/lib/fetch-util.mjs';

const noSleep = async () => {};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('fetchJson returns parsed JSON on success', async () => {
  const f = createFetcher({ fetchImpl: async () => jsonResponse({ a: 1 }), sleep: noSleep });
  assert.deepEqual(await f.fetchJson('http://x/'), { a: 1 });
});

test('fetchJson retries on 429 then succeeds', async () => {
  const calls = [];
  const responses = [jsonResponse('', 429), jsonResponse('', 429), jsonResponse({ ok: true })];
  const f = createFetcher({
    fetchImpl: async (url) => { calls.push(url); return responses.shift(); },
    sleep: noSleep,
  });
  assert.deepEqual(await f.fetchJson('http://x/'), { ok: true });
  assert.equal(calls.length, 3);
});

test('fetchJson retries when a 200 response is not JSON (Cloudflare HTML)', async () => {
  const responses = [jsonResponse('<html>challenge</html>'), jsonResponse({ ok: true })];
  const f = createFetcher({ fetchImpl: async () => responses.shift(), sleep: noSleep });
  assert.deepEqual(await f.fetchJson('http://x/'), { ok: true });
});

test('fetchJson throws immediately on 404 without retrying', async () => {
  let calls = 0;
  const f = createFetcher({ fetchImpl: async () => { calls++; return jsonResponse('', 404); }, sleep: noSleep });
  await assert.rejects(() => f.fetchJson('http://x/'), /404/);
  assert.equal(calls, 1);
});

test('fetchJson gives up after retries are exhausted', async () => {
  let calls = 0;
  const f = createFetcher({ retries: 2, fetchImpl: async () => { calls++; return jsonResponse('', 500); }, sleep: noSleep });
  await assert.rejects(() => f.fetchJson('http://x/'), /500/);
  assert.equal(calls, 3); // initial + 2 retries
});

test('throttling sleeps between rapid consecutive requests', async () => {
  const sleeps = [];
  const f = createFetcher({
    minIntervalMs: 1000,
    fetchImpl: async () => jsonResponse({}),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await f.fetchJson('http://x/1');
  await f.fetchJson('http://x/2');
  assert.ok(sleeps.some((ms) => ms > 0 && ms <= 1000), `expected a throttle sleep, got ${JSON.stringify(sleeps)}`);
});

test('fetchText returns body text', async () => {
  const f = createFetcher({ fetchImpl: async () => jsonResponse('<feed/>'), sleep: noSleep });
  assert.equal(await f.fetchText('http://x/'), '<feed/>');
});
