# Backup Host: workflow

Resy goes down at 2 PM and service starts at 5:30. Backup Host has 3 modes and 1 inbound flow. The manager changes the mode; the system can alert, but it never changes the mode by itself. Every write goes through the tools API, and a human decides every conflict.

## Overview

```mermaid
flowchart LR
    A[Resy emails] --> AG
    B[Morning printout] --> AG
    C[Voicemails] --> AG
    AG[Backup Host agent<br/>Claude extracts, code decides] --> D[Tonight's book<br/>tables and conflicts]
    AG --> E[Confirm guests<br/>SMS, staff call list]
    AG --> F[Safe sync<br/>cancel, modify, create]
    F --> G[Resy back online<br/>0 double bookings]
```

## Normal mode (always on)

```mermaid
flowchart LR
    N1[Resy email arrives] --> N2[Parse<br/>templates, then Claude]
    N2 --> N3[Upsert booking<br/>dedupe, version check]
    N3 --> N4[Mirror to Sheet<br/>warm copy of the book]
    N4 --> N5{No Resy email<br/>for 45 min?}
    N5 -- yes --> N6[SMS alert to manager<br/>mode does not change]
```

## Outage mode (Resy is down)

```mermaid
flowchart LR
    O1[Manager taps<br/>Resy is down] --> O2[Rebuild book<br/>inbox backfill, flag low confidence]
    S[Staff add bookings<br/>printout, iPad] --> O2
    O2 --> O3[Call queue<br/>time, party size, VIP]
    O3 --> O4[AI calls guest<br/>discloses AI and recording]
    O4 --> O5{Guest answers?}
    O5 -- yes --> O6[Act through tools<br/>confirm, cancel, modify]
    O5 -- no --> O7[Voicemail + SMS<br/>no booking details]
    O7 -- retry once, +45 min --> O4
    O6 --> O8[Booking store + Sheet<br/>under 5 s]
    O6 -- complaint, allergy, 8+, VIP --> O9[Transfer to host]
```

Guardrails: pending bookings hold their tables, and a human edit always wins over an agent write.

## Inbound calls (Flow D)

```mermaid
flowchart LR
    I1[Guest calls back] --> I2[Agent answers<br/>if host is busy, 3 rings]
    I2 --> I3[Find booking<br/>by caller ID]
    I3 --> I4[Confirm name<br/>before any details]
    I4 --> I5[Same tools,<br/>same rules as outbound]
```

## Recovery mode (Resy is back)

```mermaid
flowchart LR
    R1[Manager taps<br/>Resy is back] --> R2[Block outage slots<br/>in Resy first]
    R2 --> R3[Checklist in order<br/>cancel, modify, create]
    R3 --> R4[Fresh check<br/>newest Resy data]
    R4 --> R5{Resy changed it?}
    R5 -- no --> R6[Enter in Resy<br/>with ref code BH-xxxx]
    R5 -- yes --> R7[Mismatch<br/>manager decides]
    R6 --> R8[Auto-tick<br/>on matching Resy email]
    R8 --> R9[Win-back<br/>manager approves, SMS first]
```

## The race that the safe sync stops

| Time | Event |
| --- | --- |
| 6:58 PM | Resy comes back online. |
| 6:58 PM | A web guest books the last 4-top at 7:00 PM. |
| 6:59 PM | Sync tries to add Leila Ahmadi (4 at 7:00 PM), booked by phone during the outage. |
| 6:59 PM | Conflict, not a double booking. The host offers Leila 8:30 PM. |

Code: `sync.py` (op log, cancels first, check-then-write, idempotency keys, verify). Full spec: `PRD_Resy_Outage_Agent_v2.md`.
