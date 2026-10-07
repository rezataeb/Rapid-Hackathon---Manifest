# PRD: 911 Call Triage — duplicate removal

Oct 7, 2026


## Summary and goals


After a major incident, many people report the same event in different words, from slightly different places, a few minutes apart. The active queue must show one incident. Duplicate reports are removed from that queue as they arrive.


**Problem.** Call volume spikes. Dispatchers see twenty versions of one fire and can miss the separate emergency next door. Exact text or address match does not catch these duplicates.


**Idea.** Every incoming report is compared with incidents already on the queue. Code decides. A strong match is removed from the queue and stored under the surviving incident. A weak match opens a new incident. A middle score waits in a review queue and is not removed.


The active queue is a list of incidents, never a list of raw reports. A removed report is still on the incident (wording, place, time, channel) so the card can show how many people reported it. Removal means it is not its own card and nobody has to clear it by hand.


**Rules**


| Result | When | Active queue |
| --- | --- | --- |
| **Removed** | Best matching incident scores ≥ 0.72, and no other incident is within 0.05 of that score | Report is attached to that incident and disappears as its own item |
| **Review** | Best score is ≥ 0.45 and < 0.72, or the top two incidents are within 0.05 | Report stays in the review queue until a person attaches it or makes it its own incident |
| **New incident** | No candidate, or best score < 0.45 | A new incident card appears. This report is its lead |


Candidate incidents are those whose latest report is within 20 minutes and, when both sides have coordinates, whose centroid is within 250 meters. The score is `0.45 * wording + 0.35 * place + 0.20 * time`. Wording is Jaccard overlap of significant tokens. Place is `1 - min(distance_m / 250, 1)`. Time is `1 - min(delta_minutes / 20, 1)`.


A report with no coordinates is removed only when its place name matches the incident and its wording score alone is ≥ 0.80. Otherwise it goes to review.


The same reporter key updates the report already stored. It does not create a second card and does not increase the people-count.


Priority is separate. Life-safety language sets **High** on a single report. Ten or more distinct reporters can raise **Medium** to **High**. Attaching a milder duplicate never lowers **High**.


**Goals**


1. Remove duplicate reports from the active queue at the moment the score crosses 0.72.
2. Leave one incident card for a spike of many wordings of the same event.
3. Keep a nearby, differently worded emergency as its own incident.
4. Hold ambiguous reports for a person, including a report with no coordinates and a weak place match.
5. Run the same removal function on a scripted demo and on live NYC 311 reports.


**Non-goals**


- A connection to live 911 audio, NYPD/FDNY/EMS CAD, or unit dispatch.
- Storing phone numbers. Reporter identity is an opaque key.
- Letting a model change the 0.72 / 0.45 cutoffs or the priority level.
- Citywide prediction, crowd density, or a public "what is happening" map as the primary screen.


**Success metrics**


| Metric | Target | Measured from |
| --- | --- | --- |
| Demo fire reports left as their own cards | 0 (one incident) | Fixture test |
| Demo medical emergency attached to the fire | 0 | Fixture test |
| Demo report with no coordinates and a vague place | Review, not removed | Fixture test |
| Second message from the same reporter key | Updates one report; people-count unchanged | Fixture test |
| High incident lowered by a milder duplicate | 0 | Priority tests |
| Removal decision that differs from the normative function | 0 | Cluster tests |


## Users and flows


| User | Needs | Touchpoint |
| --- | --- | --- |
| Supervisor | One card per real incident, duplicates already gone, a short review list | Active queue, review queue, incident drawer |
| Coding agent | Unambiguous removal rule to build and test | This document |


**Flow A: A report arrives**


1. The adapter writes one report: channel, time, text, coordinates or a place name, opaque reporter key, source id.
2. If that reporter key already sits on an open incident, the stored report is updated and priority is recomputed. Stop.
3. Otherwise the cluster function scores candidate incidents with the normative function below.
4. **Removed:** the report is attached, the centroid and priority are recomputed, and the active queue still shows one card.
5. **Review:** the report appears only in the review queue, with the suggested incident beside it.
6. **New incident:** a card is added. Its priority is set from this report alone.


