// Fetchers and normalizers for every public feed. Normalizers are pure so they can be tested
// against sample payloads without network access.
import { nycISO, minutesAgo, hoursFromNow } from "./time.js";
import { NYC_BOX, inBox } from "./geo.js";

const SODA = "https://data.cityofnewyork.us/resource/";
const UA = `WayHomeNYC/1.0 (${process.env.CONTACT_EMAIL || "github.com/way-home-nyc"})`;

async function getJSON(url, { headers = {}, timeoutMs = 20_000 } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${new URL(url).host} answered HTTP ${res.status}${body ? ": " + body.slice(0, 120) : ""}`);
  }
  return res.json();
}

function soda(dataset, params) {
  const headers = process.env.NYC_APP_TOKEN ? { "X-App-Token": process.env.NYC_APP_TOKEN } : {};
  return getJSON(SODA + dataset + ".json?" + new URLSearchParams(params), { headers });
}

/** "Oct 6, 2:05 am" from a floating NYC timestamp. */
export function describeNyc(s) {
  const [d, t = "00:00"] = String(s).split("T");
  const [y, mo, day] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo - 1];
  return `${month} ${day}, ${h % 12 || 12}:${String(mi).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/* ------------------------------ normalizers ------------------------------ */

export function parseLinkPoints(s) {
  return String(s || "").trim().split(/\s+/)
    .map(pair => pair.split(",").map(Number))
    .filter(a => a.length === 2 && a.every(Number.isFinite) && inBox(NYC_BOX, a));
}

export function normalizeSpeeds(rows) {
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (!r.link_id || seen.has(r.link_id)) continue;
    seen.add(r.link_id);
    const pts = parseLinkPoints(r.link_points);
    const mph = Number(r.speed);
    if (pts.length < 2 || !Number.isFinite(mph)) continue;
    out.push({ id: r.link_id, name: r.link_name || "Unnamed link", boro: r.borough || "", mph: Math.round(mph * 10) / 10, asOf: r.data_as_of, pts });
  }
  return out;
}

const BORO = { M: "Manhattan", B: "Brooklyn", Q: "Queens", X: "Bronx", S: "Staten Island" };

export function normalizeClosures(rows) {
  const out = [];
  for (const r of rows) {
    const coords = r.the_geom?.coordinates;
    if (!Array.isArray(coords)) continue;
    const lines = coords.map(line => line.map(([lon, lat]) => [lat, lon])).filter(l => l.length >= 2);
    if (!lines.length) continue;
    const flat = lines.flat();
    const a = flat[0], b = flat[flat.length - 1];
    out.push({
      id: r.uniqueid || `${r.segmentid}-${r.work_start_date}`,
      on: r.onstreetname || "", from: r.fromstreetname || "", to: r.tostreetname || "",
      boro: BORO[r.borough_code] || r.borough_code || "",
      purpose: r.purpose || "Construction",
      start: r.work_start_date, end: r.work_end_date,
      lines, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    });
  }
  return out;
}

export function normalizeEvents(rows) {
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (seen.has(r.event_id)) continue;
    seen.add(r.event_id);
    const closure = r.street_closure_type && r.street_closure_type !== "N/A" ? r.street_closure_type : null;
    out.push({
      id: r.event_id, name: r.event_name || "Event", start: r.start_date_time, end: r.end_date_time,
      agency: r.event_agency || "", type: r.event_type || "", boro: r.event_borough || "",
      location: r.event_location || "", closure,
    });
  }
  return out.sort((a, b) => (b.closure ? 1 : 0) - (a.closure ? 1 : 0) || String(a.start).localeCompare(String(b.start)));
}

export const REPORT_TYPES = [
  "Noise - Street/Sidewalk", "Noise - Vehicle", "Traffic Signal Condition", "Street Condition",
  "Blocked Driveway", "Illegal Parking", "Street Light Condition", "Traffic", "Obstruction",
];
export const reportKind = t => /^Noise/.test(t) ? "crowd" : /Parking|Driveway/.test(t) ? "parking" : "street";

