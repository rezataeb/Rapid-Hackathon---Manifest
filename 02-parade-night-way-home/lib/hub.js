// Polls each source on its own schedule, keeps the last good result (stale-on-error),
// and notifies subscribers so the server can push updates over Server-Sent Events.
import { EventEmitter } from "node:events";
import { SOURCES } from "./feeds.js";
import { demoData } from "./demo.js";

export class Hub extends EventEmitter {
  constructor({ demo = false, sources = SOURCES, log = console } = {}) {
    super();
    this.demo = demo;
    this.sources = sources;
    this.log = log;
    this.state = {};
    this.timers = [];
    for (const [key, src] of Object.entries(sources)) {
      this.state[key] = { key, label: src.label, status: "loading", items: key === "weather" ? { hours: [], alerts: [] } : [], updatedAt: null, checkedAt: null, note: "", error: "" };
    }
  }

  async refresh(key) {
    const src = this.sources[key], s = this.state[key];
    try {
      const r = this.demo ? { items: demoData()[key], note: "Demo data" } : await src.fetch();
      Object.assign(s, { items: r.items, status: r.stale ? "stale" : "live", note: r.note || "", asOf: r.asOf || null, fresh: r.fresh ?? !r.stale, error: "", updatedAt: Date.now() });
    } catch (err) {
      s.error = err.name === "TimeoutError" ? "The source took too long to answer." : err.message;
      s.status = s.updatedAt ? "stale" : "failed";
      this.log.warn?.(`[${key}] ${s.error}`);
    }
    s.checkedAt = Date.now();
    this.emit("update", key);
    return s;
  }

  refreshAll() { return Promise.allSettled(Object.keys(this.sources).map(k => this.refresh(k))); }

  start() {
    this.refreshAll();
    for (const [key, src] of Object.entries(this.sources)) {
      const t = setInterval(() => this.refresh(key), src.everyS * 1000);
      t.unref?.();
      this.timers.push(t);
    }
    return this;
  }

  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  status() {
    return Object.fromEntries(Object.values(this.state).map(({ key, label, status, updatedAt, checkedAt, note, error, asOf, items }) =>
      [key, { label, status, updatedAt, checkedAt, note, error, asOf, count: Array.isArray(items) ? items.length : (items?.alerts?.length ?? 0) }]));
  }

  feed(key) { return this.state[key]; }
}