**Flow B: The supervisor checks an incident**


1. The card shows the lead text (earliest report), the best location, the priority, the agency label, the people-count, and the channels.
2. The drawer lists every attached report, including those removed from the queue, and the score that removed each one.
3. The supervisor can detach one removed report. That report becomes a new incident and returns to the active queue. The original card loses that report and is recomputed.


**Flow C: Review**


1. The supervisor attaches the report to the suggested incident. It is then removed, the same as a score ≥ 0.72.
2. Or the supervisor marks it a new incident. It leaves review and appears on the active queue.


**Flow D: Live and demo**


1. `DEMO=1` replays the fixture in time order and shows a Demo data banner.
2. With demo off, the server polls NYC 311 and shows a banner that these are public 311 reports, not 911 calls.
3. Both paths call the same cluster function.


## Functional requirements


Requirement IDs (FR-x.y) are referenced by the acceptance criteria. "Must" means v1 scope.


### 3.1 Ingestion


- **FR-1.1** Must accept reports through one report shape from two adapters: a demo fixture, and live NYC 311 (`erm2-nwe9`, complaints created in the last 3 hours).
- **FR-1.2** Demo channels are `voice`, `sms`, `kiosk`, and `crash`. Live rows use channel `311`. The channel is a label. It does not change the removal rule.
- **FR-1.3** A 311 row maps `unique_key` to the source id, `created_date` to the time, `complaint_type` plus `descriptor` to the text, `latitude`/`longitude` to coordinates, and the incident address or intersection to the place name. The reporter key is the `unique_key`, because 311 does not publish a caller id.
- **FR-1.4** Must be idempotent on source id. The same id updates the stored report and does not become a second card.
- **FR-1.5** Must keep the raw text for the session so a removal can be audited. Must not store a phone number.


### 3.2 Removal


Code applies the normative function in Section 4. No model call sits inside that function.


- **FR-2.1** Must remove a report from the active queue when the function returns **Removed**. Removal and attachment happen in the same step.
- **FR-2.2** Must compare a report only with incidents whose latest report is within 20 minutes. When both have coordinates, the incident centroid must also be within 250 meters.
- **FR-2.3** Must attach a removed report to exactly one incident: the highest score. When the top two scores differ by less than 0.05, the result is **Review**, not removal.
- **FR-2.4** Must send a report with no coordinates to **Review**, except when the place name matches an incident and the wording score alone is ≥ 0.80. That exception may remove it.
- **FR-2.5** Must treat a repeated reporter key as an update to the existing report. The distinct people-count does not rise.
- **FR-2.6** Must recompute the centroid as the mean of attached reports that have coordinates, after every removal.
- **FR-2.7** Processing reports in `received_at` order must be deterministic for a given fixture.


### 3.3 Priority


Code sets priority after every new incident, removal, update, or detach. The first matching rule wins.


1. If any attached report contains a life-safety phrase, priority is **High**.
2. Else if priority would be **Medium** and the incident has ≥ 10 distinct reporter keys, priority is **High**.
3. Else if any attached report contains a medium phrase, priority is **Medium**.
4. Else priority is **Low**.


Life-safety phrases: `not breathing`, `unconscious`, `trapped`, `shots`, `shooting`, `stabbing`, `working fire`, `building on fire`, `on fire`, `explosion`, `people inside`, `heart attack`, `cardiac`, `bleeding`.


Medium phrases: `smoke`, `crash`, `accident`, `injury`, `fight`, `assault`, `gas leak`.


Agency label, display only: fire phrases → `fire`; heart / breathing / bleeding → `ems`; shots / stabbing / fight / crash → `police`; otherwise `other`. An incident may show more than one label.


- **FR-3.1** Must implement the four rules above with no model call in the priority function.
- **FR-3.2** Must not lower a **High** incident when a later report lacks life-safety language.
- **FR-3.3** A volume bump applies only from **Medium** to **High**. A **Low** cluster stays **Low** regardless of count.


