# Backup Host - Resy outage agent

When Resy goes down, Backup Host rebuilds tonight's book from other sources,
confirms guests by SMS, takes new bookings, and reconciles with Resy when it returns.

## Run (2 minutes)

```bash
pip install streamlit pandas          # required
pip install anthropic twilio          # optional
export ANTHROPIC_API_KEY=...          # optional: Claude extraction (else regex rules)
streamlit run app.py
```

Optional Twilio for real SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
With no keys, the app runs fully offline (rule extraction + mock SMS outbox).

## Files

| File | Owner | Content |
|---|---|---|
| `mock_data.py` | Demo owner | 16 Resy emails, morning printout, 2 voicemails, table map, Resy book after outage |
| `extract.py` | Builder A | Claude API extraction to JSON, with regex fallback |
| `core.py` | Lead | Merge and dedupe, table assignment, slot finder, SMS, reply parser, reconciliation, snapshots |
| `app.py` | Builder B | Streamlit UI with 5 tabs |

## Demo script (2 minutes)

1. "It is 2 PM. Resy is down. Service starts at 5:30."
2. **Tab 1:** Click *Rebuild book*. 23 records from 3 sources become 17 unique bookings.
   One cancellation and one change are applied. The duplicate email is removed.
3. **Tab 2:** Availability grid. 2 conflicts (Aisha, party of 6 at 8 PM; Liam, party of 5 at 8:30).
   2 low-confidence bookings from voicemail only. The host decides.
4. **Tab 3:** *Send confirmation SMS*, then *Simulate replies*. Show the call list for guests who did not reply.
5. **Tab 4:** A new guest calls. The agent finds a slot, keeps the walk-in buffer, and sends a read-back SMS.
6. **Sidebar:** Set Resy to *Back online*. **Tab 5:** 4+ differences
   (Ben Carter only in Resy, Hannah cancelled in Resy, Tom Becker time changed, Rachel Moore not in Resy,
   plus new pending bookings). A human approves each change.
7. "With prevention mode (snapshot every 15 minutes), the next outage has zero impact."

## Tradeoffs to say

- Email rebuild is fast, but bookings made after the last email can be missing. We show confidence and keep a buffer.
- SMS is cheap and fast. Guests who do not reply go to a staff call list.
- New bookings during the outage are "pending" until reconciliation, to prevent double bookings.
- The agent never decides conflicts. A human approves.

## More

- `docs/PRD_Resy_Outage_Agent_v2.md` - product requirements (with review additions marked [Added])
- `docs/site.html` - project page with a 5-step interactive demo (open in a browser)
- `sync.py` - safe re-injection into Resy: op log, cancels first, check-then-write, idempotency keys, verify
