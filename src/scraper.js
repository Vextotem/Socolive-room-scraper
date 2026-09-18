export class ScraperError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function roomId(input) {
  const value = String(input || '').trim();
  if (/^\d{1,12}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const expected = new URL(process.env.SITE_ORIGIN || 'https://m.socolivewl.net').hostname;
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== expected) throw new Error();
    const match = url.pathname.match(/^\/room\/(\d{1,12})\/?$/);
    if (match) return match[1];
  } catch { /* Return the same validation error for all invalid inputs. */ }
  throw new ScraperError('Provide a numeric room ID or a room URL from the configured website.', 400);
}

export function parseDetail(text) {
  const source = text.replace(/^\uFEFF/, '').trim();
  const wrapped = source.match(/^detail\s*\(\s*([\s\S]*)\s*\)\s*;?$/);
  let body;
  try {
    // Parse JSON only. Never execute the upstream JSONP as JavaScript.
    body = JSON.parse(wrapped ? wrapped[1] : source);
  } catch {
    throw new ScraperError('The upstream room response is not valid JSON/JSONP.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ScraperError('The upstream room response has an unexpected format.');
  }
  if (body.code !== undefined && Number(body.code) !== 200) {
    throw new ScraperError('The upstream website did not return a successful room response.');
  }
  if (!body.data?.room) throw new ScraperError('The upstream response contains no room.');
  return body.data;
}

function mediaUrl(value, extension) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (!url.pathname.toLowerCase().endsWith(extension)) return null;
    // Keep the exact signed query string received from the website.
    return value;
  } catch { return null; }
}

export function normalizeRoom(data, id, siteOrigin) {
  const room = data.room;
  if (String(room.roomNum) !== id) throw new ScraperError('The upstream response belongs to a different room.');
  const live = Number(room.liveStatus) === 1;
  const stream = data.stream || {};
  const candidates = [
    ['HD', 'hls', stream.hdM3u8, '.m3u8'],
    ['SD', 'hls', stream.m3u8, '.m3u8'],
    ['HD', 'flv', stream.hdFlv, '.flv'],
    ['SD', 'flv', stream.flv, '.flv'],
  ];
  const seen = new Set();
  const streams = live ? candidates.flatMap(([quality, type, raw, extension]) => {
    const url = mediaUrl(raw, extension);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ quality, type, url, proxyUrl: `/proxy/room/${id}.${type === 'hls' ? 'm3u8' : 'flv'}?quality=${quality.toLowerCase()}` }];
  }) : [];
  return {
    roomId: id,
    title: room.title || '',
    live,
    liveStatus: room.liveStatus,
    roomUrl: `${siteOrigin}/room/${id}`,
    streams,
    playbackUrl: streams.find(item => item.type === 'hls')?.url || null,
    proxyUrl: live && streams.some(item => item.type === 'hls') ? `/proxy/room/${id}.m3u8` : null,
    playbackVerified: false,
    fetchedAt: new Date().toISOString(),
  };
}

export async function scrapeRoom(input, { fetchImpl = globalThis.fetch } = {}) {
  const id = roomId(input);
  const siteOrigin = new URL(process.env.SITE_ORIGIN || 'https://m.socolivewl.net').origin;
  const dataOrigin = new URL(process.env.DATA_ORIGIN || 'https://json.vnres.co').origin;
  const endpoint = new URL(`/room/${id}/detail.json`, dataOrigin);
  // Match the website's minute-based cache key; never reuse a pasted auth_key.
  endpoint.searchParams.set('v', String(Math.floor(Date.now() / 60000) * 60000));
  const configuredTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 20000;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': `${siteOrigin}/`,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new ScraperError(`Upstream returned HTTP ${response.status}.`, response.status === 404 ? 404 : 502);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new ScraperError('Upstream response exceeds the 2 MB limit.');
      }
      chunks.push(value);
    }
    return normalizeRoom(parseDetail(Buffer.concat(chunks).toString('utf8')), id, siteOrigin);
  } catch (error) {
    if (error instanceof ScraperError) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new ScraperError('The upstream request timed out.', 504);
    throw new ScraperError('Unable to reach the upstream room endpoint. Check server connectivity.');
  }
}
