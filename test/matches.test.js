import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, normalizeMatches, scrapeMatches, filterMatches } from '../src/matches.js';
import { createServer } from '../src/server.js';
const match = {
  scheduleId: 123, categoryId: 1, categoryName: 'Bóng đá', subCateName: 'Test league',
  hostName: 'Home', guestName: 'Away', matchTime: Date.parse('2026-09-18T18:00:00Z'),
  anchors: [{ uid: 777, nickName: 'Commentator', anchor: { roomNum: '9912124' } }],
};
const live = { 0: [{ roomNum: '9912124', title: 'Another match', liveStatus: 1 }] };

test('merges schedule buckets and feeds by schedule ID, merging commentator rooms', () => {
  const second = { ...match, anchors: [{ anchor: { roomNum: '42' } }] };
  const result = normalizeMatches([{ 0: [match], 1: [match] }, { 0: [second, { ...match, scheduleId: 456 }] }], live, 0);
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches[0].rooms.map(r => r.roomId), ['9912124', '42']);
  assert.equal(result.matches[0].rooms[0].currentBroadcastTitle, 'Another match');
  assert.equal(result.matches[0].schedulePhase, 'upcoming');
  assert.equal(result.matches[0].startsAtWIB, '2026-09-19T01:00:00.000+07:00');
  assert.equal(result.matches[0].rooms[0].streamApi, '/api/room/9912124');
});

test('deduplicates live rooms and distinguishes missing live data from offline', () => {
  const result = normalizeMatches([{0:[match]}], { ...live, hot: live[0] });
  assert.equal(result.liveRooms.length, 1);
  assert.equal(normalizeMatches([{0:[match]}], null).matches[0].rooms[0].currentlyBroadcasting, null);
  assert.equal(normalizeMatches([{0:[match]}], {}).matches[0].rooms[0].currentlyBroadcasting, false);
});

test('all feed parser rejects JavaScript and wrong callbacks', () => {
  assert.deepEqual(parseFeed('matches({"code":200,"data":{"0":[]}});', 'matches'), {0:[]});
  assert.throws(() => parseFeed('other({"code":200,"data":{}})', 'matches'));
  assert.throws(() => parseFeed('matches({}); alert(1)', 'matches'));
});

test('parallel feed fetching preserves partial results and reports failures', async () => {
  const fetchImpl = async url => {
    const name = url.pathname.split('/')[1].split('.')[0];
    if (name === 'match_all') return new Response('error', {status:502});
    return new Response(`${name}(${JSON.stringify({code:200,data:name==='matches'?{0:[match]}:live})})`);
  };
  const data = await scrapeMatches({fetchImpl});
  assert.equal(data.total, 1);
  assert.equal(data.liveRoomCount, 1);
  assert.equal(data.partial, true);
  assert.equal(data.warnings.length, 1);
  await assert.rejects(scrapeMatches({fetchImpl:async () => new Response('', {status:503})}));
});

test('WIB date, sport and search filters do not silently paginate matches', () => {
  const data = {total:1,...normalizeMatches([{0:[match]}],live)};
  assert.equal(filterMatches(data,new URLSearchParams('date=2026-09-19&sport=1&q=Home')).total,1);
  assert.equal(filterMatches(data,new URLSearchParams('date=2026-09-18')).total,0);
  assert.throws(() => filterMatches(data,new URLSearchParams('date=2026-02-30')));
});

test('matches and live API endpoints return the full catalog and preserve room routes', async () => {
  const data = {total:1,liveRoomCount:1,partial:false,warnings:[],...normalizeMatches([{0:[match]}],live)};
  const server = createServer(async()=>({roomId:'9912124'}),async()=>data);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await (await fetch(base+'/api/matches')).json()).data.total,1);
    assert.equal((await (await fetch(base+'/api/live')).json()).data.total,1);
    assert.equal((await (await fetch(base+'/api/room/9912124')).json()).data.roomId,'9912124');
    assert.equal((await fetch(base+'/api/matches?date=bad')).status,400);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
