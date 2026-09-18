import test from 'node:test';
import assert from 'node:assert/strict';
import { roomId, parseDetail, normalizeRoom, scrapeRoom } from '../src/scraper.js';
import { createServer } from '../src/server.js';

const hd = 'https://pull.niues.live/live/stream-607552_lhd.m3u8?auth_key=123-0-0-test';
const sd = 'https://pull.niues.live/live/stream-607552_lsd.m3u8?auth_key=123-0-0-test';
const fixture = { code: 200, data: { room: { roomNum: '607552', title: 'Example match', liveStatus: 1 }, stream: { hdM3u8: hd, m3u8: sd } } };

test('accepts the supplied room URL, ignoring undefined scheduleId', () => {
  assert.equal(roomId('https://m.socolivewl.net/room/607552?scheduleId=undefined'), '607552');
  assert.throws(() => roomId('https://elsewhere.example/room/607552'));
  assert.throws(() => roomId('../607552'));
});

test('parses JSONP and escaped signed URLs without executing code', () => {
  const data = parseDetail('detail(' + JSON.stringify(fixture).replaceAll('=', '\\u003d') + ');');
  assert.equal(data.stream.hdM3u8, hd);
  assert.throws(() => parseDetail('detail({}); process.exit()'));
  assert.throws(() => parseDetail('detail({"code":403})'));
  assert.throws(() => parseDetail('null'));
});

test('HD first; excludes segments and mismatched rooms; offline has no streams', () => {
  const data = normalizeRoom(fixture.data, '607552', 'https://m.socolivewl.net');
  assert.equal(data.playbackUrl, hd);
  assert.equal(data.streams.length, 2);
  assert.throws(() => normalizeRoom(fixture.data, '999', 'https://m.socolivewl.net'));
  const offline = structuredClone(fixture.data);
  offline.room.liveStatus = 0;
  assert.equal(normalizeRoom(offline, '607552', 'https://m.socolivewl.net').streams.length, 0);
  const segment = structuredClone(fixture.data);
  segment.stream.hdM3u8 = hd.replace('.m3u8', '.ts');
  assert.equal(normalizeRoom(segment, '607552', 'https://m.socolivewl.net').playbackUrl, sd);
});

test('fetch uses discovered endpoint, parses result, handles errors', async () => {
  const result = await scrapeRoom('607552', { fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/room/607552/detail.json');
    assert(url.searchParams.has('v'));
    assert(options.headers.Referer);
    return new Response('detail(' + JSON.stringify(fixture) + ')');
  } });
  assert.equal(result.playbackUrl, hd);
  await assert.rejects(scrapeRoom('607552', { fetchImpl: async () => new Response('', { status: 404 }) }), { status: 404 });
});

test('HTTP API, health, SD redirect and invalid quality', async () => {
  const data = normalizeRoom(fixture.data, '607552', 'https://m.socolivewl.net');
  const server = createServer(async () => data);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/health')).status, 200);
    const result = await (await fetch(base + '/api/room/607552')).json();
    assert.equal(result.data.playbackUrl, hd);
    const redirect = await fetch(base + '/stream/607552.m3u8?quality=sd', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), sd);
    assert.equal((await fetch(base + '/stream/607552.m3u8?quality=bad')).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
