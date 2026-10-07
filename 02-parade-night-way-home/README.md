# Way Home NYC

A live dashboard for getting around New York when big events close streets. One map shows:

| Feed | Source | Refreshes |
|---|---|---|
| Traffic speeds on major roads | NYC DOT real-time speeds (NYC Open Data `i4gi-tjb9`) | every 1 min |
| Construction street closures active today | NYC DOT (`i6b5-j7bu`) | every 10 min |
| Permitted events in the next 18 hours, flagged when they close streets | NYC permitted events (`tvpp-9vvx`) | every 10 min |
| 311 reports from the last 3 hours (street noise, blocked roads, signals, parking) | NYC 311 (`erm2-nwe9`) | every 3 min |
| Subway service alerts | MTA GTFS-realtime alerts | every 1 min |
| Hourly forecast and weather alerts | National Weather Service | every 15 min |
| Public posts (on demand) | Bluesky search | 2 min cache |

The **Route** tab finds up to four routes (car, walking or bike) from OpenStreetMap routers and ranks them by how many closures, slow roads and 311 reports lie along each one.

## How it works

The server fetches every feed on its own schedule, keeps the last good copy if a source goes down, and pushes updates to open browsers over Server-Sent Events. Browsers never call the city's APIs directly, so there are no cross-origin problems and the feeds aren't hit once per visitor.

```
server.js        HTTP server: static files, /api/* routes, live stream
lib/feeds.js     Fetchers and normalizers for each source
lib/hub.js       Polling, caching, stale-on-error, update events
lib/geo.js       Route scoring against closures, speeds and 311
lib/demo.js      Invented sample data for DEMO=1
public/          The dashboard (HTML, CSS, JS); Leaflet is served from node_modules
test/            node --test unit tests
```

## Run it on your computer

Needs Node.js 18.17 or newer ([nodejs.org](https://nodejs.org)).

```bash
npm install
npm start          # live feeds, http://localhost:3000
npm run demo       # invented sample data, works offline
npm test
```

## Put it online (free)

**Render**
1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint** and pick the repository. `render.yaml` sets everything up.
3. Open the `onrender.com` link it gives you. Free instances sleep after inactivity, so the first load can take about a minute.

**Railway or Fly.io**: both detect the `Dockerfile`. Deploy and open the generated URL.

On a phone, open the link and choose **Add to Home Screen** to use it like an app.

## Settings

All optional; see `.env.example`.

- `CONTACT_EMAIL`: your email for the User-Agent the weather and address services ask for.
- `NYC_APP_TOKEN`: a free NYC Open Data app token for higher rate limits.
- `BSKY_HANDLE` / `BSKY_APP_PASSWORD`: a Bluesky app password, if anonymous post search gets refused.
- `TILE_URL` / `TILE_ATTRIBUTION`: a different base-map tile provider (for example a keyed MapTiler or Stadia URL). The default is OpenStreetMap's standard tiles, which need no key but are meant for light use; switch to a keyed provider if the site gets heavy traffic.

## API

| Route | Returns |
|---|---|
| `GET /api/status` | Status of every feed (live, stale, failed, loading), counts and timestamps |
| `GET /api/stream` | Server-Sent Events: a `status` event whenever a feed updates |
| `GET /api/feed/:name` | Items for `speeds`, `closures`, `events`, `reports`, `transit` or `weather` |
| `GET /api/route?from=lat,lon&to=lat,lon&mode=car\|foot\|bike` | Scored routes, best first |
| `GET /api/geocode?q=` | Address matches inside NYC |
| `GET /api/social?q=` | Recent public Bluesky posts |
| `GET /api/health` | Health check |

## Limits

- Construction closures don't include closures set up on the day by NYPD for parades or celebrations. For those, check the Events tab, 311 noise clusters, traffic speeds and the official channels linked in the Social tab.
- 311 records can show up with a delay.
- Public routers (routing.openstreetmap.de) and address search (Nominatim) are free community services with usage limits; the server rate-limits and caches requests to stay within them.
- X/Twitter isn't included because its API is paid.
