"""Mock data for the demo: Resy emails, morning printout, voicemails, table map,
and the 'true' Resy book that returns after the outage (for reconciliation)."""

RESTAURANT = "Trattoria Demo"

# ---------------------------------------------------------------------------
# Table map: id -> seats
# ---------------------------------------------------------------------------
TABLES = (
    [{"id": f"T{i}", "seats": 2} for i in range(1, 5)]      # T1-T4: 2-tops
    + [{"id": f"T{i}", "seats": 4} for i in range(5, 10)]   # T5-T9: 4-tops
    + [{"id": "T10", "seats": 6}, {"id": "T11", "seats": 6}, {"id": "T12", "seats": 8}]
)

# ---------------------------------------------------------------------------
# Resy notification emails found in the restaurant inbox (3 formats)
# ---------------------------------------------------------------------------
_NEW = """From: Resy <notifications@resy.com>
Subject: New reservation: {name}, party of {party}
Received: {recv}

{name} booked a table.
Party size: {party}
When: Wednesday, October 7, {t12}
Phone: {phone}
Special request: {notes}"""

_CANCEL = """From: Resy <notifications@resy.com>
Subject: Cancellation: {name}
Received: {recv}

{name} cancelled the reservation for {party} at {t12}.
Phone: {phone}"""

_CHANGE = """From: Resy <notifications@resy.com>
Subject: Reservation updated: {name}
Received: {recv}

{name} changed the reservation.
New party size: {party}
New time: {t12}
Phone: {phone}"""

_email_rows = [
    # template, name, party, time12, phone, notes, received
    (_NEW, "Maria Lopez", 4, "7:00 PM", "(212) 555-0142", "Anniversary", "2026-10-07 09:12"),
    (_NEW, "James Chen", 2, "5:30 PM", "(917) 555-0110", "", "2026-10-07 09:40"),
    (_NEW, "Aisha Rahman", 6, "8:00 PM", "(646) 555-0123", "Needs a high chair", "2026-10-07 10:05"),
    (_NEW, "Sofia Rossi", 4, "6:30 PM", "(347) 555-0188", "", "2026-10-07 10:21"),
    (_NEW, "Liam O'Brien", 3, "7:30 PM", "(718) 555-0134", "", "2026-10-07 10:33"),
    (_NEW, "Priya Patel", 2, "7:00 PM", "(917) 555-0156", "Window seat", "2026-10-07 10:48"),
    (_NEW, "Noah Williams", 8, "7:00 PM", "(212) 555-0191", "Birthday, 8 guests", "2026-10-07 11:02"),
    (_NEW, "Emma Davis", 2, "8:30 PM", "(646) 555-0102", "", "2026-10-07 11:15"),
    (_NEW, "Carlos Mendez", 4, "9:00 PM", "(347) 555-0165", "", "2026-10-07 11:30"),
    (_NEW, "Hannah Goldberg", 2, "9:30 PM", "(212) 555-0119", "Nut allergy", "2026-10-07 11:44"),
    (_NEW, "Fatima Nasser", 6, "7:00 PM", "(718) 555-0148", "", "2026-10-07 11:58"),
    (_NEW, "Grace Lee", 4, "7:00 PM", "(212) 555-0127", "", "2026-10-07 12:10"),
    (_NEW, "Omar Haddad", 6, "7:30 PM", "(347) 555-0181", "Business dinner", "2026-10-07 12:22"),
    (_CANCEL, "Priya Patel", 2, "7:00 PM", "(917) 555-0156", "", "2026-10-07 12:31"),
    (_CHANGE, "Liam O'Brien", 5, "8:30 PM", "(718) 555-0134", "", "2026-10-07 12:45"),
    (_NEW, "Maria Lopez", 4, "7:00 PM", "(212) 555-0142", "Anniversary", "2026-10-07 09:12"),  # duplicate email
]

EMAILS = [
    tpl.format(name=n, party=p, t12=t, phone=ph, notes=no or "None", recv=r)
    for tpl, n, p, t, ph, no, r in _email_rows
]

