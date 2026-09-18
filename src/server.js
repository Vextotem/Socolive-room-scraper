import http from 'node:http';
import { createMediaProxy } from './proxy.js';
import { scrapeMatches, filterMatches } from './matches.js';
import { pathToFileURL } from 'node:url';
import { scrapeRoom, ScraperError } from './scraper.js';

export function createServer(scrape = scrapeRoom, scrapeAll = scrapeMatches, proxyFetch = globalThis.fetch) {
  let catalogPending;
  const getCatalog = () => {
    if (!catalogPending) catalogPending = Promise.resolve().then(scrapeAll).finally(() => { catalogPending = null; });
    return catalogPending;
  };
  // Deduplicate simultaneous requests; do not cache signed stream URLs locally.
  const pending = new Map();
  const getRoom = id => {
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= 20) throw new ScraperError('Too many upstream requests. Try again shortly.', 503);
    const task = Promise.resolve().then(() => scrape(id)).finally(() => pending.delete(id));
    pending.set(id, task);
    return task;
  };
  const proxy = createMediaProxy(getRoom, proxyFetch);
  return http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body, null, 2));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (await proxy(req, res, url)) return;
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return json(405, { success: false, error: 'Method not allowed.' });
      }
      if (url.pathname === '/health') return json(200, { status: 'ok' });
      if (url.pathname === '/') return json(200, {
        name: 'Socolive room scraper',
        endpoints: ['/proxy/room/607552.m3u8', '/proxy/room/607552.flv', '/api/matches', '/api/live', '/health', '/api/room/607552', '/api/stream/607552', '/stream/607552.m3u8?quality=hd'],
      });
      if (url.pathname === '/api/matches') {
        // Validate filters before making upstream requests.
        filterMatches({ matches: [], total: 0 }, url.searchParams);
        return json(200, { success: true, data: filterMatches(await getCatalog(), url.searchParams) });
      }
      if (url.pathname === '/api/live') {
        const data = await getCatalog();
        return json(200, { success: true, data: {
          fetchedAt: data.fetchedAt, partial: data.partial, warnings: data.warnings,
          total: data.liveRoomCount, rooms: data.liveRooms,
        } });
      }
      const api = url.pathname.match(/^\/api\/(?:room|stream)\/(\d{1,12})\/?$/);
      const playback = url.pathname.match(/^\/stream\/(\d{1,12})\.m3u8$/);
      if (!api && !playback) return json(404, { success: false, error: 'Route not found.' });
      const quality = url.searchParams.get('quality') || 'hd';
      if (playback && !['hd', 'sd'].includes(quality)) return json(400, { success: false, error: 'quality must be hd or sd.' });
      const data = await getRoom((api || playback)[1]);
      if (api) return json(200, { success: true, data });
      const hls = data.streams.filter(item => item.type === 'hls');
      const selected = hls.find(item => item.quality.toLowerCase() === quality) || hls[0];
      if (!selected) return json(404, { success: false, error: data.live ? 'No HLS stream is available.' : 'This room is offline.' });
      res.writeHead(302, { Location: selected.url, 'Cache-Control': 'no-store' });
      res.end();
    } catch (error) {
      json(error instanceof ScraperError ? error.status : 500, {
        success: false,
        error: error instanceof ScraperError ? error.message : 'Internal server error.',
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8000);
  const server = createServer();
  server.listen(port, '0.0.0.0', () => console.log(`Socolive scraper listening on port ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
