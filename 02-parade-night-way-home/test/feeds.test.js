import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLinkPoints, normalizeSpeeds, normalizeClosures, normalizeEvents,
  normalizeReports, normalizeTransit, normalizeWeather, normalizeSocial, reportKind,
} from "../lib/feeds.js";
import { scoreRoute, distPointLine, projector } from "../lib/geo.js";
import { nycISO } from "../lib/time.js";
import { Hub } from "../lib/hub.js";

// Payload shapes below mirror the real feeds; values are made up.

test("parseLinkPoints drops truncated pairs and points outside NYC", () => {
  const pts = parseLinkPoints("40.78795,-73.790191 40.78647,-73.78812 51.5,-0.12 40.786");
  assert.deepEqual(pts, [[40.78795, -73.790191], [40.78647, -73.78812]]);
});

test("normalizeSpeeds keeps the newest reading per link", () => {
  const rows = [
    { link_id: "1", speed: "8.2", data_as_of: "2026-10-07T18:30:00.000", link_points: "40.75,-73.99 40.76,-73.98", link_name: "BWAY", borough: "Manhattan" },
    { link_id: "1", speed: "30", data_as_of: "2026-10-07T18:00:00.000", link_points: "40.75,-73.99 40.76,-73.98", link_name: "BWAY", borough: "Manhattan" },
    { link_id: "2", speed: "x", link_points: "40.75,-73.99 40.76,-73.98" },
  ];
  const out = normalizeSpeeds(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].mph, 8.2);
});

test("normalizeClosures flips GeoJSON lon/lat and computes a midpoint", () => {
  const [c] = normalizeClosures([{
    uniqueid: "u1", onstreetname: "BROADWAY", fromstreetname: "A", tostreetname: "B", borough_code: "M", purpose: "PAVING",
    work_start_date: "2026-10-07T00:00:00.000", work_end_date: "2026-10-08T00:00:00.000",
    the_geom: { type: "MultiLineString", coordinates: [[[-74.0, 40.7], [-74.002, 40.702]]] },
  }]);
  assert.deepEqual(c.lines[0][0], [40.7, -74.0]);
  assert.deepEqual(c.mid.map(v => +v.toFixed(3)), [40.701, -74.001]);
  assert.equal(c.boro, "Manhattan");
});

test("normalizeEvents de-duplicates and puts street closures first", () => {
  const out = normalizeEvents([
    { event_id: "1", event_name: "Fair", start_date_time: "2026-10-07T10:00:00", street_closure_type: "N/A" },
    { event_id: "2", event_name: "Parade", start_date_time: "2026-10-07T12:00:00", street_closure_type: "Full Street Closure" },
    { event_id: "2", event_name: "Parade", start_date_time: "2026-10-07T12:00:00", street_closure_type: "Full Street Closure" },
  ]);
  assert.deepEqual(out.map(e => e.id), ["2", "1"]);
  assert.equal(out[1].closure, null);
});

test("normalizeReports filters bad coordinates and classifies", () => {
  const out = normalizeReports([
    { unique_key: "1", complaint_type: "Noise - Street/Sidewalk", latitude: "40.71", longitude: "-74.0" },
    { unique_key: "2", complaint_type: "Illegal Parking" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "crowd");
  assert.equal(reportKind("Blocked Driveway"), "parking");
  assert.equal(reportKind("Traffic Signal Condition"), "street");
});

test("normalizeTransit keeps active English alerts and strips route brackets", () => {
  const now = 1_800_000_000;
  const feed = { entity: [
    { id: "a", alert: { active_period: [{ start: now - 60, end: now + 60 }], informed_entity: [{ route_id: "D" }, { route_id: "D" }, { stop_id: "x" }],
      header_text: { translation: [{ language: "en-html", text: "<p>x</p>" }, { language: "en", text: "[D] trains are delayed." }] } } },
    { id: "b", alert: { active_period: [{ start: now + 600 }], header_text: { translation: [{ language: "en", text: "Later" }] } } },
  ] };
  const out = normalizeTransit(feed, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "D trains are delayed.");
  assert.deepEqual(out[0].routes, ["D"]);
});

test("normalizeWeather and normalizeSocial handle empty input", () => {
  assert.deepEqual(normalizeWeather(null, null), { hours: [], alerts: [] });
  assert.deepEqual(normalizeSocial({}), []);
});

test("nycISO formats in New York time", () => {
  assert.equal(nycISO(new Date("2026-10-07T22:31:05Z")), "2026-10-07T18:31:05");
  assert.equal(nycISO(new Date("2026-01-15T04:00:00Z")), "2026-01-14T23:00:00");
});

test("distPointLine measures meters", () => {
  const P = projector(40.75);
  const line = [P([40.75, -73.99]), P([40.76, -73.99])];
  const d = distPointLine(P([40.755, -73.9895]), line);
  assert.ok(d > 35 && d < 50, `expected ~42 m, got ${d}`);
});

test("scoreRoute counts closures on the route and ignores ones a block away", () => {
  const path = [[40.75, -73.99], [40.76, -73.99]];
  const closures = [
    { id: "on", on: "SEVENTH AVE", mid: [40.755, -73.99001] },
    { id: "off", on: "EIGHTH AVE", mid: [40.755, -73.993] },
  ];
  const speeds = [{ id: "s", name: "slow", mph: 6, pts: [[40.752, -73.9901], [40.758, -73.9901]] },
                  { id: "f", name: "fast", mph: 40, pts: [[40.752, -73.99], [40.758, -73.99]] }];
  const reports = [{ lat: 40.757, lon: -73.9905, kind: "crowd" }, { lat: 40.70, lon: -74.0, kind: "street" }];
  const r = scoreRoute(path, 600, { closures, speeds, reports });
  assert.deepEqual(r.closures.map(c => c.id), ["on"]);
  assert.deepEqual(r.slow.map(s => s.id), ["s"]);
  assert.equal(r.reports, 1);
  assert.equal(r.crowd, 1);
});

test("Hub keeps the last good data when a source starts failing", async () => {
  let fail = false;
  const sources = { x: { label: "X", everyS: 999, async fetch() { if (fail) throw new Error("down"); return { items: [1, 2] }; } } };
  const hub = new Hub({ sources, log: {} });
  await hub.refresh("x");
  assert.equal(hub.feed("x").status, "live");
  fail = true;
  await hub.refresh("x");
  assert.equal(hub.feed("x").status, "stale");
  assert.deepEqual(hub.feed("x").items, [1, 2]);
  assert.equal(hub.status().x.error, "down");
});

test("describeNyc labels a floating timestamp", async () => {
  const { describeNyc } = await import("../lib/feeds.js");
  assert.equal(describeNyc("2026-10-06T02:05:43.000"), "Oct 6, 2:05 am");
  assert.equal(describeNyc("2026-10-07T18:30:00.000"), "Oct 7, 6:30 pm");
});
