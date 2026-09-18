# Socolive room scraper

A dependency-free Node.js scraper and HTTP API for `m.socolivewl.net`.
Returns the signed HD/SD HLS and FLV URLs published by the website for a room.
Default room example: `607552`.

## Media proxy (v1.2)

Use these URLs in your HLS/FLV player to relay media through this server:

```text
GET /proxy/room/607552.m3u8
GET /proxy/room/607552.m3u8?quality=sd
GET /proxy/room/607552.flv
GET /proxy/room/607552.flv?quality=sd
```

The room endpoint fetches the current upstream stream URL. HLS responses are
rewritten so master/variant playlists, alternate audio/subtitles, segments,
AES keys, and initialization maps use signed `/proxy/resource?token=...` URLs.
Relative media paths are resolved against the final upstream playlist URL.
Existing signed query strings are preserved; the proxy does not invent or
renew the upstream provider's authorization signatures.

The proxy supports GET, HEAD, OPTIONS, cross-origin media requests, streaming
FLV, and byte-range requests for media segments. Binary media is streamed with
backpressure rather than buffered in memory. A stalled upstream connection is
aborted after 30 seconds of inactivity. Playlists are limited to 4 MB.

Room API responses include a top-level `proxyUrl` for HLS and a `proxyUrl` on
each stream. Match commentator rooms and live-room entries include `proxyUrl`.
These are relative paths: prefix them with your scraper's public origin.
The existing `/stream/ROOM_ID.m3u8` endpoint remains a direct upstream redirect;
choose `/proxy/room/ROOM_ID.m3u8` to send media through your server instead.

Configure the following environment variables before importing/starting Node:

| Variable | Default / purpose |
| --- | --- |
| `PROXY_ALLOWED_HOSTS` | `pull.niues.live,pull06.scstream.net` — exact upstream media hostnames |
| `SESSION_SECRET` | Preferred signing secret; use one stable random secret across replicas/restarts |
| `PROXY_SECRET` | Legacy fallback, used only when `SESSION_SECRET` is unset or empty |

Generate a stable secret with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy it into `SESSION_SECRET` in Coolify or your environment. Never place it in
frontend code. Use at least 32 random bytes. If both variables are unset, a random per-process
secret is generated. `SESSION_SECRET` signs proxy resource links; it does not
create login sessions or restrict access to the public room endpoints.
Signed child-resource links last six hours. Restarting without
a stable secret invalidates existing links; reload the room proxy URL.
To migrate without invalidating active links, set `SESSION_SECRET` to your
existing `PROXY_SECRET` value. Changing the value invalidates old resource links.
If upstream authorization expires during playback, reload the room proxy URL
to obtain current upstream credentials.

Only configured media hosts are allowed, including redirect destinations and
playlist references. If the provider introduces another legitimate CDN/key host,
add its exact hostname to `PROXY_ALLOWED_HOSTS` alongside the existing hosts.
There is no arbitrary `?url=` open-proxy endpoint. Resource signatures bind URLs;
they do not authenticate your viewers. The room endpoints are publicly usable
wherever you expose this server. Proxy traffic consumes your server bandwidth.
The proxy cannot guarantee availability or remove upstream access restrictions.

Fourteen tests pass, including a mock upstream integration test that follows
rewritten nested playlists and retrieves ranged segment bytes through the HTTP
proxy. These tests do not establish live upstream video playback availability.

## All matches (v1.1)

```bash
curl http://localhost:8000/api/matches
curl http://localhost:8000/api/live
npm run scrape -- all
```

`GET /api/matches` returns every unique schedule entry currently published by
both public schedule feeds (`matches.json` and `match_all.json`). It also returns
all unique currently broadcasting rooms from `all_live_rooms.json`. There is no
pagination or hidden match limit. This covers the website's available feed
window, not every historical or future match ever scheduled.

Response fields: `success`, then `data` containing `fetchedAt`, `timezone`,
`partial`, `warnings`, `total`, `totalUnfiltered`, `liveRoomCount`, `matches`,
and `liveRooms`. `totalUnfiltered` is included by the HTTP endpoint.

Each match contains teams and logos, sport, competition, UTC/WIB start times,
schedule ID, website link, raw upstream status values, and commentator rooms.
Each room includes `streamApi` and `playbackUrl` relative to this server.
Request those URLs to resolve fresh signed media URLs when playback is needed.
The all-matches response does not eagerly fetch hundreds of room stream URLs.

Filters are optional and may be combined:

```text
GET /api/matches?date=2026-09-19
GET /api/matches?sport=1
GET /api/matches?q=Bayern
GET /api/matches?date=2026-09-19&sport=1&q=Bayern
```

`date` uses WIB (Asia/Jakarta). `sport` matches the upstream numeric category ID
or a case-insensitive portion of its name, which is generally Vietnamese.
`q` searches team names and competition names. Filters apply to `matches`;
`liveRooms` remains the complete live-room catalog.

`GET /api/live` returns `data.rooms`, with the same live-room catalog and its
count, fetch time, and partial-result warnings.

