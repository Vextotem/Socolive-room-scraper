import test from 'node:test';
import assert from 'node:assert/strict';
import { rewritePlaylist, resourceLink, decodeToken, validateTarget } from '../src/proxy.js';
import { createServer } from '../src/server.js';
const base = 'https://pull.niues.live/live/master.m3u8?auth_key=original';
const tokenFrom = link => new URL(link, 'http://localhost').searchParams.get('token');

test('rewrites master, alternate tracks, segments, keys and init maps', () => {
  const playlist = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8?auth_key=a"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvideo.m3u8?auth_key=b\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?sig=c"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\nsegment.ts?sig=d\n';
  const result = rewritePlaylist(playlist, base);
  const refs = [...result.matchAll(/\/proxy\/resource\?token=[A-Za-z0-9_.-]+/g)].map(m=>decodeToken(tokenFrom(m[0])));
  assert.equal(refs.length,5);
  assert.equal(refs[0].url,'https://pull.niues.live/live/audio.m3u8?auth_key=a');
  assert.equal(refs[1].playlist,true);
  assert.equal(refs[2].url,'https://pull.niues.live/live/key.bin?sig=c');
  assert.equal(refs[4].url,'https://pull.niues.live/live/segment.ts?sig=d');
  assert(!result.includes('auth_key=original')); // Do not invent inherited query parameters.
});

test('rejects tampered links, arbitrary hosts and non-HLS responses', () => {
  const token=tokenFrom(resourceLink(base,true));
  assert.equal(decodeToken(token).url,base);
  assert.throws(()=>decodeToken(token+'x'));
  assert.throws(()=>validateTarget('http://127.0.0.1/private'));
  assert.throws(()=>validateTarget('https://pull.niues.live.evil.example/a'));
  assert.throws(()=>rewritePlaylist('<html>error</html>',base));
});

test('serves nested playlists, ranged segments, CORS, HEAD, FLV and blocks redirects to unapproved hosts', async () => {
  const calls=[];
  const upstream=async(url,options)=>{
    calls.push({url,options});
    const path=new URL(url).pathname;
    if(path.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nchild.m3u8?auth_key=child\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}});
    if(path.endsWith('child.m3u8')) return new Response('#EXTM3U\n#EXTINF:5,\npart.ts?token=signed\n');
    if(path.endsWith('part.ts')) return new Response(Buffer.from([1,2,3]),{status:206,headers:{'content-type':'video/mp2t','content-range':'bytes 0-2/9','content-length':'3'}});
    if(path.endsWith('live.flv')) return new Response(options.method==='HEAD'?null:'FLV',{headers:{'content-type':'video/x-flv'}});
    return new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}});
  };
  const server=createServer(async()=>({live:true,streams:[{type:'hls',quality:'HD',url:base},{type:'flv',quality:'HD',url:'https://pull06.scstream.net/live.flv'}]}),async()=>({}),upstream);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    const response=await fetch(origin+'/proxy/room/607552.m3u8');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('access-control-allow-origin'),'*');
    const child=(await response.text()).trim().split('\n').at(-1);
    const segment=(await (await fetch(origin+child)).text()).trim().split('\n').at(-1);
    const bytes=await fetch(origin+segment,{headers:{Range:'bytes=0-2'}});
    assert.equal(bytes.status,206);
    assert.equal(bytes.headers.get('content-range'),'bytes 0-2/9');
    assert.deepEqual([...new Uint8Array(await bytes.arrayBuffer())],[1,2,3]);
    assert.equal(calls.at(-1).options.headers.Range,'bytes=0-2');
    assert.equal((await fetch(origin+'/proxy/room/607552.m3u8',{method:'OPTIONS'})).status,204);
    assert.equal((await fetch(origin+'/proxy/room/607552.flv')).headers.get('content-type'),'video/x-flv');
    assert.equal((await fetch(origin+'/proxy/room/607552.flv',{method:'HEAD'})).status,200);
    assert.equal((await fetch(origin+resourceLink('https://pull.niues.live/redirect'))).status,403);
    assert(!calls.some(call=>call.url.includes('127.0.0.1')));
  } finally {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
});
