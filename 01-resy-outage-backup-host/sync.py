"""Safe re-injection into Resy when it comes back (often with no warning).

Design
------
1. Op log: every change made during the outage is an operation with an
   idempotency key (op_id). Nothing is written to Resy directly during the outage.
2. Three-way check per operation:
     base   = what we believed Resy had when we made the change
     ours   = the operation
     theirs = Resy right now (fresh pull - online bookings may have arrived)
   Only "ours changed, theirs did not" is pushed automatically.
   "Both changed" is a conflict -> human decides.
3. Order: cancels -> modifies -> creates. Cancels free tables first.
4. Check-then-write: before each create/modify, Resy availability is re-checked.
   If the slot was taken by a new online booking, the op becomes a conflict with an
   alternative slot - we never double-book.
5. Idempotency: op_id is written into the Resy booking notes. A retry after a crash
   or timeout finds it and does not create a duplicate.
6. Verify: re-pull Resy and confirm every synced op is really there.
7. After sync, Resy is the source of truth again; the backup book is read-only.

ResyAdapter
-----------
MockResy is a stand-in. As far as we know, Resy does not offer an open public write API
to every restaurant; a real deployment needs partner API access, or the "assisted entry"
fallback (a checklist the host types into Resy OS, ticked off one by one).
"""
import copy
import uuid
from datetime import datetime

from core import _find_table, assign_tables, find_slot, key_of, to_min

ORDER = {"cancel": 0, "modify": 1, "create": 2}


class ResyConflict(Exception):
    pass


# ---------------------------------------------------------------------------
# Resy adapter (mock)
# ---------------------------------------------------------------------------
class MockResy:
    def __init__(self, bookings, tables):
        self.tables = tables
        self.bookings = []
        for b in copy.deepcopy(bookings):
            b.setdefault("notes", "")
            b["id"] = f"R{len(self.bookings) + 1:03d}"
            self.bookings.append(b)

    # --- read -------------------------------------------------------------
    def health(self) -> bool:
        return True

    def list_bookings(self) -> list[dict]:
        return copy.deepcopy(self.bookings)

    def _get(self, rid):
        return next(b for b in self.bookings if b["id"] == rid)

    def _table_for(self, party, time, exclude_id=None):
        others = [copy.deepcopy(b) for b in self.bookings if b["id"] != exclude_id]
        occ = assign_tables(others, self.tables)
        return _find_table(occ, self.tables, party, to_min(time))

    # --- write ------------------------------------------------------------
    def create(self, b: dict, idem_key: str) -> dict:
        existing = next((x for x in self.bookings if idem_key in x.get("notes", "")), None)
        if existing:  # retry-safe: already written before
            return existing
        if not self._table_for(b["party_size"], b["time"]):
            raise ResyConflict(f"No table for {b['party_size']} at {b['time']} in Resy")
        new = {"id": f"R{len(self.bookings) + 1:03d}", "name": b["name"], "phone": b["phone"],
               "party_size": b["party_size"], "time": b["time"], "status": "booked",
               "notes": f"{b.get('notes', '')} [{idem_key}]".strip()}
        self.bookings.append(new)
        return new

    def cancel(self, rid: str) -> dict:
        b = self._get(rid)
        b["status"] = "cancelled"
        return b

    def modify(self, rid: str, party: int, time: str, idem_key: str) -> dict:
        b = self._get(rid)
        if idem_key in b.get("notes", ""):
            return b
        if not self._table_for(party, time, exclude_id=rid):
            raise ResyConflict(f"No table for {party} at {time} in Resy")
        b.update(party_size=party, time=time, notes=f"{b.get('notes', '')} [{idem_key}]".strip())
        return b

    # --- demo helper: the race ---------------------------------------------
    def online_booking(self, name, phone, party, time):
        """A guest books on the Resy website in the first minute after it comes back."""
        try:
            return self.create({"name": name, "phone": phone, "party_size": party, "time": time},
                               f"WEB-{uuid.uuid4().hex[:6]}")
        except ResyConflict:
            return None


# ---------------------------------------------------------------------------
# Op log
# ---------------------------------------------------------------------------
def new_op(kind: str, b: dict, base: dict | None = None, **changes) -> dict:
    return {
        "op_id": f"BH-{uuid.uuid4().hex[:8]}",
        "kind": kind,
        "key": b["key"],
        "name": b["name"],
        "phone": b["phone"],
        "party_size": changes.get("party_size", b["party_size"]),
        "time": changes.get("time", b["time"]),
        "notes": b.get("notes", ""),
        "base": base or {"time": b["time"], "party_size": b["party_size"]},
        "status": "queued",
        "result": "",
        "ts": datetime.now().isoformat(timespec="seconds"),
    }


