import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ScraperError } from './scraper.js';

// SESSION_SECRET is preferred; PROXY_SECRET preserves existing deployments.
const secret = process.env.SESSION_SECRET || process.env.PROXY_SECRET || randomBytes(32).toString('hex');
const allowedHosts = new Set((process.env.PROXY_ALLOWED_HOSTS || 'pull.niues.live,pull06.scstream.net').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

export function validateTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new ScraperError('Invalid media URL.', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.port || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new ScraperError('This media host is not configured for proxying.', 403);
  }
  return url;
}

export function resourceLink(value, playlist = false) {
  validateTarget(value);
  const payload = Buffer.from(JSON.stringify({ url: value, playlist, exp: Date.now() + 6 * 3600000 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `/proxy/resource?token=${payload}.${signature}`;
}

export function decodeToken(token) {
  if (typeof token !== 'string' || token.length > 16000) throw new ScraperError('Invalid proxy token.', 403);
  const [payload, signature, extra] = token.split('.');
  const expected = createHmac('sha256', secret).update(payload || '').digest('base64url');
  if (extra || !signature || Buffer.byteLength(signature) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new ScraperError('Invalid proxy token.', 403);
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new ScraperError('Invalid proxy token.', 403); }
  if (!Number.isFinite(data.exp) || data.exp < Date.now()) throw new ScraperError('Proxy link expired. Reload the room proxy URL.', 410);
  validateTarget(data.url);
  return data;
}

export function rewritePlaylist(text, baseUrl) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new ScraperError('Upstream did not return an HLS playlist.');
  let nextIsPlaylist = false;
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXT-X-STREAM-INF:')) nextIsPlaylist = true;
      const playlistTag = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/.test(trimmed);
      return line.replace(/\bURI="([^"]+)"/g, (_, uri) => {
        // Embedded keys contain bytes, not an upstream request.
        if (uri.startsWith('data:')) return `URI="${uri}"`;
        const absolute = new URL(uri, baseUrl).href;
        return `URI="${resourceLink(absolute, playlistTag || new URL(absolute).pathname.endsWith('.m3u8'))}"`;
      });
    }
    const absolute = new URL(trimmed, baseUrl).href;
    const link = resourceLink(absolute, nextIsPlaylist || new URL(absolute).pathname.endsWith('.m3u8'));
    nextIsPlaylist = false;
    return link;
  }).join('\n');
}

export function createMediaProxy(getRoom, fetchImpl = globalThis.fetch) {
  return async function proxy(req, res, requestUrl) {
    if (!requestUrl.pathname.startsWith('/proxy/')) return false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    if (!['GET', 'HEAD'].includes(req.method)) throw new ScraperError('Method not allowed.', 405);
    let target, playlist;
    if (requestUrl.pathname === '/proxy/resource') {
      const data = decodeToken(requestUrl.searchParams.get('token'));
      target = data.url;
      playlist = data.playlist;
    } else {
      const match = requestUrl.pathname.match(/^\/proxy\/room\/(\d{1,12})\.(m3u8|flv)$/);
      if (!match) throw new ScraperError('Proxy route not found.', 404);
      const quality = requestUrl.searchParams.get('quality') || 'hd';
      if (!['hd', 'sd'].includes(quality)) throw new ScraperError('quality must be hd or sd.', 400);
      const room = await getRoom(match[1]);
      const type = match[2] === 'm3u8' ? 'hls' : 'flv';
      const streams = room.streams.filter(item => item.type === type);
      const stream = streams.find(item => item.quality.toLowerCase() === quality) || streams[0];
      if (!stream) throw new ScraperError(room.live ? 'No matching stream is available.' : 'This room is offline.', 404);
      target = stream.url;
      playlist = type === 'hls';
    }
    validateTarget(target);
    const controller = new AbortController();
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 30000); timer.unref(); };
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', close);
    arm();
    try {
      const origin = new URL(process.env.SITE_ORIGIN || 'https://m.socolivewl.net').origin;
      const headers = { 'User-Agent': 'Mozilla/5.0', Referer: origin + '/', Origin: origin, 'Accept-Encoding': 'identity' };
      if (!playlist && req.headers.range) headers.Range = req.headers.range;
      let response;
      for (let redirects = 0; redirects <= 5; redirects++) {
        validateTarget(target);
        response = await fetchImpl(target, { method: req.method === 'HEAD' && !playlist ? 'HEAD' : 'GET', headers, redirect: 'manual', signal: controller.signal });
        if (![301,302,303,307,308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 5) throw new ScraperError('Invalid or excessive media redirects.');
        target = new URL(location, target).href;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 416 && response.headers.has('content-range')) res.setHeader('Content-Range', response.headers.get('content-range'));
        throw new ScraperError(`Media upstream returned HTTP ${response.status}.`, response.status === 416 ? 416 : 502);
      }
      const contentType = response.headers.get('content-type') || '';
      playlist ||= /mpegurl/i.test(contentType) || new URL(target).pathname.endsWith('.m3u8');
      res.setHeader('Cache-Control', 'no-store');
      if (playlist) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          size += value.length;
          if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new ScraperError('HLS playlist exceeds 4 MB.'); }
          chunks.push(value);
        }
        const body = rewritePlaylist(Buffer.concat(chunks).toString('utf8'), target);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(body) });
        res.end(req.method === 'HEAD' ? undefined : body);
      } else {
        for (const header of ['content-type', 'content-range', 'accept-ranges']) {
          if (response.headers.has(header)) res.setHeader(header, response.headers.get(header));
        }
        if (!response.headers.has('content-encoding') && response.headers.has('content-length')) res.setHeader('Content-Length', response.headers.get('content-length'));
        res.writeHead(response.status);
        if (req.method === 'HEAD' || !response.body) { await response.body?.cancel(); res.end(); }
        else await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) { arm(); callback(null, chunk); } }), res, { signal: controller.signal });
      }
      return true;
    } catch (error) {
      controller.abort();
      if (res.headersSent || res.destroyed) { res.destroy(); return true; }
      if (error instanceof ScraperError) throw error;
      throw new ScraperError(controller.signal.aborted ? 'Media proxy connection failed or timed out.' : 'Unable to fetch media.', 502);
    } finally { clearTimeout(timer); res.off('close', close); }
  };
}
