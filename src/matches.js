import { ScraperError } from './scraper.js';

export function parseFeed(text, callback) {
  let source = text.replace(/^\uFEFF/, '').trim();
  const wrapper = source.match(/^([A-Za-z_][\w]*)\s*\(([\s\S]*)\)\s*;?$/);
  if (wrapper) {
    if (wrapper[1] !== callback) throw new ScraperError('Unexpected upstream callback.');
    source = wrapper[2];
  }
  let envelope;
  try { envelope = JSON.parse(source); } catch { throw new ScraperError('Invalid upstream feed JSON.'); }
  if (!envelope || Number(envelope.code) !== 200 || !envelope.data || typeof envelope.data !== 'object') {
    throw new ScraperError('The upstream match feed has an unexpected format.');
  }
  return envelope.data;
}

async function fetchFeed(name, fetchImpl) {
  const url = new URL(`/${name}.json`, process.env.DATA_ORIGIN || 'https://json.vnres.co');
  url.searchParams.set('v', String(Math.floor(Date.now() / 60000) * 60000));
  const timeout = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: new URL(process.env.SITE_ORIGIN || 'https://m.socolivewl.net').origin + '/' },
      signal: AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? timeout : 20000),
    });
    if (!response.ok) throw new ScraperError(`Upstream ${name} returned HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 10 * 1024 * 1024) {
        await reader.cancel();
        throw new ScraperError('Upstream feed exceeds the 10 MB limit.');
      }
      chunks.push(value);
    }
    return parseFeed(Buffer.concat(chunks).toString('utf8'), name);
  } catch (error) {
    if (error instanceof ScraperError) throw error;
    throw new ScraperError(`Unable to fetch upstream ${name}.`);
  }
}

function rows(feed) {
  if (Array.isArray(feed)) return feed;
  if (!feed || typeof feed !== 'object') return [];
  return Object.values(feed).filter(Array.isArray).flat();
}

function id(value) { return /^\d{1,16}$/.test(String(value ?? '')) ? String(value) : null; }
function roomLinks(roomId, origin, scheduleId) {
  return {
    roomId,
    roomUrl: `${origin}/room/${roomId}${scheduleId ? `?scheduleId=${scheduleId}` : ''}`,
    streamApi: `/api/room/${roomId}`,
    playbackUrl: `/stream/${roomId}.m3u8`,
    proxyUrl: `/proxy/room/${roomId}.m3u8`,
  };
}

export function normalizeMatches(scheduleFeeds, roomFeed, now = Date.now()) {
  const origin = new URL(process.env.SITE_ORIGIN || 'https://m.socolivewl.net').origin;
  const rooms = new Map();
  for (const room of rows(roomFeed)) {
    const roomId = id(room?.roomNum);
    if (!roomId || Number(room.liveStatus) !== 1) continue;
    rooms.set(roomId, {
      ...roomLinks(roomId, origin),
      title: room.title || '',
      commentator: room.anchor?.nickName || '',
      cover: room.customCoverUrl || room.cover || null,
      categoryId: room.liveTypeParent ?? null,
      live: true,
    });
  }
  const matches = new Map();
  for (const feed of scheduleFeeds) for (const match of rows(feed)) {
    const scheduleId = id(match?.scheduleId);
    if (!scheduleId) continue;
    if (!matches.has(scheduleId)) {
      const milliseconds = Number(match.matchTime);
      const validTime = Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8640000000000000 - 25200000;
      const startsAt = validTime ? new Date(milliseconds).toISOString() : null;
      const startsAtWIB = validTime ? new Date(milliseconds + 25200000).toISOString().replace('Z', '+07:00') : null;
      matches.set(scheduleId, {
        scheduleId,
        matchId: match.matchId ?? null,
        title: [match.hostName, match.guestName].filter(Boolean).join(' vs '),
        sport: { id: match.categoryId ?? null, name: match.categoryName || '' },
        competition: match.subCateName || '',
        home: { name: match.hostName || '', logo: match.hostIcon || null },
        away: { name: match.guestName || '', logo: match.guestIcon || null },
        startsAt,
        startsAtWIB,
        dateWIB: startsAtWIB?.slice(0, 10) || null,
        schedulePhase: !validTime ? 'unknown' : milliseconds > now ? 'upcoming' : 'started',
        upstreamStatus: match.status ?? null,
        upstreamMatchStatus: match.matchStatus ?? null,
        featured: String(match.hot) === '1',
        matchUrl: `${origin}/pages/matchDetail.html?scheduleId=${scheduleId}`,
        rooms: [],
      });
    }
    const entry = matches.get(scheduleId);
    entry.featured ||= String(match.hot) === '1';
    for (const anchor of Array.isArray(match.anchors) ? match.anchors : []) {
      const roomId = id(anchor?.anchor?.roomNum);
      if (!roomId || entry.rooms.some(room => room.roomId === roomId)) continue;
      entry.rooms.push({
        ...roomLinks(roomId, origin, scheduleId),
        commentator: anchor.nickName || '',
        avatar: anchor.cutOutIcon || anchor.icon || null,
        currentlyBroadcasting: roomFeed == null ? null : rooms.has(roomId),
        currentBroadcastTitle: rooms.get(roomId)?.title || null,
      });
    }
  }
  return {
    matches: [...matches.values()].sort((a, b) => (a.startsAt || '9999').localeCompare(b.startsAt || '9999') || a.scheduleId.localeCompare(b.scheduleId)),
    liveRooms: [...rooms.values()],
  };
}

export async function scrapeMatches({ fetchImpl = globalThis.fetch } = {}) {
  const names = ['matches', 'match_all', 'all_live_rooms'];
  const results = await Promise.allSettled(names.map(name => fetchFeed(name, fetchImpl)));
  const schedules = results.slice(0, 2).filter(result => result.status === 'fulfilled').map(result => result.value);
  if (!schedules.length) throw new ScraperError('Both upstream schedule feeds are unavailable.');
  const warnings = results.flatMap((result, index) => result.status === 'rejected' ? [`${names[index]}: ${result.reason.message}`] : []);
  const normalized = normalizeMatches(schedules, results[2].status === 'fulfilled' ? results[2].value : null);
  return {
    fetchedAt: new Date().toISOString(),
    timezone: 'Asia/Jakarta',
    partial: warnings.length > 0,
    warnings,
    total: normalized.matches.length,
    liveRoomCount: normalized.liveRooms.length,
    ...normalized,
  };
}

export function filterMatches(data, params) {
  const date = params.get('date');
  const sport = params.get('sport')?.toLowerCase();
  const q = params.get('q')?.toLowerCase();
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
    throw new ScraperError('date must be a valid YYYY-MM-DD date in WIB.', 400);
  }
  const matches = data.matches.filter(match =>
    (!date || match.dateWIB === date) &&
    (!sport || String(match.sport.id) === sport || match.sport.name.toLowerCase().includes(sport)) &&
    (!q || `${match.title} ${match.competition}`.toLowerCase().includes(q))
  );
  return { ...data, total: matches.length, totalUnfiltered: data.total, matches };
}
