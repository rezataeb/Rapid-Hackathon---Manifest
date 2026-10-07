(() => {
"use strict";

const TZ = "America/New_York";
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server answered ${res.status}`);
  return body;
}

/* ---------------------------- formatting ---------------------------- */
// NYC Open Data timestamps are NYC local time with no zone ("2026-10-07T18:30:00.000").
const fmtTime = s => {
  if (!s) return "";
  const t = String(s).split("T")[1] || "";
  const [h, m] = t.split(":").map(Number);
  if (!Number.isFinite(h)) return "";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};
const fmtDate = s => s ? new Date(String(s).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const titleCase = s => String(s || "").toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
function tickClock() { $("clock").textContent = new Date().toLocaleString("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" }); }

/* ------------------------------- map ------------------------------- */
const ZONES = {
  city: [[40.73, -73.95], 11], msg: [[40.7505, -73.9934], 15], canyon: [[40.7095, -74.0105], 15],
  midtown: [[40.7549, -73.984], 14], barclays: [[40.6826, -73.9754], 15],
};
const map = L.map("map", { preferCanvas: true }).setView(...ZONES.city);
const isDark = () => document.documentElement.dataset.theme === "dark" ||
  (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
// Base map: OpenStreetMap's standard tiles (no key). A server can swap in another
// provider with TILE_URL / TILE_ATTRIBUTION; dark mode dims the tiles with a CSS filter.
let tiles, tileConfig = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};
function setTiles() {
  if (tiles) tiles.remove();
  tiles = L.tileLayer(tileConfig.url, {
    maxZoom: 19, className: "basemap",
    attribution: `${tileConfig.attribution} · NYC Open Data · MTA · NWS`,
  }).addTo(map);
}
setTiles();
api("/api/config").then(c => { if (c.tileUrl) { tileConfig = { url: c.tileUrl, attribution: c.tileAttribution || tileConfig.attribution }; setTiles(); } }).catch(() => {});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { setTiles(); redrawAll(); });
$("zone").addEventListener("change", e => map.setView(...ZONES[e.target.value]));

const layers = { speeds: L.layerGroup().addTo(map), closures: L.layerGroup().addTo(map), reports: L.layerGroup().addTo(map), route: L.layerGroup().addTo(map) };
const LAYER_LABELS = { speeds: "Traffic speeds", closures: "Closures", reports: "311 reports" };
const hiddenLayers = new Set(store.get("wh-hidden") || []);
$("layers").innerHTML = Object.entries(LAYER_LABELS).map(([k, l]) => `<button class="btn sm ${hiddenLayers.has(k) ? "" : "on"}" data-layer="${k}" aria-pressed="${!hiddenLayers.has(k)}">${l}</button>`).join("");
hiddenLayers.forEach(k => map.removeLayer(layers[k]));
$("layers").addEventListener("click", e => {
  const b = e.target.closest("[data-layer]"); if (!b) return;
  const k = b.dataset.layer, lg = layers[k];
  if (map.hasLayer(lg)) { map.removeLayer(lg); hiddenLayers.add(k); } else { lg.addTo(map); hiddenLayers.delete(k); }
  b.classList.toggle("on", !hiddenLayers.has(k)); b.setAttribute("aria-pressed", !hiddenLayers.has(k));
  store.set("wh-hidden", [...hiddenLayers]);
});

/* ------------------------------ state ------------------------------ */
const feeds = { speeds: [], closures: [], events: [], reports: [], transit: [], weather: { hours: [], alerts: [] } };
const feedErr = {}, feedNote = {};
let status = {};
const seenAt = {};

/* --------------------------- status chips --------------------------- */
function renderSources() {
  $("sources").innerHTML = Object.entries(status).map(([k, s]) => {
    const when = s.updatedAt ? ago(s.updatedAt) : "";
    const label = s.status === "failed" ? "unavailable" : s.status === "loading" ? "loading" : when;
    const tip = [s.error && `Problem: ${s.error}`, s.note, s.updatedAt && `Updated ${when}`].filter(Boolean).join(" · ");
    return `<span class="src" tabindex="0" title="${esc(tip)}"><i class="dot ${esc(s.status)}"></i>${esc(s.label)}${label ? " · " + esc(label) : ""}</span>`;
  }).join("");
}

/* ------------------------------ speeds ------------------------------ */
const speedColor = mph => mph < 10 ? css("--bad") : mph < 20 ? css("--warn") : css("--ok");
function drawSpeeds() {
  layers.speeds.clearLayers();
  for (const s of feeds.speeds) {
    L.polyline(s.pts, { color: speedColor(s.mph), weight: 4, opacity: .85 })
      .bindPopup(`<b>${esc(titleCase(s.name))}</b><br>${Math.round(s.mph)} mph · ${esc(s.boro)}<br><small>Sensor reading ${fmtTime(s.asOf)}</small>`)
      .addTo(layers.speeds);
  }
}

/* ----------------------------- closures ----------------------------- */
const closurePopup = c => `<b>${esc(titleCase(c.on))}</b><br>${esc(titleCase(c.from))} to ${esc(titleCase(c.to))}<br>${esc(c.purpose)}<br><small>${fmtDate(c.start)} – ${fmtDate(c.end)} · ${esc(c.boro)}</small>`;
function drawClosures() {
  layers.closures.clearLayers();
  for (const c of feeds.closures) {
    c.layer = L.polyline(c.lines, { color: css("--work"), weight: 6, opacity: .95, dashArray: "6 4" }).bindPopup(closurePopup(c)).addTo(layers.closures);
  }
}
function renderClosures() {
  $("n-closures").textContent = feeds.closures.length || "";
  if (feedErr.closures && !feeds.closures.length) { $("list-closures").innerHTML = `<p class="err">Closures are unavailable right now (${esc(feedErr.closures)}).</p>`; return; }
  const q = $("q-closures").value.trim().toUpperCase();
  const c0 = map.getCenter(), kx = Math.cos(c0.lat * Math.PI / 180);
  const dist = c => Math.hypot((c.mid[0] - c0.lat) * 69, (c.mid[1] - c0.lng) * 69 * kx);
  const list = feeds.closures
    .filter(c => !q || [c.on, c.from, c.to].some(s => s.includes(q)))
    .map(c => ({ c, d: dist(c) })).sort((a, b) => a.d - b.d).slice(0, 150);
  $("list-closures").innerHTML = list.length ? list.map(({ c, d }) => `
    <button class="item" data-id="${esc(c.id)}"><i class="bar" style="background:var(--work)"></i>
      <span><span class="t">${esc(titleCase(c.on))}</span><br><span class="d">${esc(titleCase(c.from))} → ${esc(titleCase(c.to))}</span><br>
      <span class="m">${esc(c.purpose)} · ${esc(c.boro)} · ${d.toFixed(1)} mi away · until ${fmtDate(c.end)}</span></span></button>`).join("")
    : `<p class="empty">${feeds.closures.length ? "No closures match that street." : "No construction closures listed for today."}</p>`;
}
$("q-closures").addEventListener("input", renderClosures);
$("list-closures").addEventListener("click", e => {
  const it = e.target.closest("[data-id]"); if (!it) return;
  const c = feeds.closures.find(x => x.id === it.dataset.id); if (!c) return;
  map.setView(c.mid, 17); c.layer?.openPopup();
  if (matchMedia("(max-width:820px)").matches) $("map").scrollIntoView({ behavior: "smooth" });
});
map.on("moveend", () => { if (!$("pane-closures").hidden) renderClosures(); });

/* ------------------------------ events ------------------------------ */
function renderEvents() {
  $("n-events").textContent = feeds.events.filter(e => e.closure).length || "";
  if (feedErr.events && !feeds.events.length) { $("list-events").innerHTML = `<p class="err">Events are unavailable right now (${esc(feedErr.events)}).</p>`; return; }
  const b = $("ev-boro").value, only = $("ev-closing").checked;
  const list = feeds.events.filter(ev => (!b || ev.boro === b) && (!only || ev.closure));
  $("list-events").innerHTML = list.length ? list.slice(0, 250).map(ev => `
    <div class="item"><i class="bar" style="background:${ev.closure ? "var(--work)" : "var(--line)"}"></i>
      <div><div class="t">${esc(ev.name)} ${ev.closure ? `<span class="pill work">${esc(ev.closure)}</span>` : ""}</div>
      <div class="d">${esc(ev.location)}</div>
      <div class="m">${fmtTime(ev.start)} – ${fmtTime(ev.end)}${ev.end?.slice(0, 10) !== ev.start?.slice(0, 10) ? " " + fmtDate(ev.end) : ""} · ${esc(ev.boro)} · ${esc(ev.type)}</div></div></div>`).join("")
    : `<p class="empty">No permitted events match in the next 18 hours.</p>`;
}
$("ev-boro").addEventListener("change", renderEvents);
$("ev-closing").addEventListener("change", renderEvents);

/* ------------------------------- 311 ------------------------------- */
const kindColor = k => ({ crowd: css("--crowd"), street: css("--work"), parking: css("--muted") }[k]);
function drawReports() {
  layers.reports.clearLayers();
  for (const r of feeds.reports) {
    const col = kindColor(r.kind);
    r.layer = L.circleMarker([r.lat, r.lon], { radius: 5, color: col, fillColor: col, fillOpacity: .6, weight: 1 })
      .bindPopup(`<b>${esc(r.type)}</b><br>${esc(r.descriptor)}<br>${esc(titleCase(r.address))}<br><small>${fmtDate(r.created)}, ${fmtTime(r.created)}</small>`)
      .addTo(layers.reports);
  }
}
function renderReports() {
  $("n-reports").textContent = feeds.reports.length || "";
  if (feedErr.reports && !feeds.reports.length) { $("list-reports").innerHTML = `<p class="err">311 is unavailable right now (${esc(feedErr.reports)}).</p>`; return; }
  const bar = { crowd: "var(--crowd)", street: "var(--work)", parking: "var(--muted)" };
  $("reports-note").textContent = feedNote.reports || "";
  $("list-reports").innerHTML = feeds.reports.length ? feeds.reports.slice(0, 200).map(r => `
    <button class="item" data-id="${esc(r.id)}"><i class="bar" style="background:${bar[r.kind]}"></i>
      <span><span class="t">${esc(r.type)}</span><br><span class="d">${esc(r.descriptor)}</span><br>
      <span class="m">${fmtDate(r.created)}, ${fmtTime(r.created)} · ${esc(titleCase(r.address || r.boro))}</span></span></button>`).join("")
    : `<p class="empty">No matching reports in the last 3 hours. 311 records often arrive late.</p>`;
}
$("list-reports").addEventListener("click", e => {
  const it = e.target.closest("[data-id]"); if (!it) return;
  const r = feeds.reports.find(x => String(x.id) === it.dataset.id); if (!r) return;
  map.setView([r.lat, r.lon], 17); r.layer?.openPopup();
});

/* ----------------------------- transit ----------------------------- */
const ROUTE_COL = { 1: "#EE352E", 2: "#EE352E", 3: "#EE352E", 4: "#00933C", 5: "#00933C", 6: "#00933C", "6X": "#00933C", 7: "#B933AD", "7X": "#B933AD",
  A: "#0039A6", C: "#0039A6", E: "#0039A6", B: "#FF6319", D: "#FF6319", F: "#FF6319", FX: "#FF6319", M: "#FF6319", G: "#6CBE45", J: "#996633", Z: "#996633",
  L: "#A7A9AC", N: "#FCCC0A", Q: "#FCCC0A", R: "#FCCC0A", W: "#FCCC0A", GS: "#808183", FS: "#808183", H: "#808183", S: "#808183", SI: "#0039A6" };
const bullet = id => `<span class="bullet" style="background:${ROUTE_COL[id] || "#808183"};${/^[NQRW]$/.test(id) ? "color:#111" : ""}" aria-label="${esc(id)} train">${esc(id.replace(/X$/, ""))}</span>`;
function renderTransit() {
  $("n-transit").textContent = feeds.transit.length || "";
  if (feedErr.transit && !feeds.transit.length) {
    $("list-transit").innerHTML = `<p class="err">Subway alerts are unavailable right now (${esc(feedErr.transit)}). <a href="https://www.mta.info/alerts" target="_blank" rel="noopener">Open MTA alerts</a>.</p>`; return;
  }
  $("list-transit").innerHTML = feeds.transit.length ? feeds.transit.map(a => `
    <div class="item"><i class="bar" style="background:var(--accent)"></i>
      <div><div>${a.routes.map(bullet).join("")} ${a.kind ? `<span class="pill">${esc(a.kind)}</span>` : ""}</div><div class="d">${esc(a.text)}</div></div></div>`).join("")
    : `<p class="empty">No active subway alerts right now.</p>`;
}
function renderWeather() {
  const w = feeds.weather;
  if (feedErr.weather && !w.hours.length) { $("weather").innerHTML = `<p class="err">Weather is unavailable right now (${esc(feedErr.weather)}).</p>`; return; }
  $("weather").innerHTML = `
    ${w.alerts.map(a => `<p><span class="pill bad">${esc(a.severity)}</span> ${esc(a.headline)}</p>`).join("")}
    <div class="list">${w.hours.map(h => `<div class="wx">
      <span class="m">${new Date(h.time).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric" })}</span>
      <span><b>${h.temp}°${esc(h.unit)}</b> ${esc(h.short)} <span class="m">· rain ${h.rain}% · wind ${esc(h.wind)}</span></span></div>`).join("")}</div>`;
}

/* ------------------------------ social ------------------------------ */
async function loadSocial() {
  const q = $("q-social").value.trim(); if (!q) return;
  $("list-social").innerHTML = `<p class="empty">Searching…</p>`;
  try {
    const { posts } = await api("/api/social?q=" + encodeURIComponent(q));
    $("list-social").innerHTML = posts.length ? posts.map(p => `
      <a class="item" target="_blank" rel="noopener" href="${esc(p.url)}"><i class="bar"></i>
        <span><span class="d">${esc(p.text)}</span><br><span class="m">@${esc(p.handle)} · ${ago(new Date(p.at).getTime())}</span></span></a>`).join("")
      : `<p class="empty">No recent posts for that search.</p>`;
  } catch (e) { $("list-social").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
$("social-form").addEventListener("submit", e => { e.preventDefault(); loadSocial(); });

/* --------------------------- feed loading --------------------------- */
const RENDER = {
  speeds: () => drawSpeeds(),
  closures: () => { drawClosures(); renderClosures(); },
  events: () => renderEvents(),
  reports: () => { drawReports(); renderReports(); },
  transit: () => renderTransit(),
  weather: () => renderWeather(),
};
function redrawAll() { Object.values(RENDER).forEach(fn => fn()); if (lastRoutes) drawRoutes(selRoute); }

async function loadFeed(key) {
  try {
    const r = await api(`/api/feed/${key}`);
    feeds[key] = r.items; feedErr[key] = r.status === "failed" ? r.error : ""; feedNote[key] = r.note || "";
    RENDER[key]();
  } catch (e) { feedErr[key] = e.message; RENDER[key](); }
}

function onStatus(msg) {
  status = msg.sources;
  $("demo-banner").hidden = !msg.demo;
  renderSources();
  for (const [k, s] of Object.entries(status)) {
    const stamp = `${s.updatedAt}|${s.status}`;
    if (seenAt[k] !== stamp) { seenAt[k] = stamp; loadFeed(k); }
  }
}

let pollTimer = null;
function connect() {
  if (!window.EventSource) return startPolling();
  const es = new EventSource("/api/stream");
  es.addEventListener("status", e => { try { onStatus(JSON.parse(e.data)); } catch {} });
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) { startPolling(); } };
}
function startPolling() {
  if (pollTimer) return;
  const tick = () => api("/api/status").then(onStatus).catch(() => {});
  tick(); pollTimer = setInterval(tick, 30000);
}

/* --------------------------- route planning --------------------------- */
const places = { start: store.get("wh-start"), home: store.get("wh-home") };
const pins = {};
let picking = null, lastRoutes = null, selRoute = 0;

function setPlace(which, p, { save = true, label } = {}) {
  places[which] = { lat: p.lat, lon: p.lon, label: label || p.label || `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` };
  $(`${which}-q`).value = places[which].label;
  pins[which]?.remove();
  pins[which] = L.circleMarker([p.lat, p.lon], { radius: 8, weight: 3, color: css("--accent"), fillColor: which === "home" ? css("--accent") : css("--panel"), fillOpacity: 1 })
    .bindTooltip(which === "home" ? "Destination" : "Start", { permanent: true, direction: "top", offset: [0, -8] }).addTo(map);
  if (save) store.set(`wh-${which}`, places[which]);
}
["start", "home"].forEach(w => { if (places[w]) setPlace(w, places[w], { save: false }); });

document.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => {
  picking = b.dataset.pick; document.body.classList.add("picking");
  $("route-msg").textContent = `Tap the map to set the ${picking === "home" ? "destination" : "start"}.`;
  if (matchMedia("(max-width:820px)").matches) $("map").scrollIntoView({ behavior: "smooth" });
}));
map.on("click", e => {
  if (!picking) return;
  setPlace(picking, { lat: e.latlng.lat, lon: e.latlng.lng, label: "Point on map" });
  picking = null; document.body.classList.remove("picking"); $("route-msg").textContent = "";
});
$("swap").addEventListener("click", () => {
  const s = places.start, h = places.home;
  if (h) setPlace("start", h); if (s) setPlace("home", s);
});
$("use-loc").addEventListener("click", () => {
  if (!navigator.geolocation) { $("route-msg").textContent = "This browser can't share your location. Type an address instead."; return; }
  $("route-msg").textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    p => { setPlace("start", { lat: p.coords.latitude, lon: p.coords.longitude, label: "My location" }); map.setView([p.coords.latitude, p.coords.longitude], 15); $("route-msg").textContent = ""; },
    () => { $("route-msg").textContent = "Location access was blocked. Type an address or pick on the map instead."; },
    { timeout: 10000, enableHighAccuracy: true });
});