def log_cancel(ops: list, b: dict):
    """Guest cancelled during outage. If we created the booking ourselves, just drop the queued create."""
    queued_create = next((o for o in ops if o["key"] == b["key"] and o["kind"] == "create"
                          and o["status"] == "queued"), None)
    if queued_create:
        queued_create.update(status="dropped", result="Guest cancelled before sync")
        return
    if not any(o["key"] == b["key"] and o["kind"] == "cancel" for o in ops):
        ops.append(new_op("cancel", b))


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------
def _alt(resy, tables, party, time):
    alt = find_slot(resy.list_bookings(), tables, party, time, buffer_pct=0)
    return f" Offer the guest {alt[0]}." if alt else " Offer the waitlist."


def sync(resy, ops: list, tables: list) -> list[dict]:
    """Push queued ops to Resy. Returns a report. Safe to run again (idempotent)."""
    todo = [o for o in ops if o["status"] in ("queued", "failed")]
    for op in sorted(todo, key=lambda o: (ORDER[o["kind"]], o["ts"])):
        # fresh read before every write: online bookings and our own earlier ops count
        r = {key_of(x): x for x in resy.list_bookings()}.get(op["key"])
        try:
            if op["kind"] == "cancel":
                if not r or r["status"] == "cancelled":
                    op.update(status="skipped", result="Already cancelled in Resy")
                elif (r["time"], r["party_size"]) != (op["base"]["time"], op["base"]["party_size"]):
                    op.update(status="conflict",
                              result=f"Guest changed it in Resy ({r['party_size']} at {r['time']}). Host must decide.")
                else:
                    resy.cancel(r["id"])
                    op.update(status="synced", result=f"Cancelled {r['id']} in Resy")

            elif op["kind"] == "modify":
                if not r or r["status"] == "cancelled":
                    op.update(status="conflict", result="Booking not active in Resy. Host must decide.")
                elif (r["time"], r["party_size"]) != (op["base"]["time"], op["base"]["party_size"]):
                    op.update(status="conflict", result=f"Also changed in Resy ({r['party_size']} at {r['time']}).")
                else:
                    resy.modify(r["id"], op["party_size"], op["time"], op["op_id"])
                    op.update(status="synced", result=f"Updated {r['id']} to {op['party_size']} at {op['time']}")

            elif op["kind"] == "create":
                if r and r["status"] != "cancelled":
                    if (r["time"], r["party_size"]) == (op["time"], op["party_size"]):
                        op.update(status="synced", result=f"Already in Resy as {r['id']} (guest booked online too)")
                    else:
                        op.update(status="conflict",
                                  result=f"Guest also has Resy booking {r['party_size']} at {r['time']}. Keep one.")
                else:
                    new = resy.create(op, op["op_id"])
                    op.update(status="synced", result=f"Created {new['id']} in Resy")
        except ResyConflict as e:
            op.update(status="conflict", result=str(e) + "." + _alt(resy, tables, op["party_size"], op["time"]))
        except Exception as e:  # network error etc. -> retry next run
            op.update(status="failed", result=f"Retry: {e}")

    # Verify: re-pull and check every synced create/modify is really in Resy
    after = resy.list_bookings()
    for op in ops:
        if op["status"] == "synced" and op["kind"] in ("create", "modify"):
            ok = any(key_of(b) == op["key"] and b["status"] != "cancelled"
                     and b["time"] == op["time"] for b in after)
            if not ok:
                op.update(status="failed", result="Verify failed - not found in Resy. Retry.")
    return ops


def assisted_entry_checklist(ops: list) -> list[str]:
    """Fallback when no write API: a checklist the host types into Resy OS."""
    lines = []
    for o in sorted(ops, key=lambda o: (ORDER[o["kind"]], o["ts"])):
        if o["status"] not in ("queued", "failed"):
            continue
        if o["kind"] == "cancel":
            lines.append(f"CANCEL {o['name']} ({o['party_size']} at {o['time']}) - ref {o['op_id']}")
        elif o["kind"] == "modify":
            lines.append(f"CHANGE {o['name']} to {o['party_size']} at {o['time']} - ref {o['op_id']}")
        else:
            lines.append(f"CREATE {o['name']}, {o['phone']}, {o['party_size']} at {o['time']} - put '{o['op_id']}' in notes")
    return lines
