"""Core logic: build the backup book, assign tables, find slots, send confirmations,
parse replies, reconcile with Resy, and save snapshots (prevention mode)."""
import csv
import math
import os
import random
import re
from datetime import datetime

SLOT_START, SLOT_END, SLOT_STEP = 17 * 60, 23 * 60, 30


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------
def to_min(t: str) -> int:
    h, m = map(int, t.split(":"))
    return h * 60 + m


def to_hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def to_12h(t: str) -> str:
    h, m = map(int, t.split(":"))
    return f"{(h - 1) % 12 + 1}:{m:02d} {'PM' if h >= 12 else 'AM'}"


def turn_time(party: int) -> int:
    return 90 if party <= 2 else 120


def slots() -> list[str]:
    return [to_hhmm(m) for m in range(SLOT_START, SLOT_END, SLOT_STEP)]


# ---------------------------------------------------------------------------
# Build the book
# ---------------------------------------------------------------------------
def norm_phone(p: str) -> str:
    d = re.sub(r"\D", "", p or "")
    return d[-10:] if len(d) >= 10 else d


def key_of(r: dict) -> str:
    return norm_phone(r.get("phone")) or (r.get("name") or "").strip().lower()


def _confidence(sources: list[str]) -> str:
    s = set(sources)
    if len(s) >= 2 or "email" in s or "resy" in s:
        return "high"
    if "printout" in s or "phone agent" in s:
        return "medium"
    return "low"


def build_book(records: list[dict]) -> list[dict]:
    """Merge records from all sources. Later records win. Duplicates collapse."""
    book: dict[str, dict] = {}
    for r in sorted(records, key=lambda r: r.get("received_at") or ""):
        k = key_of(r)
        if not k:
            continue
        action = r.get("action") or "new"
        b = book.get(k)
        if b is None:
            b = {
                "key": k, "name": r.get("name") or "?", "phone": r.get("phone") or "",
                "party_size": r.get("party_size") or 2, "time": r.get("time") or "19:00",
                "notes": r.get("notes") or "", "status": "unconfirmed",
                "sources": [], "history": [], "flags": [],
            }
            book[k] = b
        if r["source"] not in b["sources"]:
            b["sources"].append(r["source"])

        if action == "cancel":
            b["status"] = "cancelled"
        else:
            for field in ("party_size", "time"):
                new = r.get(field)
                if new and new != b[field]:
                    if action == "new" and len(b["history"]) > 0:
                        b["flags"].append(f"{field}: {b[field]} vs {new} ({r['source']})")
                    b[field] = new
            if r.get("notes") and r["notes"] not in b["notes"]:
                b["notes"] = (b["notes"] + "; " + r["notes"]).strip("; ")
            if action == "change" and b["status"] == "cancelled":
                b["status"] = "unconfirmed"
        b["history"].append(f"{r.get('received_at', '')} {r['source']}: {action}")

    for b in book.values():
        b["confidence"] = _confidence(b["sources"])
    return list(book.values())


# ---------------------------------------------------------------------------
# Tables and availability
# ---------------------------------------------------------------------------
def _overlaps(a0, a1, b0, b1):
    return a0 < b1 and b0 < a1


def _find_table(occ, tables, party, start):
    end = start + turn_time(party)
    for t in sorted(tables, key=lambda t: t["seats"]):
        if t["seats"] < party:
            continue
        if all(not _overlaps(start, end, s, e) for s, e, _ in occ[t["id"]]):
            return t["id"]
    return None


def assign_tables(book: list[dict], tables: list[dict]) -> dict:
    """Greedy: smallest table that fits. Bookings with no table get a conflict."""
    occ = {t["id"]: [] for t in tables}
    for b in book:
        b["table"], b["conflict"] = None, ""
    active = [b for b in book if b["status"] != "cancelled"]
    for b in sorted(active, key=lambda b: (to_min(b["time"]), -b["party_size"])):
        start = to_min(b["time"])
        tid = _find_table(occ, tables, b["party_size"], start)
        if tid:
            occ[tid].append((start, start + turn_time(b["party_size"]), b["name"]))
            b["table"] = tid
        else:
            b["conflict"] = f"No free table for {b['party_size']} at {b['time']}"
    return occ


def availability_grid(occ: dict, tables: list[dict]) -> list[dict]:
    rows = []
    for t in tables:
        row = {"table": f"{t['id']} ({t['seats']})"}
        for s in slots():
            m = to_min(s)
            row[s] = next((n for s0, e0, n in occ[t["id"]] if s0 <= m < e0), "")
        rows.append(row)
    return rows


def free_tables_at(occ, tables, minute):
    return sum(
        1 for t in tables
        if all(not (s <= minute < e) for s, e, _ in occ[t["id"]])
    )


def find_slot(book, tables, party, time, buffer_pct=0.1):
    """Return (time, table) for a new booking, or None. Keeps a walk-in buffer."""
    occ = assign_tables(book, tables)
    hold = math.ceil(len(tables) * buffer_pct)
    base = to_min(time)
    for off in (0, 30, -30, 60, -60, 90):
        start = base + off
        if not (SLOT_START <= start < SLOT_END):
            continue
        tid = _find_table(occ, tables, party, start)
        if tid and free_tables_at(occ, tables, start) > hold:
            return to_hhmm(start), tid
    return None


