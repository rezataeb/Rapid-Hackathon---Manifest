# PRD: Way Home — parade-night route planner

Oct 7, 2026


## Summary and goals


On a Knicks championship night, crowds fill the streets and blocks close with little warning. Way Home merges official alerts, media, and public reports into one live closure map, then gives each person two routes home that stay off every closure the evidence supports.


An agent reads messy text and turns it into structured claims. **Code sets each closure's status.** The model never promotes a rumor to a closure the router must avoid.


**Problem.** People leaving the parade cannot tell which streets, sidewalks, and transit lines are actually closed. Official alerts, news, and social posts disagree, arrive late, and describe the same block in different words. A normal map still draws a line through a closed street.


**Idea.** One live map. Three statuses:


| Status | Rule | On the map | Router |
| --- | --- | --- | --- |
| **Confirmed** | At least one official source | Shown | Avoid |
| **Likely** | 3 or more independent public reports, and no official source | Shown | Avoid |
| **Unverified** | Everything else | Hidden by default | Do not avoid |


Official sources are **511NY, MTA, NYC DOT, and Notify NYC**. Media and citizen reports are public reports. They never set Confirmed on their own.


**Goals**


1. Show one map of tonight's closures, each with a status set by the rules above.
2. Hide Unverified closures until the person asks to see them.
3. Return 2 routes from "where I am" to "home" that avoid every Confirmed and Likely closure active at departure time.
4. Say so when a second route, or any route, does not exist. Never draw a path across a Confirmed or Likely closure to fill the quota.
5. Update the map and the routes when a new alert or report arrives, without a person reclassifying by hand.


**Non-goals**


- A general navigator for ordinary nights.
- Predicting crowd density, police lines, or "it feels packed."
- Treating a news article or a social post as an official source.
- Writing back to 511NY, MTA, DOT, or Notify NYC.
- Emergency dispatch, or advice to enter a closed area.
- Accounts, social graphs, or citywide coverage beyond the parade corridor in v1.


**Success metrics**


| Metric | Target | Measured from |
| --- | --- | --- |
| Status matches the rule on a labeled fixture set | 100% | Status engine tests |
| Routes that cross a Confirmed or Likely edge | 0 | Router tests |
| Unverified closures visible on first load | 0 | Map default |
| Time from a new official alert (fixture or feed) to map update | ≤ 60 s | Event log |
| Independent reports required before Likely | Exactly 3 | Status engine tests |
| Second route shares edges with the first | ≤ 70% of the shorter route | Router tests |


## Users and flows


| User | Needs | Touchpoint |
| --- | --- | --- |
| Person going home | A map they can trust, and 2 ways out | Map and route cards |
| Operator (demo / desk) | See why a closure is Confirmed or Likely, and replay the night | Evidence drawer, fixture clock |
| Coding agent | Unambiguous spec to build from | This document |


**Flow A: Ingest (always on during the event)**


1. Adapters pull official alerts, media items, and public reports.
2. The extractor turns each item into one or more claims: where, when, what is closed, who said it, and whether the source is official.
3. The matcher attaches each claim to street or transit edges.
4. The status engine clusters claims that describe the same closure and sets Confirmed, Likely, or Unverified.
5. The map refreshes. Routes already on screen recompute if a newly avoided edge sits on them.


**Flow B: Way home**


1. The person drops a start pin (or allows location) and enters a home address. Departure time defaults to now.
2. The router loads every Confirmed and Likely closure whose window covers that departure time. Unverified closures stay out of the avoid set.
3. The router returns up to 2 routes that do not use those edges, with the second route meaningfully different from the first.
4. Each route card lists the closures it goes around, the ETA, and the mix of walking and transit.
5. If only one safe route exists, the screen shows that route and "No second route avoids the closures." If none exist, the screen lists the closures that block every path and does not draw a line through them.


**Flow C: A closure changes**


1. A new official "reopened" alert arrives for a Confirmed closure. Code clears it. The router may use those edges again.
2. A third independent public report lands on an Unverified cluster. Code flips it to Likely. The map shows it, and any route using those edges is replaced.
3. The same account posts twice about the same block. The second post does not increase the independent count.


## Functional requirements


Requirement IDs (FR-x.y) are referenced by the acceptance criteria in Section 7. "Must" means v1 scope.


### 3.1 Sources and ingestion


- **FR-1.1** Must ingest four source classes through adapters behind one `SourceAdapter` interface:
  - **Official:** 511NY events, MTA service alerts, NYC DOT street closures, Notify NYC messages.
  - **Media:** news articles and outlet posts.
  - **Public:** social posts and citizen reports.
- **FR-1.2** Must tag each raw item `official`, `media`, or `public` from the adapter, not from model judgment. A news story that quotes DOT is still `media`.
- **FR-1.3** Must store the raw item (text, url, source id, published time) for the event window so a claim can be audited.
- **FR-1.4** Must be idempotent: the same source id updates the existing item and does not create a second claim that counts as a new reporter.
- **FR-1.5** v1 may run on fixture files shaped like those four official feeds plus sample media and public posts. Live HTTP adapters are the same interface and are not required for the demo.


