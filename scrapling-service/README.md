# scrapling-service (STEP S1 stretch)

Minimal fetch sidecar: Scrapling's plain HTTP fetcher + its browser
fetcher for JS rendering. **No stealth, no challenge solving, no
fingerprint spoofing, no proxy rotation** — a 403/429/challenge is
`blocked`, never worked around.

## Install (logged 2026-10-03)

- Python **3.13.7** (`requires-python: >=3.10` per Scrapling 0.4.15 metadata).
- `python -m venv venv && venv/Scripts/python -m pip install -r requirements.txt`
  (pinned: `scrapling==0.4.15`, `fastapi`, `uvicorn[standard]`, `httpx`,
  plus `curl_cffi`, `playwright`/`patchright`, `browserforge`, `msgspec` —
  all required at import time but missing from Scrapling's own metadata).
- No browser download was needed (a compatible Chromium was already present).

## Run

The Node supervisor starts this (`python app.py`, port **4318**,
`SCRAPLING_TOKEN` per boot). Manual:

```bash
SCRAPLING_TOKEN=dev venv/Scripts/python app.py
curl -H "X-Internal-Token: dev" localhost:4318/health
```

## API

- `GET /health` → `{"ok": true}` (token required, like every route).
- `POST /fetch {url, mode, wait_for?, timeout_ms, max_bytes}` →
  `{"status":"ok","url","mode_used","html","truncated","took_ms"}` or
  `{"status":"blocked"|"error","reason"}`. `mode: "stealth"` → 400.

Guards: http/https only · SSRF block (literal denylist + every resolved
IP must be public, re-checked after each redirect, max 3) · robots.txt
(fail-open, cached 1h) · ≥1s per domain · 2 browser pages max · 2MB cap ·
HTML only · `auto` escalates once to the browser when the page has
scripts but almost no text. Bodies are never logged.

`SCRAPLING_ALLOW_IPS` (comma IPs) punches test-only holes for fixture
servers — **never set it in production**.
