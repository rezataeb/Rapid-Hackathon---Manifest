"""Extract booking records from messy sources.

Uses the Claude API when ANTHROPIC_API_KEY is set; otherwise uses regex rules,
so the demo always works offline.

Record schema:
  {name, phone, party_size, time (HH:MM 24h), action (new|cancel|change),
   notes, source, received_at}
"""
import csv
import io
import json
import os
import re

MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")


def llm_available() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def parse_time(s: str) -> str | None:
    """'7:00 PM' / '8:30 tonight' / '6' -> 'HH:MM' (dinner hours assume PM)."""
    if not s:
        return None
    m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?", s)
    if not m:
        return None
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower()
    if ap.startswith("p") and h < 12:
        h += 12
    elif ap.startswith("a") and h == 12:
        h = 0
    elif not ap and h < 12:  # restaurant context: "8:30 tonight" means PM
        h += 12
    return f"{h:02d}:{mi:02d}"


def _first(pattern, text, flags=0):
    m = re.search(pattern, text, flags)
    return m.group(1).strip() if m else ""


# ---------------------------------------------------------------------------
# Rule-based extraction (offline fallback)
# ---------------------------------------------------------------------------
def _email_rules(email: str) -> dict:
    subject = _first(r"Subject:\s*(.+)", email)
    low = subject.lower()
    action = "cancel" if "cancel" in low else "change" if "updated" in low or "change" in low else "new"
    name = _first(r":\s*([^,\n]+)", subject)
    party = _first(r"(?:party of|Party size:|New party size:|reservation for)\s*(\d+)", email, re.I)
    t12 = _first(r"(\d{1,2}:\d{2}\s*[AP]M)", email)
    notes = _first(r"Special request:\s*(.+)", email)
    return {
        "name": name,
        "phone": _first(r"Phone:\s*([\d\-\(\) \+]+)", email),
        "party_size": int(party) if party else None,
        "time": parse_time(t12),
        "action": action,
        "notes": "" if notes.lower() == "none" else notes,
        "source": "email",
        "received_at": _first(r"Received:\s*(.+)", email),
    }


def _voicemail_rules(received_at: str, text: str) -> dict:
    party = _first(r"(?:for|party of)\s*(\d+)", text, re.I)
    t = _first(r"at\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)", text, re.I)
    return {
        "name": _first(r"this is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z']+)+)", text),
        "phone": _first(r"(\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4})", text),
        "party_size": int(party) if party else None,
        "time": parse_time(t),
        "action": "new",
        "notes": "Guest left voicemail - verify",
        "source": "voicemail",
        "received_at": received_at,
    }


# ---------------------------------------------------------------------------
# LLM extraction
# ---------------------------------------------------------------------------
_PROMPT = """You extract restaurant reservation records from raw text.
Return ONLY a JSON array. One object per message, with these keys:
name (string), phone (string), party_size (integer or null),
time (24h "HH:MM" or null; dinner times without AM/PM are PM),
action ("new" | "cancel" | "change"), notes (string), received_at (string as given).
Do not invent data. Use null when a value is missing.

Source type: {source}
Messages (separated by =====):
{text}"""


def _llm_extract(chunks: list[str], source: str) -> list[dict]:
    import anthropic  # imported here so the offline mode needs no package

    client = anthropic.Anthropic()
    msg = client.messages.create(
        model=MODEL,
        max_tokens=4000,
        messages=[{"role": "user", "content": _PROMPT.format(source=source, text="\n=====\n".join(chunks))}],
    )
    raw = msg.content[0].text.strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
    records = json.loads(raw)
    for r in records:
        r["source"] = source
        r["time"] = parse_time(r.get("time") or "") if r.get("time") else None
    return records


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def extract_emails(emails: list[str], use_llm: bool = True) -> tuple[list[dict], str]:
    if use_llm and llm_available():
        try:
            return _llm_extract(emails, "email"), "Claude API"
        except Exception as e:  # never break the demo
            print("LLM extraction failed, using rules:", e)
    return [_email_rules(e) for e in emails], "rules"


def extract_voicemails(voicemails: list[tuple[str, str]], use_llm: bool = True) -> tuple[list[dict], str]:
    if use_llm and llm_available():
        try:
            chunks = [f"Received: {ts}\n{txt}" for ts, txt in voicemails]
            return _llm_extract(chunks, "voicemail"), "Claude API"
        except Exception as e:
            print("LLM extraction failed, using rules:", e)
    return [_voicemail_rules(ts, txt) for ts, txt in voicemails], "rules"


def extract_printout(csv_text: str, received_at: str) -> list[dict]:
    rows = csv.DictReader(io.StringIO(csv_text))
    return [
        {
            "name": r["name"].strip(),
            "phone": r["phone"].strip(),
            "party_size": int(r["party"]),
            "time": r["time"].strip(),
            "action": "new",
            "notes": (r.get("notes") or "").strip(),
            "source": "printout",
            "received_at": received_at,
        }
        for r in rows
    ]