### 3.2 Extraction


- **FR-2.1** Must turn each item into claims with: street or line name, from, to (or a point), mode (`street` / `sidewalk` / `transit`), start, end, reporter key, source class, and the raw item id.
- **FR-2.2** Must extract with a two-stage parser: (a) deterministic patterns for known alert layouts; (b) LLM structured output with a JSON schema when patterns fail. Each claim carries a confidence score. Claims under 0.8 are stored and shown in the evidence drawer, and they do not count toward Likely and do not create a Confirmed closure.
- **FR-2.3** Must normalize phones and account ids into a stable `reporter_key`. Official items use the agency plus the alert id as the reporter key. Media items use the outlet domain.
- **FR-2.4** The model returns claims only. It does not return a status.


### 3.3 Matching and clustering


- **FR-3.1** Must map each claim onto edges of a street-and-transit graph for the parade corridor. A span ("Broadway from 14th to 34th") covers every edge in that span. A single intersection covers the edges that meet there.
- **FR-3.2** Must cluster claims that share at least one edge and overlap in time, or fall within 30 minutes of each other, into one closure.
- **FR-3.3** Must keep a closure's edge set equal to the edges its counting claims agree on. An official span defines the edges when status is Confirmed.


### 3.4 Status engine


Code applies these rules in order. The first match wins.


1. If the cluster contains an official claim that says **closed**, status is **Confirmed**. The time window is the official window. A later official claim that says **open** removes the closure (status `cleared`, off the map, off the avoid set).
2. Else if the cluster has **3 or more distinct `reporter_key` values** among media and public claims that passed the confidence bar, status is **Likely**. The time window is the span from the earliest start to the latest end among those reports.
3. Else status is **Unverified**.


- **FR-4.1** Must implement the three rules above with no model call in the status function.
- **FR-4.2** Must count a reporter once per closure. Replies, reposts, and a second post from the same key do not increment the count.
- **FR-4.3** Must let one official claim outweigh any number of public "it's open" reports. Official open is the only clear event (rule 1).
- **FR-4.4** Must recompute status on every new or updated claim.
- **FR-4.5** A closure with no end time is treated as active until an official open claim or until 6 hours after its start, whichever comes first.


### 3.5 Map


- **FR-5.1** Must show Confirmed and Likely closures on load. Unverified closures are hidden until the person turns on "Show unverified."
- **FR-5.2** Must color the three statuses differently and label each closure with status, street or line, time window, and evidence count (official agencies, or "4 independent reports").
- **FR-5.3** Must open an evidence drawer: every claim, its source class, reporter key (masked for people: last 4 of a phone, or @handle), time, and extracted span. The drawer shows the rule that fired ("Confirmed: NYC DOT alert 8841" or "Likely: 3 independent reports").


### 3.6 Routing


- **FR-6.1** Must take a start point, a home point, and a departure time. Geocode home to the nearest graph node in the corridor. If either point falls outside the graph, say so and do not invent a citywide path.
- **FR-6.2** Must build the avoid set from edges that belong to a Confirmed or Likely closure whose window covers the departure time. Unverified edges are not in the avoid set.
- **FR-6.3** Must return 2 routes that use none of those edges. The second route shares at most 70% of its edges with the first (measured on the shorter route). Order them by travel time, walking plus transit.
- **FR-6.4** If only one such route exists, return one route and a clear "no second route" reason. If none exist, return zero routes and the list of closures that block the graph. The response must not include a polyline that touches an avoided edge.
- **FR-6.5** Must recompute the two routes when the avoid set changes and a shown route now touches a new avoided edge.
- **FR-6.6** Each route shows ETA, a short step list, and the names of the closures it avoids.


### 3.7 Operator clock (demo)


- **FR-7.1** Must be able to replay a fixture timeline: ingest items in published-time order so a reviewer can watch Unverified become Likely at the third report, and Confirmed appear from a single DOT alert.
- **FR-7.2** Must expose a "as of" time so routing uses the closures active then, not wall-clock now.


## Architecture and data model


The status engine and the router are plain functions over structured claims. The model is only the extractor fallback.


```text
Fixtures or live feeds
  -> SourceAdapter (official | media | public)
  -> Extractor (patterns, then LLM schema)
  -> Matcher (claims to graph edges)
  -> Status engine (Confirmed | Likely | Unverified | cleared)
  -> Map
  -> Router (2 routes, avoid Confirmed + Likely)
```


### Recommended stack