### 3.4 Queues


- **FR-4.1** The active queue lists one card per incident, highest priority first, then earliest lead time. It does not list removed reports as cards.
- **FR-4.2** Each card shows lead text, location, priority, agency labels, distinct reporter count, and channel list.
- **FR-4.3** The drawer lists every attached report with the score and the rule that removed it (`score`, `place_name`, or `same_reporter`).
- **FR-4.4** The review queue lists only reports the function marked **Review**, each with the suggested incident id and score.
- **FR-4.5** Attach from review uses the same storage path as an automatic removal. "Make new incident" creates a card and clears the suggestion.
- **FR-4.6** Detach puts that report on a new incident and recomputes the old one. A detached report is no longer removed.


### 3.5 Demo and live


- **FR-5.1** `DEMO=1` loads the fixture in Appendix A, in time order, and shows a Demo data banner on every screen.
- **FR-5.2** Live mode polls 311 on an interval of 3 minutes or less, keeps the last good copy if the request fails, and shows the 311 banner.
- **FR-5.3** The cluster function is the same code path in both modes.


## Architecture and data model


The cluster function and the priority function are plain functions over reports. A model is optional and only allowed to propose tokens or a severity hint for the drawer. It does not return Removed, Review, or a priority.


```text
Demo fixture  or  NYC 311 (erm2-nwe9)
  -> Report adapter (one report shape)
  -> Cluster function (Removed | Review | New incident)
  -> Priority function (High | Medium | Low)
  -> Active queue and review queue
```


### Recommended stack


| Layer | Choice | Why |
| --- | --- | --- |
| Cluster and priority | Plain functions with unit tests for every acceptance row | The demo is the rule, not the chrome |
| Server | Node, same shape as Way Home | `npm start` for live 311, `npm run demo` for the fixture |
| UI | One page: active queue, review queue, incident drawer | A supervisor can see that a duplicate is gone |
| Live feed | NYC Open Data 311 `erm2-nwe9` | Public, near-live, and full of real duplicate complaints. 911 audio is not public, and FDNY/EMS open data is already one row per incident |
| Scoring | Token Jaccard in code | No key required. An LLM call is out of the removal path |


### Data model


| Entity | Key fields |
| --- | --- |
| `reports` | id, source_id, channel (`voice` / `sms` / `kiosk` / `crash` / `311`), received_at, text, lat, lon, place_name, reporter_key, disposition (`lead` / `removed` / `review`), incident_id, match_score, match_rule |
| `incidents` | id, priority (`high` / `medium` / `low`), agency_labels, lead_report_id, lat, lon, opened_at, last_report_at, reporter_count |


### Cluster function (normative)


Significant tokens are the lowercase words of length ≥ 3 after punctuation is stripped, excluding: a, the, at, on, in, of, and, to, is, it, my, we, there, this, that, for, with, from.


```text
wording = |tokens(report) ∩ tokens(incident lead + attached texts)|
          / |tokens(report) ∪ tokens(incident lead + attached texts)|
          wording = 0 when the union is empty

place   = 1 - min(haversine_m(report, incident.centroid) / 250, 1)
time    = 1 - min(|received_at - incident.last_report_at| in minutes / 20, 1)

candidates = open incidents where
    |received_at - last_report_at| <= 20 minutes
    AND (report has no coordinates
         OR incident has no centroid
         OR haversine_m <= 250)

if reporter_key is already on an open incident:
    update that report
    return               # not a new removal; people-count unchanged

if report has no coordinates:
    name_hits = candidates whose place_name shares a significant token with the report
    if any name_hit has wording >= 0.80 against that incident:
        return Removed on the highest such wording
    else:
        return Review

score = 0.45 * wording + 0.35 * place + 0.20 * time
        # place uses the centroid; if the incident has no centroid yet, drop place
        # and renormalize: score = 0.69 * wording + 0.31 * time

best, second = top two candidate scores
if no candidates or best < 0.45:
    return New incident
if best >= 0.72 and (second is absent or best - second >= 0.05):
    return Removed on that incident
return Review on the best incident
```


