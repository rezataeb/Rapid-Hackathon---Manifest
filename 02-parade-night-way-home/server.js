import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "./lib/hub.js";
import { fetchRoutes, geocode, searchSocial } from "./lib/feeds.js";
import { scoreRoute, NYC_BOX, inBox } from "./lib/geo.js";
import { demoRoutes, demoSocial } from "./lib/demo.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DEMO = /^(1|true|yes)$/i.test(process.env.DEMO || "");

const hub = new Hub({ demo: DEMO }).start();

/* ------------------------------ helpers ------------------------------ */
const STATIC = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["public/app.css", "text/css; charset=utf-8"],
  "/icon.svg": ["public/icon.svg", "image/svg+xml"],
  "/manifest.webmanifest": ["public/manifest.webmanifest", "application/manifest+json"],
  "/vendor/leaflet.js": ["node_modules/leaflet/dist/leaflet.js", "text/javascript; charset=utf-8"],
  "/vendor/leaflet.css": ["node_modules/leaflet/dist/leaflet.css", "text/css; charset=utf-8"],
};

function sendJSON(req, res, status, body, maxAge = 0) {
  let buf = Buffer.from(JSON.stringify(body));
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store" };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) { buf = gzipSync(buf); headers["Content-Encoding"] = "gzip"; }
  headers["Content-Length"] = buf.length;
  res.writeHead(status, headers).end(buf);
}

function sendStatic(res, [file, type]) {
  const full = path.join(ROOT, file);
  try {
    const { size } = statSync(full);
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Cache-Control": file.startsWith("node_modules") ? "public, max-age=604800" : "no-cache" });
    createReadStream(full).pipe(res);
  } catch { res.writeHead(404).end("Not found"); }
}

function parsePoint(s) {
  const [lat, lon] = String(s || "").split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) && inBox(NYC_BOX, [lat, lon]) ? [lat, lon] : null;
}

// Simple per-IP limiter for the endpoints that call third-party services on demand.
const buckets = new Map();
function allow(req, key, perMin) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const id = `${key}:${ip}`, now = Date.now();
  const b = buckets.get(id) || { n: 0, reset: now + 60_000 };
  if (now > b.reset) { b.n = 0; b.reset = now + 60_000; }
  b.n++; buckets.set(id, b);
  return b.n <= perMin;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 120_000).unref();

const socialCache = new Map();
const geocodeCache = new Map();
let lastNominatim = 0;

/* ------------------------------ routes ------------------------------ */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method !== "GET") return res.writeHead(405).end();
  if (STATIC[p]) return sendStatic(res, STATIC[p]);

  if (p === "/api/health") return sendJSON(req, res, 200, { ok: true, demo: DEMO, uptimeS: Math.round(process.uptime()) });
  if (p === "/api/config") return sendJSON(req, res, 200, { tileUrl: process.env.TILE_URL || null, tileAttribution: process.env.TILE_ATTRIBUTION || null }, 300);
  if (p === "/api/status") return sendJSON(req, res, 200, { demo: DEMO, sources: hub.status() });

  if (p.startsWith("/api/feed/")) {
    const s = hub.feed(p.slice(10));
    if (!s) return sendJSON(req, res, 404, { error: "Unknown feed." });
    return sendJSON(req, res, 200, { status: s.status, updatedAt: s.updatedAt, note: s.note, error: s.error, asOf: s.asOf, items: s.items }, 15);
  }

  if (p === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = () => res.write(`event: status\ndata: ${JSON.stringify({ demo: DEMO, sources: hub.status() })}\n\n`);
    send();
    const onUpdate = () => send();
    hub.on("update", onUpdate);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => { clearInterval(ping); hub.off("update", onUpdate); });
    return;
  }

  if (p === "/api/route") {
    const from = parsePoint(url.searchParams.get("from")), to = parsePoint(url.searchParams.get("to"));
    const mode = ["car", "foot", "bike"].includes(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "car";
    if (!from || !to) return sendJSON(req, res, 400, { error: "Start and destination must both be points inside New York City." });
    if (!allow(req, "route", 20)) return sendJSON(req, res, 429, { error: "Too many route requests. Wait a minute and try again." });
    try {
      const raw = DEMO ? demoRoutes(from, to) : await fetchRoutes(from, to, mode);
      // Delayed 311 data describes yesterday's streets, so leave it out of the ranking.
      const reportsUsed = DEMO || hub.feed("reports").fresh !== false;
      const hazards = { closures: hub.feed("closures").items, speeds: hub.feed("speeds").items, reports: reportsUsed ? hub.feed("reports").items : [] };
      const routes = raw.map(r => ({ duration: r.duration, distance: r.distance, path: r.path, ...scoreRoute(r.path, r.duration, hazards) }))
        .sort((a, b) => a.score - b.score);
      return sendJSON(req, res, 200, { mode, routes, reportsUsed, demo: DEMO });
    } catch (err) {
      return sendJSON(req, res, 502, { error: `The routing service didn't answer (${err.message}). Try again in a minute.` });
    }
  }

  if (p === "/api/geocode") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    if (q.length < 3) return sendJSON(req, res, 400, { error: "Type at least 3 characters." });
    if (DEMO) return sendJSON(req, res, 200, { results: [{ label: `${q} (demo point)`, lat: 40.7831, lon: -73.9712 }] });
    const key = q.toLowerCase();
    if (geocodeCache.has(key)) return sendJSON(req, res, 200, { results: geocodeCache.get(key) });
    if (!allow(req, "geocode", 15)) return sendJSON(req, res, 429, { error: "Too many searches. Wait a minute and try again." });
    // Nominatim's usage policy: at most one request per second from this server.
    const wait = Math.max(0, lastNominatim + 1100 - Date.now());
    lastNominatim = Date.now() + wait;
    await new Promise(r => setTimeout(r, wait));
    try {
      const results = await geocode(q);
      geocodeCache.set(key, results);
      if (geocodeCache.size > 500) geocodeCache.delete(geocodeCache.keys().next().value);
      return sendJSON(req, res, 200, { results });
    } catch (err) { return sendJSON(req, res, 502, { error: `Address search didn't answer (${err.message}).` }); }
  }

  if (p === "/api/social") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
    if (!q) return sendJSON(req, res, 400, { error: "Enter something to search for." });
    if (DEMO) return sendJSON(req, res, 200, { posts: demoSocial(q) });
    const hit = socialCache.get(q.toLowerCase());
    if (hit && Date.now() - hit.at < 120_000) return sendJSON(req, res, 200, { posts: hit.posts });
    if (!allow(req, "social", 20)) return sendJSON(req, res, 429, { error: "Too many searches. Wait a minute and try again." });
    try {
      const posts = await searchSocial(q);
      socialCache.set(q.toLowerCase(), { at: Date.now(), posts });
      return sendJSON(req, res, 200, { posts });
    } catch (err) {
      const hint = /40[13]/.test(err.message) ? " Bluesky limits anonymous search; set BSKY_HANDLE and BSKY_APP_PASSWORD on the server to fix this." : "";
      return sendJSON(req, res, 502, { error: `Public post search didn't answer (${err.message}).${hint}` });
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => { console.error(err); if (!res.headersSent) sendJSON(req, res, 500, { error: "Something went wrong on the server." }); });
});
server.listen(PORT, () => console.log(`Way Home NYC running on http://localhost:${PORT}${DEMO ? " (demo data)" : ""}`));

const shutdown = () => { hub.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
