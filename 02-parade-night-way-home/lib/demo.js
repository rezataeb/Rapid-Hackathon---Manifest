// Synthetic sample data for DEMO=1. Used for offline development, screenshots and tests.
// Every record is invented; the UI shows a "Demo data" banner whenever this mode is on.
import { nycISO, minutesAgo, hoursFromNow } from "./time.js";

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = a => a[Math.floor(rand() * a.length)];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Rough Manhattan corridors (approximate points, good enough for a demo map)
const CORRIDORS = {
  "BROADWAY": [[40.7046, -74.0139], [40.7127, -74.0080], [40.7230, -74.0010], [40.7359, -73.9911], [40.7505, -73.9877], [40.7580, -73.9855]],
  "7 AVENUE": [[40.7380, -74.0010], [40.7505, -73.9910], [40.7590, -73.9850]],
  "8 AVENUE": [[40.7400, -74.0040], [40.7500, -73.9960], [40.7600, -73.9890]],
  "WEST 34 STREET": [[40.7540, -73.9990], [40.7505, -73.9905], [40.7480, -73.9850]],
  "CHURCH STREET": [[40.7090, -74.0110], [40.7160, -74.0060], [40.7200, -74.0040]],
  "FDR DRIVE": [[40.7080, -73.9990], [40.7300, -73.9740], [40.7550, -73.9640]],
  "WEST SIDE HIGHWAY": [[40.7050, -74.0170], [40.7300, -74.0110], [40.7600, -74.0020]],
};
const CROSS = ["CORTLANDT ST", "LIBERTY ST", "FULTON ST", "WEST 31 ST", "WEST 33 ST", "WEST 35 ST", "CANAL ST", "HOUSTON ST", "PARK PL"];

function along(path, t) {
  const seg = Math.min(path.length - 2, Math.floor(t * (path.length - 1)));
  return lerp(path[seg], path[seg + 1], t * (path.length - 1) - seg);
}