### Priority function (normative)


```text
if any attached text contains a life-safety phrase:
    priority = high
else if any attached text contains a medium phrase:
    priority = high if distinct reporter_key count >= 10 else medium
else:
    priority = low
```


## Acceptance criteria


Each criterion is a test. The demo fixture in Appendix A is the setup for AC-1 through AC-4.


| ID | Covers | Given | Then |
| --- | --- | --- | --- |
| AC-1 | FR-2.1, FR-4.1 | The 25 demo fire reports, in time order | 1 incident on the active queue. The other 24 reports are `removed` on that incident. People-count is 25 |
| AC-2 | FR-2.2, FR-3.1 | The demo cardiac report, about 150 m from the fire, different wording | A second incident, priority High, agency `ems`. It is not attached to the fire |
| AC-3 | FR-2.4, FR-4.4 | The demo "smoke" report with no coordinates and place name "somewhere uptown" | Disposition `review`. It is not on the fire incident |
| AC-4 | FR-2.5 | A second SMS from the same reporter key as fire report 1, adding "still burning" | Still 25 people. That report's text is updated. No new card |
| AC-5 | FR-2.3 | Two incidents tied within 0.05 for one new report | Disposition `review`. The report is on neither incident |
| AC-6 | FR-3.2 | A High fire incident, then a removed report whose text is "loud party" | Priority stays High |
| AC-7 | FR-3.3 | 12 distinct reporters, text is only "loud music", no medium or life-safety phrase | Priority stays Low |
| AC-8 | FR-3.1 | 10 distinct reporters whose text includes "smoke" and "injury", and no life-safety phrase | Priority becomes High by the volume rule |
| AC-9 | FR-4.6 | AC-1, then detach one removed fire report | 2 incidents. The detached report is the lead of the new one. The original people-count is 24 |
| AC-10 | FR-1.4 | The same 311 `unique_key` delivered twice | One report, one card |
| AC-11 | FR-5.3 | One fire-like pair scored in demo mode and the same pair scored in live mode | Identical disposition and score |


## Open questions


| ID | Question | Needed by |
| --- | --- | --- |
| Q1 | Confirm the life-safety and medium phrase lists against the words the fixture will actually use | Before the fixture file is written |
| Q2 | 311 poll window stays "last 3 hours" when the city feed is delayed | After the live adapter is wired |


## Appendix A: Demo fixture


The fixture is invented. Times fall inside a 6-minute window. Fire coordinates jitter by at most 80 m around one building. Each fire report has its own reporter key and uses different wording for the same working fire (flames, people inside, building on fire). One later SMS reuses the first fire reporter key.


| Reports | Content | Required outcome |
| --- | --- | --- |
| 25 | Working fire, voice / sms / kiosk / crash mixed, GPS jitter ≤ 80 m | 1 High incident, agency `fire`, 24 removed |
| 1 | Heart attack, about 150 m away, one reporter | Own High incident, agency `ems` |
| 1 | "I think I see smoke somewhere uptown", no lat/lon | Review |


A second, smaller case sits in the same file for AC-7 and AC-8: a loud-music cluster and a smoke-and-injury cluster. They are far enough from the fire that they are not candidates.


## Appendix B: Hackathon demo scope


Ship the loop below. Live 311 and the fixture are both in v1, matching Way Home.


| PRD part | In the demo | How |
| --- | --- | --- |
| Report shape and both adapters (FR-1) | Yes | Fixture file plus one 311 fetch |
| Cluster function (FR-2) | Yes | Normative function; AC-1 through AC-5 and AC-11 as tests |
| Priority function (FR-3) | Yes | AC-2, AC-6, AC-7, AC-8 |
| Active queue, drawer, review, detach (FR-4) | Yes | One page |
| Demo banner and 311 banner (FR-5) | Yes | `npm run demo` and `npm start` |
| Model inside the removal path | No | Cutoffs stay in code |