# ---------------------------------------------------------------------------
# Morning printout (exported at 08:00, before most emails)
# ---------------------------------------------------------------------------
PRINTOUT_CSV = """time,name,party,phone,notes
17:30,James Chen,2,917-555-0110,
17:30,Yuki Tanaka,4,917-555-0173,Regular guest
18:00,Tom Becker,2,212-555-0177,
19:00,Maria Lopez,4,212-555-0142,Anniversary
20:30,Emma Davis,2,646-555-0102,
"""
PRINTOUT_TIME = "2026-10-07 08:00"

# ---------------------------------------------------------------------------
# Voicemails left after Resy went down (transcribed)
# ---------------------------------------------------------------------------
VOICEMAILS = [
    ("2026-10-07 13:20",
     "Hi, this is Daniel Kim, my number is 646-555-0199. I booked a table for 2 at 8:30 tonight. "
     "I did not get a reminder, so I just want to check that it is still on. Thanks."),
    ("2026-10-07 13:42",
     "Hello, this is Rachel Moore, 917-555-0144. We have a reservation for 4 at 6 tonight. Please call me back."),
]

# ---------------------------------------------------------------------------
# The real Resy book when Resy comes back online (for reconciliation)
# Differences on purpose:
#  - Ben Carter booked online at 12:50; the email never arrived      -> only in Resy
#  - Hannah Goldberg cancelled at 13:05; email never arrived          -> status differs
#  - Tom Becker moved from 18:00 to 18:15 after the printout          -> time differs
#  - Rachel Moore has no Resy booking (voicemail was wrong / other venue) -> only in backup
# ---------------------------------------------------------------------------
RESY_BOOK = [
    {"name": "Maria Lopez", "phone": "212-555-0142", "party_size": 4, "time": "19:00", "status": "booked"},
    {"name": "James Chen", "phone": "917-555-0110", "party_size": 2, "time": "17:30", "status": "booked"},
    {"name": "Aisha Rahman", "phone": "646-555-0123", "party_size": 6, "time": "20:00", "status": "booked"},
    {"name": "Tom Becker", "phone": "212-555-0177", "party_size": 2, "time": "18:15", "status": "booked"},
    {"name": "Sofia Rossi", "phone": "347-555-0188", "party_size": 4, "time": "18:30", "status": "booked"},
    {"name": "Liam O'Brien", "phone": "718-555-0134", "party_size": 5, "time": "20:30", "status": "booked"},
    {"name": "Priya Patel", "phone": "917-555-0156", "party_size": 2, "time": "19:00", "status": "cancelled"},
    {"name": "Noah Williams", "phone": "212-555-0191", "party_size": 8, "time": "19:00", "status": "booked"},
    {"name": "Emma Davis", "phone": "646-555-0102", "party_size": 2, "time": "20:30", "status": "booked"},
    {"name": "Carlos Mendez", "phone": "347-555-0165", "party_size": 4, "time": "21:00", "status": "booked"},
    {"name": "Hannah Goldberg", "phone": "212-555-0119", "party_size": 2, "time": "21:30", "status": "cancelled"},
    {"name": "Yuki Tanaka", "phone": "917-555-0173", "party_size": 4, "time": "17:30", "status": "booked"},
    {"name": "Daniel Kim", "phone": "646-555-0199", "party_size": 2, "time": "20:30", "status": "booked"},
    {"name": "Fatima Nasser", "phone": "718-555-0148", "party_size": 6, "time": "19:00", "status": "booked"},
    {"name": "Grace Lee", "phone": "212-555-0127", "party_size": 4, "time": "19:00", "status": "booked"},
    {"name": "Omar Haddad", "phone": "347-555-0181", "party_size": 6, "time": "19:30", "status": "booked"},
    {"name": "Ben Carter", "phone": "212-555-0133", "party_size": 2, "time": "18:30", "status": "booked"},
]
