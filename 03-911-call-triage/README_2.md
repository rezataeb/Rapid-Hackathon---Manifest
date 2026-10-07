# 911 Call Triage

**Challenge 3: 911 call management.** After an incident, call volumes spike. Develop a way to identify duplicate reports and flag high-priority cases for immediate response.

**Surge Triage Console** replays 32 calls from a simulated warehouse explosion on Harmon St. Each call is matched against open incidents, folded in when it is a duplicate, and the incident queue is re-ranked so the most urgent cases stay on top. In the replay, 32 calls collapse into 9 incidents.

## Run it

No install. Open `index.html` in a browser, or serve the folder:

```bash
cd 03-911-call-triage
python3 -m http.server 8000   # then open http://localhost:8000
```

Controls: pause/play, playback speed, step one call at a time, restart. Use **Inject a test call** to try your own transcripts; enter `555-0141` as the number to test the callback rule. Tap **Why this rank** on any incident for the full score breakdown.

## How duplicates are found

Each new call gets a match score from 0 to 1 against every incident:

| Signal | Weight |
| --- | --- |
| Distance to the incident's nearest call (full at ≤60 m, zero at ≥500 m) | 0.35 |
| Same incident type (related types such as fire/gas get partial credit) | 0.30 |
| Shared words in transcript and address (Jaccard similarity) | 0.20 |
| Time since the incident's last call | 0.15 |
| Same callback number as an earlier caller | +0.35 |

- **≥ 0.65**: merged into that incident as a duplicate.
- **0.53–0.65**: opened as its own incident but flagged *possible duplicate*, with Merge / Keep separate buttons for the dispatcher.
- **Below**: new incident.

No call is ever silently dropped.

## How priority is set

Score = incident-type base + points for every risk flag heard on any of its calls + a corroboration bonus for multiple callers (up to +15).

| Flag | Points |
| --- | --- |
| Not breathing / CPR | 50 |
| Weapon | 35 |
| Trapped | 30 |
| Cardiac symptoms | 30 |
| Unconscious | 25 |
| Serious injury | 20 |
| Children at risk, Spreading, Exposure symptoms, Explosion | 15 |
| Elderly | 5 |

**70+** P1 Immediate, **45–69** P2 Urgent, below 45 P3 Routine.

## What the demo shows

- A duplicate that adds new information escalates the incident instead of being absorbed. When a callback reports "workers trapped inside," the warehouse incident jumps in score.
- An unrelated cardiac arrest on Linden Ave arrives mid-surge and still lands at P1 instead of being buried.
- A gas-leak report near the blast is flagged for review rather than auto-merged, because it could be a separate hazard.

## Next steps for a real deployment

Swap the keyword rules for speech-to-text plus an NLP classifier, geocode caller location from ANI/ALI or device location, and feed the ranked queue into CAD. The match → merge → re-rank structure stays the same.

Single self-contained file (`index.html`), plain JavaScript, no dependencies beyond Google Fonts.