Matches are deduplicated by `scheduleId`, not `matchId` (which can be zero).
Room IDs come from `anchor.roomNum`, not the commentator's user ID.
`schedulePhase` is only `upcoming`, `started`, or `unknown`, based on kickoff
time. It does not claim that a match is still live or completed. A commentator
can broadcast a different game in a room assigned to a future match, so
`currentlyBroadcasting` describes the room, not the scheduled game.
`currentBroadcastTitle` exposes the distinction. If the live-room feed cannot
be fetched, `currentlyBroadcasting` is null, not false.

If one feed fails, the API preserves the other results and returns
`partial: true` with `warnings`. If both schedule feeds fail, it returns an
upstream error. Concurrent catalog requests share one in-flight fetch; each
new request after completion fetches current data using minute-based upstream
cache keys. All streams remain subject to the original room player's rules.

Live check on September 18, 2026: 191 unique matches and 34 live rooms, with
all three feeds successful. Counts change as the website updates.

## Run

Requires Node.js 22 or newer. No npm packages or browser installation are needed.

```bash
npm start
```

Default port: `8000`. The server listens on `0.0.0.0`.

Fetch a room once from the command line:

```bash
npm run scrape -- 607552
npm run scrape -- 'https://m.socolivewl.net/room/607552?scheduleId=undefined'
```

The `scheduleId=undefined` parameter is ignored; the room ID is sufficient.

## HTTP endpoints

| Endpoint | Result |
| --- | --- |
| `GET /proxy/room/607552.m3u8` | Proxied HLS, including child playlists and media |
| `GET /proxy/room/607552.flv` | Proxied FLV |
| `GET /api/matches` | All published matches plus live-room catalog |
| `GET /api/live` | All current live rooms |
| `GET /health` | Process health (does not check upstream availability) |
| `GET /api/room/607552` | Room title, live status and all available stream URLs |
| `GET /api/stream/607552` | Alias for the room API |
| `GET /stream/607552.m3u8` | HTTP 302 redirect to the current HD HLS URL, or SD if HD is absent |
| `GET /stream/607552.m3u8?quality=sd` | Redirect to SD HLS, or HD if SD is absent |

```bash
curl http://localhost:8000/api/room/607552
```

The JSON response has `success` and `data`. Data includes `roomId`, `title`,
`live`, `liveStatus`, `roomUrl`, `streams`, `playbackUrl`, `playbackVerified`,
and `fetchedAt`. Each stream has `quality`, `type`, `url`, and `proxyUrl`.
`playbackUrl` selects HD HLS first, then SD HLS.
`playbackVerified` is false because extraction does not test media playback.
An offline room returns an empty stream list. The redirect endpoint returns
404 when the room is offline or no HLS URL exists.

## How it works

The website's public JavaScript at
`https://sta.vnres.co/wap/js/utils.js?v=1785297422340` defines its room lookup as:

```text
https://json.vnres.co/room/ROOM_ID/detail.json?v=MINUTE_TIMESTAMP
```

That endpoint returns `detail({"code":200,"data": ...})` JSONP. The scraper
strips the `detail(...)` wrapper and parses JSON; it does not execute scripts.
The website's player uses `data.stream.hdM3u8` and `data.stream.m3u8`.
The scraper also exposes the published `hdFlv` and `flv` alternatives.

Every request fetches room data with the website's current minute cache key.
Simultaneous requests for the same room share one upstream request. There is
no additional local stream cache. Signed query strings are preserved exactly.
The scraper does not generate signatures or derive playlists from `.ts` files.
A `.ts` URL is only one media segment, not a live playlist.

The playback endpoint is a redirect, not a media proxy. Viewers fetch media
from the original stream host. Playback therefore remains subject to that
host's availability, CORS, referrer and geographic rules. Signed links may
expire; request the room API or redirect again for a current link. An existing
player does not automatically reload this redirect when its signed URL expires.
Cross-origin browser clients should call the JSON API through their own backend
or configure their reverse proxy for the desired frontend origin.

## Configuration

Set environment variables in your host/Coolify settings, or copy `.env.example`
to `.env` and explicitly load it:

```bash
node --env-file=.env src/server.js
```

| Variable | Default |
| --- | --- |
| `PORT` | `8000` |
| `SITE_ORIGIN` | `https://m.socolivewl.net` |
| `DATA_ORIGIN` | `https://json.vnres.co` |
| `REQUEST_TIMEOUT_MS` | `20000` |

`npm start` does not automatically load `.env`. On Node.js 24, if the host
requires a configured HTTP proxy, Node's `NODE_USE_ENV_PROXY=1` can be used
with its standard `HTTPS_PROXY`/`HTTP_PROXY` environment variables.

## Docker / Coolify

```bash
docker build -t socolive-scraper .
docker run -d --name socolive-scraper -p 8000:8000 --restart unless-stopped socolive-scraper
```

In Coolify use the included Dockerfile, application port `8000`, and health
path `/health`. Do not include the test directory in the image.

## Verification

```bash
npm test
```

Fourteen tests cover proxy playlist rewriting, signed resource links, streaming/ranges, and match-feed merging, duplicate entries, WIB date filters,
partial feed failures, live-room identity, new HTTP endpoints, and supplied room URLs, safe JSONP decoding, signed URL preservation,
HD/SD selection, offline rooms, mismatched room IDs, rejecting `.ts` entries,
upstream failures, and HTTP JSON/redirect routes.

The live CLI was tested against room `607552` on September 18, 2026 and returned
HD/SD HLS and FLV URLs. Stream availability and the room's match change over time.