// Address autocomplete (debounced; server enforces geocoder rate limits)
function wireSearch(which) {
  const input = $(`${which}-q`), list = $(`${which}-suggest`);
  let timer, results = [], active = -1;
  const close = () => { list.hidden = true; active = -1; };
  const choose = i => { const r = results[i]; if (!r) return; setPlace(which, r, { label: r.label }); close(); map.setView([r.lat, r.lon], 15); };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { close(); return; }
    timer = setTimeout(async () => {
      try {
        ({ results } = await api("/api/geocode?q=" + encodeURIComponent(q)));
        list.innerHTML = results.length ? results.map((r, i) => `<li role="option" data-i="${i}">${esc(r.label)}</li>`).join("") : `<li aria-disabled="true">No matches in NYC</li>`;
        list.hidden = false;
      } catch (e) { list.innerHTML = `<li aria-disabled="true">${esc(e.message)}</li>`; list.hidden = false; }
    }, 450);
  });
  input.addEventListener("keydown", e => {
    if (list.hidden) return;
    const items = [...list.querySelectorAll("[data-i]")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute("aria-selected", i === active));
    } else if (e.key === "Enter") { e.preventDefault(); choose(active < 0 ? 0 : active); }
    else if (e.key === "Escape") close();
  });
  list.addEventListener("mousedown", e => { const li = e.target.closest("[data-i]"); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
  input.addEventListener("blur", () => setTimeout(close, 150));
}
wireSearch("start"); wireSearch("home");

async function findRoutes() {
  if (!places.start || !places.home) { $("route-msg").textContent = "Set both a start and a destination first."; return; }
  const mode = $("mode").value;
  store.set("wh-mode", mode);
  $("go").disabled = true; $("route-msg").textContent = "Finding routes…";
  try {
    const q = new URLSearchParams({ from: `${places.start.lat},${places.start.lon}`, to: `${places.home.lat},${places.home.lon}`, mode });
    const { routes, reportsUsed = true } = await api("/api/route?" + q);
    lastRoutes = routes; lastRoutes.reportsUsed = reportsUsed; drawRoutes(0, true);
    $("route-msg").textContent = `${routes.length} route${routes.length > 1 ? "s" : ""}, ranked by fewest closures and slow roads along the way.` +
      (reportsUsed ? " Re-run to re-check against fresh data." : " 311 reports aren't counted right now because the city's 311 data is delayed.");
  } catch (e) { $("route-msg").textContent = e.message; }
  finally { $("go").disabled = false; }
}
function drawRoutes(sel, fit) {
  selRoute = sel;
  layers.route.clearLayers();
  lastRoutes.forEach((r, k) => {
    if (k === sel) return;
    L.polyline(r.path, { color: css("--accent"), weight: 4, opacity: .3 }).on("click", () => drawRoutes(k)).addTo(layers.route);
  });
  const r = lastRoutes[sel];
  const line = L.polyline(r.path, { color: css("--accent"), weight: 7, opacity: .95 }).addTo(layers.route);
  r.closures.forEach(c => L.circleMarker(c.mid, { radius: 8, color: css("--work"), weight: 3, fill: false })
    .bindTooltip(`Closed: ${titleCase(c.on)}`).addTo(layers.route));
  if (fit) map.fitBounds(line.getBounds(), { padding: [30, 30] });
  $("routes").innerHTML = lastRoutes.map((x, k) => `
    <button class="route ${k === sel ? "sel" : ""}" data-k="${k}" aria-pressed="${k === sel}">
      <span class="head"><span class="big">${Math.round(x.duration / 60)} min</span>
        <span>${k === 0 ? '<span class="best">Best bet</span> ' : ""}<span class="m">${(x.distance / 1609.34).toFixed(1)} mi</span></span></span>
      <span class="haz"><span><b class="${x.closures.length ? "hot" : ""}">${x.closures.length}</b> closures on route</span>
        <span><b class="${x.slow.length ? "hot" : ""}">${x.slow.length}</b> slow roads</span>
        ${lastRoutes.reportsUsed ? `<span><b>${x.reports}</b> 311 nearby</span>${x.crowd ? `<span><b>${x.crowd}</b> crowd noise</span>` : ""}` : ""}</span>
      ${x.closures.length ? `<span class="m">Closed: ${[...new Set(x.closures.map(c => titleCase(c.on)))].slice(0, 4).map(esc).join(", ")}</span>` : ""}
      ${x.slow.length ? `<span class="m">Slow: ${x.slow.slice(0, 3).map(s => `${esc(titleCase(s.name))} ${Math.round(s.mph)} mph`).join(", ")}</span>` : ""}
    </button>`).join("");
}
$("routes").addEventListener("click", e => { const b = e.target.closest(".route"); if (b) drawRoutes(+b.dataset.k, true); });
$("go").addEventListener("click", findRoutes);
if (store.get("wh-mode")) $("mode").value = store.get("wh-mode");

/* ------------------------------- tabs ------------------------------- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", b.dataset.pane === name));
  document.querySelectorAll(".pane").forEach(p => { p.hidden = p.id !== "pane-" + name; });
  if (name === "closures") renderClosures();
  if (name === "social" && !$("list-social").innerHTML) loadSocial();
  store.set("wh-tab", name);
}
document.querySelector(".tabs").addEventListener("click", e => { const t = e.target.closest(".tab"); if (t) showTab(t.dataset.pane); });
document.querySelector(".tabs").addEventListener("keydown", e => {
  if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const tabs = [...document.querySelectorAll(".tab")], i = tabs.findIndex(t => t.getAttribute("aria-selected") === "true");
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  next.focus(); showTab(next.dataset.pane);
});
const hashTab = location.hash.slice(1);
showTab(document.querySelector(`.tab[data-pane="${hashTab}"]`) ? hashTab : (store.get("wh-tab") || "route"));

/* ------------------------------- boot ------------------------------- */
tickClock(); setInterval(tickClock, 15000); setInterval(renderSources, 30000);
connect();
})();
