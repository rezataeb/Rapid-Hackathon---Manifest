"""Backup Host - keeps the restaurant running when Resy is down.

Run:  streamlit run app.py
"""
import pandas as pd
import streamlit as st

from core import (apply_reconciliation, assign_tables, availability_grid, booking_readback,
                  build_book, confirmation_text, find_slot, key_of, parse_reply, reconcile,
                  save_snapshot, send_sms, simulate_replies, slots, to_12h)
from extract import extract_emails, extract_printout, extract_voicemails, llm_available
from mock_data import (EMAILS, PRINTOUT_CSV, PRINTOUT_TIME, RESTAURANT, RESY_BOOK, TABLES,
                       VOICEMAILS)
from sync import MockResy, ResyConflict, assisted_entry_checklist, log_cancel, new_op, sync

st.set_page_config(page_title="Backup Host", page_icon="🍽️", layout="wide")
ss = st.session_state
for k, v in {"book": [], "outbox": [], "replies": [], "resy_back": False, "stats": {},
             "ops": [], "resy": None, "sync_runs": 0}.items():
    ss.setdefault(k, v)

# ---------------------------------------------------------------------------
# Sidebar
# ---------------------------------------------------------------------------
with st.sidebar:
    st.title("🍽️ Backup Host")
    st.caption(RESTAURANT)
    resy = st.radio("Resy status", ["🔴 Down", "🟢 Back online"], index=1 if ss.resy_back else 0)
    ss.resy_back = resy.startswith("🟢")
    buffer_pct = st.slider("Walk-in buffer", 0, 30, 10, format="%d%%") / 100
    use_llm = st.toggle("Use Claude for extraction", value=llm_available(), disabled=not llm_available())
    st.caption("Claude API: " + ("connected" if llm_available() else "no key - rule mode"))
    st.divider()
    st.subheader("Re-injection")
    auto_sync = st.toggle("Auto-sync when Resy answers", value=True)
    race = st.checkbox("Simulate: a guest books online the minute Resy is back", value=True)
    queued = sum(o["status"] in ("queued", "failed") for o in ss.ops)
    st.caption(f"Health check every 60 s · {queued} change(s) waiting to sync")
    st.divider()
    st.subheader("Prevention mode")
    st.caption("Copy the book every 15 min while Resy is up.")
    if st.button("Save snapshot now", disabled=not ss.book):
        st.success(f"Saved {save_snapshot(ss.book)}")

# --- Resy comes back (maybe with no warning) --------------------------------
if not ss.resy_back:
    ss.resy = None
elif ss.resy is None:
    ss.resy = MockResy(RESY_BOOK, TABLES)
    last = next((o for o in reversed(ss.ops) if o["kind"] == "create" and o["status"] == "queued"), None)
    if race and last:  # the race: online booking grabs the same slot before we sync
        ss.resy.online_booking("Web Guest", "212-555-0100", last["party_size"], last["time"])
if ss.resy_back and auto_sync and any(o["status"] in ("queued", "failed") for o in ss.ops):
    sync(ss.resy, ss.ops, TABLES)
    ss.sync_runs += 1

st.title("Resy is down. Service starts at 5:30 PM." if not ss.resy_back
         else "Resy is back. It is the source of truth again.")

tab1, tab2, tab3, tab4, tab5 = st.tabs(
    ["1 · Rebuild book", "2 · Availability", "3 · Confirm guests", "4 · New booking", "5 · Reconcile"]
)


def book_df(book):
    if not book:
        return pd.DataFrame()
    df = pd.DataFrame(book)
    df["sources"] = df["sources"].apply(", ".join)
    df["flags"] = df["flags"].apply(lambda f: "; ".join(f))
    cols = ["time", "name", "party_size", "phone", "status", "table", "conflict",
            "confidence", "sources", "notes", "flags"]
    return df[[c for c in cols if c in df]].sort_values("time")