# ---------------------------------------------------------------------------
# Messaging
# ---------------------------------------------------------------------------
def confirmation_text(b: dict, restaurant: str) -> str:
    first = b["name"].split()[0]
    return (
        f"Hi {first}, this is {restaurant}. Our booking system is down, so we confirm by text. "
        f"You have a table for {b['party_size']} tonight at {to_12h(b['time'])}. "
        f"Reply YES to confirm, NO to cancel, or CHANGE to change it."
    )


def booking_readback(b: dict, restaurant: str) -> str:
    return (
        f"{restaurant}: we booked a table for {b['party_size']} tonight at {to_12h(b['time'])} "
        f"for {b['name']}. Reply YES to confirm or CHANGE to change it."
    )


def send_sms(to: str, body: str, outbox: list) -> str:
    """Uses Twilio if TWILIO_* env vars are set; otherwise writes to the mock outbox."""
    sid, token, sender = (os.getenv(k) for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"))
    status = "mock"
    if sid and token and sender:
        try:
            from twilio.rest import Client
            Client(sid, token).messages.create(to=to, from_=sender, body=body)
            status = "sent"
        except Exception as e:
            status = f"error: {e}"
    outbox.append({"time": datetime.now().strftime("%H:%M:%S"), "to": to, "body": body, "status": status})
    return status


def parse_reply(text: str) -> str:
    t = (text or "").strip().lower()
    if re.match(r"^(y|yes|yep|confirm|ok)\b", t):
        return "confirmed"
    if re.match(r"^(n|no|cancel)\b", t):
        return "cancelled"
    if "change" in t or "move" in t or "later" in t or "earlier" in t:
        return "change requested"
    return "needs human"


def simulate_replies(book: list[dict], seed: int = 7) -> list[tuple[str, str]]:
    rng = random.Random(seed)
    choices = ["YES"] * 6 + ["NO"] + ["CHANGE to 9pm please"] + [None] * 2
    replies = []
    for b in book:
        if b["status"] in ("unconfirmed", "pending"):
            r = rng.choice(choices)
            if r is None:
                b["status"] = "no reply - call"
            else:
                b["status"] = parse_reply(r)
                replies.append((b["name"], r))
    return replies


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------
def reconcile(backup: list[dict], resy: list[dict]) -> list[dict]:
    rk = {key_of(r): r for r in resy}
    bk = {b["key"]: b for b in backup}
    rows = []
    for k in sorted(set(rk) | set(bk), key=lambda k: (rk.get(k) or bk.get(k))["name"]):
        r, b = rk.get(k), bk.get(k)
        name = (r or b)["name"]
        if r and not b:
            if r["status"] != "cancelled":
                rows.append({"guest": name, "issue": "Only in Resy",
                             "detail": f"{r['party_size']} at {r['time']}", "proposed action": "Add to tonight's book"})
            continue
        if b and not r:
            if b["status"] != "cancelled":
                rows.append({"guest": name, "issue": "Only in backup",
                             "detail": f"{b['party_size']} at {b['time']} ({', '.join(b['sources'])})",
                             "proposed action": "Create in Resy" if "phone agent" in b["sources"] else "Call guest to verify"})
            continue
        r_cancel, b_cancel = r["status"] == "cancelled", b["status"] == "cancelled"
        if r_cancel != b_cancel:
            rows.append({"guest": name, "issue": "Status differs",
                         "detail": f"Resy: {r['status']} / backup: {b['status']}",
                         "proposed action": "Cancel in backup" if r_cancel else "Re-activate in backup"})
            continue
        if not r_cancel:
            for f in ("time", "party_size"):
                if str(r[f]) != str(b[f]):
                    rows.append({"guest": name, "issue": f"{f} differs",
                                 "detail": f"Resy: {r[f]} / backup: {b[f]}",
                                 "proposed action": "Use Resy value"})
    return rows


def apply_reconciliation(backup: list[dict], resy: list[dict], approved: list[dict]) -> int:
    rk = {key_of(r): r for r in resy}
    by_name = {b["name"]: b for b in backup}
    n = 0
    for row in approved:
        r = next((x for x in rk.values() if x["name"] == row["guest"]), None)
        b = by_name.get(row["guest"])
        act = row["proposed action"]
        if act == "Add to tonight's book" and r:
            backup.append({**r, "key": key_of(r), "notes": "", "status": "unconfirmed",
                           "sources": ["resy"], "history": ["resy: reconciled"], "flags": [], "confidence": "high"})
        elif act == "Cancel in backup" and b:
            b["status"] = "cancelled"
        elif act == "Use Resy value" and b and r:
            b["time"], b["party_size"] = r["time"], r["party_size"]
        elif b:
            b.setdefault("flags", []).append(f"Reconcile: {act}")
        n += 1
    return n


# ---------------------------------------------------------------------------
# Prevention mode
# ---------------------------------------------------------------------------
def save_snapshot(book: list[dict], path: str = "snapshots") -> str:
    """Run every 15 min (cron/scheduler) while Resy is up, so an outage is never blind."""
    os.makedirs(path, exist_ok=True)
    fn = os.path.join(path, f"book_{datetime.now():%Y%m%d_%H%M}.csv")
    cols = ["time", "name", "party_size", "phone", "status", "table", "notes"]
    with open(fn, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(sorted(book, key=lambda b: b["time"]))
    return fn
