export const TZ = "America/New_York";

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** NYC local time as "YYYY-MM-DDTHH:MM:SS" — the floating format NYC Open Data stores. */
export function nycISO(date = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export const minutesAgo = (m, now = Date.now()) => new Date(now - m * 60_000);
export const hoursFromNow = (h, now = Date.now()) => new Date(now + h * 3_600_000);