export function normalizeReports(rows) {
  return rows
    .map(r => ({ ...r, lat: Number(r.latitude), lon: Number(r.longitude) }))
    .filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon) && inBox(NYC_BOX, [r.lat, r.lon]))
    .map(r => ({
      id: r.unique_key, created: r.created_date, type: r.complaint_type, descriptor: r.descriptor || "",
      address: r.incident_address || "", boro: r.borough || "", lat: r.lat, lon: r.lon, kind: reportKind(r.complaint_type),
    }));
}

export function normalizeTransit(feed, nowS = Date.now() / 1000) {
  const out = [];
  for (const e of feed?.entity || []) {
    const a = e.alert;
    if (!a) continue;
    const periods = a.active_period || [];
    const active = !periods.length || periods.some(p => (!p.start || Number(p.start) <= nowS) && (!p.end || Number(p.end) >= nowS));
    if (!active) continue;
    const tr = a.header_text?.translation || [];
    const text = (tr.find(t => t.language === "en") || tr.find(t => !/html/.test(t.language || "")) || tr[0] || {}).text;
    if (!text) continue;
    const routes = [...new Set((a.informed_entity || []).map(x => x.route_id).filter(Boolean))];
    const kind = a["transit_realtime.mercury_alert"]?.alert_type || "";
    out.push({ id: e.id, text: text.replace(/\[([A-Z0-9]+)\]/g, "$1"), routes, kind });
  }
  return out;
}

export function normalizeWeather(forecast, alerts) {
  const hours = (forecast?.properties?.periods || []).slice(0, 8).map(h => ({
    time: h.startTime, temp: h.temperature, unit: h.temperatureUnit, short: h.shortForecast,
    rain: h.probabilityOfPrecipitation?.value ?? 0, wind: h.windSpeed,
  }));
  const alertList = (alerts?.features || []).map(f => ({
    id: f.id, event: f.properties.event, severity: f.properties.severity, headline: f.properties.headline, ends: f.properties.ends,
  }));
  return { hours, alerts: alertList };
}

export function normalizeSocial(json) {
  return (json?.posts || []).map(p => ({
    id: p.uri, text: p.record?.text || "", handle: p.author?.handle || "", name: p.author?.displayName || "",
    at: p.indexedAt, url: `https://bsky.app/profile/${encodeURIComponent(p.author?.handle || "")}/post/${encodeURIComponent(p.uri.split("/").pop())}`,
  })).filter(p => p.text);
}

/* -------------------------------- fetchers -------------------------------- */

const SPEED_FIELDS = "link_id,speed,data_as_of,link_points,link_name,borough";