# ---------------------------------------------------------------------------
# 1. Rebuild
# ---------------------------------------------------------------------------
with tab1:
    c1, c2, c3 = st.columns(3)
    with c1.expander(f"📧 Inbox: {len(EMAILS)} Resy emails"):
        st.text("\n\n-----\n\n".join(EMAILS))
    with c2.expander("🖨️ Morning printout (08:00)"):
        st.code(PRINTOUT_CSV)
    with c3.expander(f"📞 Voicemails: {len(VOICEMAILS)}"):
        for ts, t in VOICEMAILS:
            st.write(f"**{ts}** - {t}")

    if st.button("🔄 Rebuild book from all sources", type="primary"):
        with st.spinner("Reading emails, printout, and voicemails..."):
            em, mode1 = extract_emails(EMAILS, use_llm)
            vm, mode2 = extract_voicemails(VOICEMAILS, use_llm)
            pr = extract_printout(PRINTOUT_CSV, PRINTOUT_TIME)
            ss.book = build_book(em + pr + vm)
            assign_tables(ss.book, TABLES)
            ss.stats = {"records": len(em) + len(pr) + len(vm), "mode": mode1}
            ss.outbox, ss.replies = [], []

    if ss.book:
        active = [b for b in ss.book if b["status"] != "cancelled"]
        m = st.columns(5)
        m[0].metric("Records read", ss.stats.get("records", 0))
        m[1].metric("Unique bookings", len(ss.book))
        m[2].metric("Active tonight", len(active))
        m[3].metric("Cancelled", len(ss.book) - len(active))
        m[4].metric("Conflicts", sum(1 for b in active if b.get("conflict")))
        st.caption(f"Extraction mode: {ss.stats.get('mode')}")
        st.dataframe(book_df(ss.book), width="stretch", hide_index=True)

# ---------------------------------------------------------------------------
# 2. Availability
# ---------------------------------------------------------------------------
with tab2:
    if not ss.book:
        st.info("Rebuild the book first.")
    else:
        occ = assign_tables(ss.book, TABLES)
        grid = pd.DataFrame(availability_grid(occ, TABLES)).set_index("table")

        def color(v):
            return "background-color:#f8d7da;color:#58151c" if v else "background-color:#d1e7dd"

        styler = grid.style
        styler = styler.map(color) if hasattr(styler, "map") else styler.applymap(color)
        st.dataframe(styler, width="stretch", height=470)
        for b in ss.book:
            if b.get("conflict") and b["status"] != "cancelled":
                st.error(f"⚠️ {b['name']} ({b['party_size']}): {b['conflict']} - host must decide")
        for b in ss.book:
            if b["confidence"] == "low" and b["status"] != "cancelled":
                st.warning(f"❓ {b['name']}: only from {', '.join(b['sources'])} - verify by phone")

# ---------------------------------------------------------------------------
# 3. Confirm
# ---------------------------------------------------------------------------
with tab3:
    if not ss.book:
        st.info("Rebuild the book first.")
    else:
        c1, c2 = st.columns(2)
        if c1.button("📤 Send confirmation SMS to all active guests", type="primary"):
            for b in ss.book:
                if b["status"] == "unconfirmed":
                    send_sms(b["phone"], confirmation_text(b, RESTAURANT), ss.outbox)
        if c2.button("🎲 Simulate guest replies", disabled=not ss.outbox):
            ss.replies = simulate_replies(ss.book)
            replied = {name for name, _ in ss.replies}
            for b in ss.book:
                if b["status"] == "cancelled" and b["name"] in replied:
                    log_cancel(ss.ops, b)
            assign_tables(ss.book, TABLES)

        with st.form("manual_reply"):
            st.write("**Enter a real reply**")
            names = [b["name"] for b in ss.book if b["status"] != "cancelled"]
            fc1, fc2 = st.columns([1, 2])
            who = fc1.selectbox("Guest", names)
            text = fc2.text_input("Reply text", "YES")
            if st.form_submit_button("Apply reply"):
                b = next(b for b in ss.book if b["name"] == who)
                b["status"] = parse_reply(text)
                ss.replies.append((who, text))
                if b["status"] == "cancelled":
                    log_cancel(ss.ops, b)
                assign_tables(ss.book, TABLES)

        counts = pd.Series([b["status"] for b in ss.book]).value_counts()
        st.write(" · ".join(f"**{k}**: {v}" for k, v in counts.items()))

        call_list = [b for b in ss.book if b["status"] in ("no reply - call", "change requested", "needs human")]
        if call_list:
            st.subheader("📞 Call list for staff")
            st.dataframe(book_df(call_list)[["time", "name", "phone", "status", "notes"]],
                         hide_index=True, width="stretch")
        if ss.replies:
            st.subheader("Replies")
            st.dataframe(pd.DataFrame(ss.replies, columns=["guest", "reply"]), hide_index=True)
        if ss.outbox:
            st.subheader(f"Outbox ({len(ss.outbox)})")
            st.dataframe(pd.DataFrame(ss.outbox), hide_index=True, width="stretch")

