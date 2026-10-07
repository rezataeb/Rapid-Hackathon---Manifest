# Way Home: parade-night route planner

**Problem 2.** The Knicks win the championship and crowds fill the streets. Can official alerts, social media updates, and public reports map street closures and plan routes home?

**Idea.** An AI agent merges official alerts (511NY, MTA, NYC DOT, Notify NYC), media, and public reports into one live closure map. Code sets each closure's status:

- **Confirmed:** an official source
- **Likely:** 3 or more independent public reports
- **Unverified:** everything else (hidden by default)

A router then gives each person 2 routes home that avoid every confirmed and likely closure.

Status: PRD written, code to come.