export const SOURCES = {
  speeds: {
    label: "DOT traffic speeds", everyS: 60,
    async fetch() {
      let rows = await soda("i4gi-tjb9", { $where: `data_as_of > '${nycISO(minutesAgo(120))}'`, $order: "data_as_of DESC", $limit: 4000, $select: SPEED_FIELDS });
      let note = "";
      if (!rows.length) {
        rows = await soda("i4gi-tjb9", { $order: "data_as_of DESC", $limit: 2000, $select: SPEED_FIELDS });
        note = "No sensor updates in the last 2 hours; showing the most recent readings.";
      }
      const items = normalizeSpeeds(rows);
      return { items, note, stale: Boolean(note), asOf: items[0]?.asOf };
    },
  },
  closures: {
    label: "DOT closures", everyS: 600,
    async fetch() {
      const now = nycISO();
      const rows = await soda("i6b5-j7bu", {
        $where: `work_start_date <= '${now}' AND work_end_date >= '${now.slice(0, 10)}T00:00:00'`,
        $limit: 8000,
        $select: "uniqueid,segmentid,onstreetname,fromstreetname,tostreetname,borough_code,purpose,work_start_date,work_end_date,the_geom",
      });
      return { items: normalizeClosures(rows) };
    },
  },
  events: {
    label: "Permitted events", everyS: 600,
    async fetch() {
      const rows = await soda("tvpp-9vvx", {
        $where: `end_date_time >= '${nycISO()}' AND start_date_time <= '${nycISO(hoursFromNow(18))}'`,
        $order: "start_date_time", $limit: 2000,
      });
      return { items: normalizeEvents(rows) };
    },
  },
  reports: {
    label: "311 reports", everyS: 180,
    async fetch() {
      const types = REPORT_TYPES.map(t => `'${t}'`).join(",");
      const query = minutes => soda("erm2-nwe9", {
        $where: `created_date > '${nycISO(minutesAgo(minutes))}' AND complaint_type in(${types})`,
        $order: "created_date DESC", $limit: 4000,
        $select: "unique_key,created_date,complaint_type,descriptor,incident_address,borough,latitude,longitude",
      });
      // The public 311 dataset is published in batches and can run a day or more behind.
      // Take the newest reports from the last 3 days, then report how old they are.
      const rows = await query(72 * 60);
      const all = normalizeReports(rows);
      const newest = all[0]?.created;
      const lagH = newest ? (Date.parse(nycISO()) - Date.parse(newest)) / 3_600_000 : Infinity;
      // Keep the 3 hours leading up to the newest report so the map shows one coherent slice.
      const cutoff = newest ? Date.parse(newest) - 3 * 3_600_000 : 0;
      const items = all.filter(r => Date.parse(r.created) >= cutoff);
      const fresh = lagH <= 6;
      const note = !newest ? "No recent 311 reports have been published."
        : fresh ? "Reports from the last 3 hours."
        : `The city publishes 311 data late. Newest report: ${describeNyc(newest)}. Not used to score routes.`;
      return { items, note, stale: !fresh, asOf: newest, fresh };
    },
  },
  transit: {
    label: "MTA subway", everyS: 60,
    async fetch() {
      const feed = await getJSON("https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json");
      return { items: normalizeTransit(feed) };
    },
  },
  weather: {
    label: "NWS weather", everyS: 900,
    _hourly: null,
    async fetch() {
      const pt = "40.7306,-73.9866";
      if (!this._hourly) this._hourly = (await getJSON(`https://api.weather.gov/points/${pt}`, { headers: { Accept: "application/geo+json" } })).properties.forecastHourly;
      const [fc, al] = await Promise.all([
        getJSON(this._hourly, { headers: { Accept: "application/geo+json" } }),
        getJSON(`https://api.weather.gov/alerts/active?point=${pt}`, { headers: { Accept: "application/geo+json" } }),
      ]);
      return { items: normalizeWeather(fc, al) };
    },
  },
};

/* ------------------------- on-demand: social, route, geocode ------------------------- */

let bskySession = null;
async function bskyAuth() {
  const { BSKY_HANDLE, BSKY_APP_PASSWORD } = process.env;
  if (!BSKY_HANDLE || !BSKY_APP_PASSWORD) return null;
  if (bskySession && bskySession.exp > Date.now()) return bskySession;
  const res = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ identifier: BSKY_HANDLE, password: BSKY_APP_PASSWORD }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Bluesky sign-in failed (HTTP ${res.status})`);
  const j = await res.json();
  bskySession = { jwt: j.accessJwt, exp: Date.now() + 60 * 60_000 };
  return bskySession;
}

export async function searchSocial(q) {
  const params = new URLSearchParams({ q, limit: "40", sort: "latest" });
  const session = await bskyAuth();
  const url = session
    ? `https://bsky.social/xrpc/app.bsky.feed.searchPosts?${params}`
    : `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?${params}`;
  const json = await getJSON(url, { headers: session ? { Authorization: `Bearer ${session.jwt}` } : {} });
  return normalizeSocial(json);
}

export async function fetchRoutes(from, to, mode) {
  const profile = { car: "routed-car", foot: "routed-foot", bike: "routed-bike" }[mode] || "routed-car";
  const url = `https://routing.openstreetmap.de/${profile}/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?alternatives=3&overview=full&geometries=geojson`;
  const j = await getJSON(url, { timeoutMs: 25_000 });
  if (j.code !== "Ok" || !j.routes?.length) throw new Error(j.message || "No route found between those points.");
  return j.routes.map(r => ({ duration: r.duration, distance: r.distance, path: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]) }));
}

export async function geocode(q) {
  const params = new URLSearchParams({ q, format: "jsonv2", limit: "5", countrycodes: "us", viewbox: "-74.27,40.93,-73.68,40.47", bounded: "1" });
  const rows = await getJSON(`https://nominatim.openstreetmap.org/search?${params}`);
  return rows.map(r => ({ label: r.display_name.split(",").slice(0, 3).join(","), lat: Number(r.lat), lon: Number(r.lon) }));
}
