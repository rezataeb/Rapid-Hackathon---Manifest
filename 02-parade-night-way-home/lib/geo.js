// Small-area geometry for scoring routes against hazards. Equirectangular projection
// is accurate to well under 1% across NYC, which is plenty for "is this within 20 m".

const M_PER_DEG_LAT = 110_540;

export function projector(lat0) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return ([lat, lon]) => [lon * kx, lat * M_PER_DEG_LAT];
}

export function distPointSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

export function distPointLine(p, line) {
  let min = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = distPointSegment(p, line[i - 1], line[i]);
    if (d < min) min = d;
  }
  return min;
}

export function bbox(points, padDeg = 0) {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const [lat, lon] of points) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return { s: s - padDeg, n: n + padDeg, w: w - padDeg, e: e + padDeg };
}

export const inBox = (b, [lat, lon]) => lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;

export const NYC_BOX = { s: 40.47, n: 40.93, w: -74.27, e: -73.68 };

export const THRESHOLDS = {
  closureOnRouteM: 18,   // closure block midpoint this close = route runs along it
  slowLinkM: 35,         // speed-sensor link this close = route uses that road
  slowMph: 15,
  reportM: 75,
};

/**
 * Score one route (array of [lat, lon]) against current hazards.
 * Lower score is better. Duration is in seconds.
 */
export function scoreRoute(path, durationS, { closures = [], speeds = [], reports = [] }) {
  const box = bbox(path, 0.003);
  const P = projector((box.s + box.n) / 2);
  const line = path.map(P);

  const onRoute = closures.filter(c => inBox(box, c.mid) && distPointLine(P(c.mid), line) < THRESHOLDS.closureOnRouteM);

  const slow = speeds.filter(s =>
    s.mph < THRESHOLDS.slowMph &&
    s.pts.some((p, i) => i % 2 === 0 && inBox(box, p) && distPointLine(P(p), line) < THRESHOLDS.slowLinkM));

  const near = reports.filter(r => inBox(box, [r.lat, r.lon]) && distPointLine(P([r.lat, r.lon]), line) < THRESHOLDS.reportM);
  const crowd = near.filter(r => r.kind === "crowd").length;

  const score = onRoute.length * 4 + slow.length * 2 + near.length * 0.4 + crowd * 0.6 + (durationS / 60) * 0.25;
  return {
    score: Math.round(score * 10) / 10,
    closures: onRoute.map(({ id, on, from, to, mid, purpose }) => ({ id, on, from, to, mid, purpose })),
    slow: slow.map(({ id, name, mph }) => ({ id, name, mph })),
    reports: near.length,
    crowd,
  };
}