| Layer | Choice | Why |
| --- | --- | --- |
| Graph | A hand-built corridor graph (intersections and a few subway links) in JSON | A 45-minute build cannot load the full NYC network. The interface is an edge list, so a larger graph can replace the file later. |
| Status and routing | Python | Same language as project 1. Routing is a short-path search with an edge penalty for the second route. |
| Extraction fallback | Claude structured output | Only when an alert or post misses the patterns. |
| UI | A single web page: map, toggle, two route cards, evidence drawer | Enough to show the rules. |
| Feeds | JSON fixtures for 511NY, MTA, NYC DOT, Notify NYC, media, and public posts | Live keys are optional behind `SourceAdapter`. |


### Data model


| Entity | Key fields |
| --- | --- |
| `raw_items` | id, source (`511ny` / `mta` / `dot` / `notify_nyc` / `media` / `public`), source_class (`official` / `media` / `public`), external_id, published_at, text, url |
| `claims` | id, raw_item_id, street_or_line, from_label, to_label, mode, starts_at, ends_at, reporter_key, confidence, says (`closed` / `open`), edge_ids |
| `closures` | id, status (`confirmed` / `likely` / `unverified` / `cleared`), edge_ids, starts_at, ends_at, evidence_count, rule (`official` / `three_reports` / `default`), claim_ids |
| `routes` | id, start, home, depart_at, rank (1 or 2), edge_ids, eta_min, avoided_closure_ids, note |


### Status function (normative)


```text
count = number of distinct reporter_key on claims
        where source_class in (media, public)
        and says = closed
        and confidence >= 0.8

if any claim is official and says = open and is the latest official claim:
    status = cleared
else if any claim is official and says = closed:
    status = confirmed
else if count >= 3:
    status = likely
else:
    status = unverified
```


## 7. Acceptance criteria


Each criterion is a test. "Given" is the setup, "Then" is the expected result.


| ID | Covers | Given | Then |
| --- | --- | --- | --- |
| AC-1 | FR-4.1 | One NYC DOT alert: Broadway closed from 14th to 34th, 4 pm–10 pm | Status Confirmed; those edges avoided; map shows it; evidence reads the DOT alert |
| AC-2 | FR-4.2 | Two posts from @fan1 and one from @fan2 on the same block | Status stays Unverified (2 reporters). A third key flips it to Likely |
| AC-3 | FR-4.2 | @fan1 posts three times, no one else | Status stays Unverified; evidence count is 1 |
| AC-4 | FR-1.2, FR-4.1 | A news article says "DOT has closed 7th Ave" and no DOT alert is in the feed | Status is not Confirmed. The article counts as one public report |
| AC-5 | FR-4.3 | Confirmed by 511NY; five public posts say the street is open; no official open alert | Status stays Confirmed |
| AC-6 | FR-4.3, rule 1 | Confirmed by DOT; a later DOT alert says open | Status cleared; edges return to the router |
| AC-7 | FR-5.1 | A mix of Confirmed, Likely, and Unverified | First load shows only Confirmed and Likely. The toggle reveals Unverified |
| AC-8 | FR-6.3, FR-6.4 | Start and home with two disjoint paths around a Confirmed corridor | 2 routes; neither uses a Confirmed or Likely edge; shared edges ≤ 70% of the shorter route |
| AC-9 | FR-6.4 | Every path home crosses a Likely closure | 0 routes; the response names that closure; no polyline crosses it |
| AC-10 | FR-6.2 | An Unverified report on the fastest path, and a Confirmed closure elsewhere | The route may use the unverified block and must not use the confirmed block |
| AC-11 | FR-2.2, FR-2.4 | A post the pattern parser cannot read; the model returns a claim and also the word "confirmed" | Stored claim only. Status still follows Section 3.4. Confidence under 0.8 does not count |
| AC-12 | FR-7.1 | Fixture clock steps through reports 1, 2, then 3 | Map is empty of that closure, then still hidden (Unverified), then shows Likely on the third distinct report |


## 8. Open questions


| ID | Question | Needed by |
| --- | --- | --- |
| Q1 | Parade corridor bounds for v1 (which avenues and which subway lines are in the graph) | Before the graph file is drawn |
| Q2 | Does a sidewalk closure block a walking route when the roadway is still open, and the reverse | Before routing weights are set |
| Q3 | Live adapters: which of 511NY, MTA, DOT, Notify NYC we can call without a key during the hackathon | After the fixture demo works |


## Appendix A: Hackathon demo scope


Problem 2 is a 45-minute build. Ship the loop below. The live city APIs stay behind the adapter.


| PRD part | In the demo | How |
| --- | --- | --- |
| Fixtures for official, media, and public items (FR-1) | Yes | JSON files, replayed by the operator clock |
| Pattern extractor plus one LLM fallback (FR-2) | Yes | Known alert strings in code; Claude only for a free-text post |
| Status engine (FR-4) | Yes | The normative function, with AC-1 through AC-6 as tests |
| Map with hidden Unverified (FR-5) | Yes | Corridor schematic is enough; a full basemap is optional |
| Two routes that refuse closed edges (FR-6) | Yes | Small graph, two paths home, one blocked case |
| Live 511NY / MTA / DOT / Notify NYC | No | Same adapter interface, not wired |