# ---------------------------------------------------------------------------
# 4. New booking (what the phone / SMS agent does)
# ---------------------------------------------------------------------------
with tab4:
    if not ss.book:
        st.info("Rebuild the book first.")
    else:
        st.caption("The phone or SMS agent uses this logic. New bookings are 'pending' until Resy is back.")
        with st.form("new_booking"):
            c = st.columns(4)
            name = c[0].text_input("Name", "Leila Ahmadi")
            phone = c[1].text_input("Phone", "917-555-0166")
            party = c[2].number_input("Party size", 1, 12, 4)
            want = c[3].selectbox("Time", slots(), index=slots().index("19:00"))
            if st.form_submit_button("Check and book", type="primary"):
                if ss.resy_back:  # Resy is the source of truth again: never book in the backup
                    try:
                        r = ss.resy.create({"name": name, "phone": phone, "party_size": int(party),
                                            "time": want}, f"BH-direct-{key_of({'phone': phone})}")
                        st.success(f"Resy is online, so the agent booked directly in Resy ({r['id']}).")
                    except ResyConflict as e:
                        st.error(f"{e}. Offer another time.")
                    st.stop()
                res = find_slot(ss.book, TABLES, int(party), want, buffer_pct)
                if not res:
                    st.error("No table within ±90 minutes. Offer the waitlist.")
                else:
                    t, tid = res
                    b = {"key": key_of({"phone": phone, "name": name}), "name": name, "phone": phone,
                         "party_size": int(party), "time": t, "notes": "Booked during outage",
                         "status": "pending", "sources": ["phone agent"], "history": [], "flags": [],
                         "confidence": "medium"}
                    ss.book.append(b)
                    ss.ops.append(new_op("create", b))
                    assign_tables(ss.book, TABLES)
                    send_sms(phone, booking_readback(b, RESTAURANT), ss.outbox)
                    msg = f"Booked {name}, {party} guests at {to_12h(t)} on {b['table']}."
                    if t != want:
                        msg += f" (Asked for {to_12h(want)} - not free, so the agent offered the nearest slot.)"
                    st.success(msg + " SMS read-back sent.")

# ---------------------------------------------------------------------------
# 5. Reconcile
# ---------------------------------------------------------------------------
with tab5:
    st.subheader("A · Push outage changes to Resy (safe sync)")
    st.caption("Order: cancels → changes → new bookings. Each write re-checks Resy first. "
               "Each op has an idempotency key, so a retry never makes a duplicate.")
    if ss.ops:
        cols = ["op_id", "kind", "name", "party_size", "time", "status", "result"]
        st.dataframe(pd.DataFrame(ss.ops)[cols], hide_index=True, width="stretch")
        sc1, sc2 = st.columns(2)
        if sc1.button("🔁 Run safe sync now", disabled=not ss.resy_back):
            sync(ss.resy, ss.ops, TABLES)
            ss.sync_runs += 1
            st.rerun()
        with sc2.expander("No write API? Assisted entry checklist"):
            for line in assisted_entry_checklist(ss.ops) or ["Nothing to enter."]:
                st.checkbox(line, key=f"chk_{line}")
        conflicts = [o for o in ss.ops if o["status"] == "conflict"]
        for o in conflicts:
            st.error(f"⚠️ {o['name']}: {o['result']}")
        if ss.sync_runs:
            st.caption(f"Sync runs: {ss.sync_runs}")
    else:
        st.info("No changes yet. Cancellations and new bookings made during the outage appear here.")

    st.subheader("B · Pull from Resy (differences for the host)")
    if not ss.resy_back:
        st.info("Resy is still down. Set the sidebar to 'Back online' to reconcile.")
    elif not ss.book:
        st.info("Rebuild the book first.")
    else:
        rows = reconcile(ss.book, ss.resy.list_bookings())
        if not rows:
            st.success("✅ Backup book and Resy match.")
        else:
            st.write(f"**{len(rows)} differences.** A human approves each change.")
            df = pd.DataFrame(rows)
            df.insert(0, "approve", True)
            edited = st.data_editor(df, hide_index=True, width="stretch",
                                    disabled=[c for c in df.columns if c != "approve"])
            if st.button("Apply approved changes", type="primary"):
                n = apply_reconciliation(ss.book, ss.resy.list_bookings(), edited[edited.approve].to_dict("records"))
                assign_tables(ss.book, TABLES)
                st.success(f"Applied {n} changes.")
                st.rerun()