export function demoData() {
  seed = 7;
  const closures = [];
  Object.entries(CORRIDORS).forEach(([on, path]) => {
    const n = on === "BROADWAY" ? 9 : 3;
    for (let i = 0; i < n; i++) {
      const t = rand() * 0.9;
      const a = along(path, t), b = along(path, t + 0.04);
      closures.push({ id: `demo-c-${on}-${i}`, on, from: pick(CROSS), to: pick(CROSS), boro: "Manhattan",
        purpose: pick(["DEMO · Event barricades", "DEMO · Utility work", "DEMO · Crane operation", "DEMO · Paving"]),
        start: nycISO(minutesAgo(600)), end: nycISO(hoursFromNow(30)), lines: [[a, b]], mid: lerp(a, b, 0.5) });
    }
  });

  const speeds = Object.entries(CORRIDORS).map(([name, path], i) => ({
    id: `demo-s-${i}`, name: `${name} (demo)`, boro: "Manhattan",
    mph: name.includes("BROADWAY") || name.includes("34") ? 4 + rand() * 5 : name.includes("FDR") ? 28 + rand() * 10 : 11 + rand() * 9,
    asOf: nycISO(minutesAgo(3)), pts: path,
  }));

  const reports = [];
  for (let i = 0; i < 70; i++) {
    const hot = i < 40;
    const base = hot ? along(CORRIDORS.BROADWAY, rand() * 0.25) : along(pick(Object.values(CORRIDORS)), rand());
    const type = hot ? pick(["Noise - Street/Sidewalk", "Noise - Street/Sidewalk", "Noise - Vehicle", "Obstruction"]) : pick(["Illegal Parking", "Blocked Driveway", "Traffic Signal Condition", "Street Condition"]);
    reports.push({ id: `demo-r-${i}`, created: nycISO(minutesAgo(Math.floor(rand() * 170))), type,
      descriptor: type.startsWith("Noise") ? "Loud Talking (demo)" : "Sample report (demo)",
      address: "DEMO ADDRESS", boro: "MANHATTAN", lat: base[0] + (rand() - 0.5) * 0.002, lon: base[1] + (rand() - 0.5) * 0.002,
      kind: /^Noise/.test(type) ? "crowd" : /Parking|Driveway/.test(type) ? "parking" : "street" });
  }
  reports.sort((a, b) => b.created.localeCompare(a.created));

  const events = [
    { id: "demo-e1", name: "Sample Championship Rally (demo)", start: nycISO(minutesAgo(60)), end: nycISO(hoursFromNow(3)), agency: "Street Activity Permit Office", type: "Parade", boro: "Manhattan", location: "BROADWAY between BATTERY PLACE and PARK ROW", closure: "Full Street Closure" },
    { id: "demo-e2", name: "Sample Street Fair (demo)", start: nycISO(hoursFromNow(1)), end: nycISO(hoursFromNow(6)), agency: "Street Activity Permit Office", type: "Street Fair", boro: "Manhattan", location: "WEST 34 STREET between 7 AVENUE and 8 AVENUE", closure: "Full Street Closure" },
    { id: "demo-e3", name: "Sample Film Shoot (demo)", start: nycISO(minutesAgo(30)), end: nycISO(hoursFromNow(8)), agency: "Mayor's Office of Media and Entertainment", type: "Production Event", boro: "Brooklyn", location: "Sample block, Brooklyn", closure: "Curb Lane Only" },
    { id: "demo-e4", name: "Sample Concert (demo)", start: nycISO(hoursFromNow(2)), end: nycISO(hoursFromNow(5)), agency: "Parks Department", type: "Special Event", boro: "Manhattan", location: "Central Park: Sample Lawn", closure: null },
  ];

  const transit = [
    { id: "demo-t1", text: "DEMO: 4 and 5 trains are running with delays because of crowding at Fulton St.", routes: ["4", "5"], kind: "Delays" },
    { id: "demo-t2", text: "DEMO: Some downtown R and W trains are skipping Cortlandt St.", routes: ["R", "W"], kind: "Stops Skipped" },
    { id: "demo-t3", text: "DEMO: Extra A and C service is running after the event.", routes: ["A", "C"], kind: "Special Schedule" },
  ];

  const weather = {
    hours: Array.from({ length: 8 }, (_, i) => ({ time: new Date(Date.now() + i * 3_600_000).toISOString(), temp: 64 - i, unit: "F", short: i < 3 ? "Partly Cloudy" : "Mostly Clear", rain: i < 2 ? 10 : 0, wind: "8 mph" })),
    alerts: [],
  };

  return { speeds, closures, events, reports, transit, weather };
}

export function demoRoutes(from, to) {
  const mid = lerp(from, to, 0.5);
  const dx = to[1] - from[1], dy = to[0] - from[0];
  const offsets = [0, 0.006, -0.006];
  return offsets.map((o, i) => {
    const bend = [mid[0] - dx * o * 40, mid[1] + dy * o * 40];
    const path = [];
    for (let k = 0; k <= 30; k++) {
      const t = k / 30;
      path.push(t < 0.5 ? lerp(from, bend, t * 2) : lerp(bend, to, (t - 0.5) * 2));
    }
    const km = path.reduce((s, p, k) => k ? s + Math.hypot((p[0] - path[k - 1][0]) * 110.5, (p[1] - path[k - 1][1]) * 84.3) : 0, 0);
    return { duration: km * 160 + i * 90, distance: km * 1000, path };
  });
}

export const demoSocial = q => [
  { id: "demo-p1", text: `DEMO post: Broadway is packed near City Hall, walk east to the 4/5. (search: ${q})`, handle: "sample.demo", name: "Sample", at: new Date(Date.now() - 4 * 60_000).toISOString(), url: "https://bsky.app" },
  { id: "demo-p2", text: "DEMO post: West Side Highway moving fine northbound right now.", handle: "sample2.demo", name: "Sample 2", at: new Date(Date.now() - 11 * 60_000).toISOString(), url: "https://bsky.app" },
];
