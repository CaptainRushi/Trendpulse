"""Scrapling-lite fetch sidecar (STEP S1 stretch).

Policy: Scrapling's plain HTTP fetcher plus its browser fetcher for
JS rendering ONLY. No stealth fetcher, no challenge solving, no
fingerprint spoofing, no proxy rotation — a 403/429/challenge is
BLOCKED, never worked around.

Single file on purpose: two routes, one guard chain. Recipes and
adaptive parsing are Day-2 work, not here.
"""
import asyncio
import hmac
import ipaddress
import logging
import os
import re
import socket
import time
import urllib.parse
import urllib.robotparser

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

TOKEN = os.environ.get("SCRAPLING_TOKEN", "")
if not TOKEN:
    raise SystemExit("SCRAPLING_TOKEN is required (Node supervisor sets it per boot)")

UA = "TrendPulse/1.0 (+local)"
MAX_BYTES = 2_000_000
DOMAIN_GAP_S = 1.0
MAX_REDIRECTS = 3
BROWSER_SLOTS = 2
ROBOTS_TTL_S = 3600.0

log = logging.getLogger("scrapling-service")

app = FastAPI()
_last_hit: dict[str, float] = {}
_robots: dict[str, tuple[float, urllib.robotparser.RobotFileParser]] = {}
_browser_sem = asyncio.Semaphore(BROWSER_SLOTS)


class FetchBody(BaseModel):
    url: str
    mode: str = "auto"  # auto | http | browser (anything else: 400)
    wait_for: str | None = None  # CSS selector, browser mode only
    timeout_ms: int = Field(default=20000, ge=1000, le=90000)
    max_bytes: int = Field(default=MAX_BYTES, ge=1024, le=MAX_BYTES)


class Blocked(Exception):
    """Fetch refused by policy — returned as status=blocked, never raised to HTTP."""


def _auth(token: str | None) -> None:
    if not token or not hmac.compare_digest(token, TOKEN):
        raise HTTPException(status_code=401, detail="bad or missing X-Internal-Token")


def _blocked_ip(ip: ipaddress._BaseAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or str(ip) == "100.100.100.200"  # Alibaba metadata; not covered by is_private
    )


def _allowlist() -> set[str]:
    """Exact-IP allowlist, TEST ONLY (local fixture servers).

    Never set in production: it punches named holes in the SSRF gate.
    Read per request so tests can scope it per sidecar process.
    """
    return {p.strip() for p in os.environ.get("SCRAPLING_ALLOW_IPS", "").split(",") if p.strip()}


def _check_host(host: str) -> None:
    """SSRF gate: literal denylist, then every resolved address must be public."""
    h = host.lower().rstrip(".")
    if h in ("localhost", "metadata.google.internal") or h.endswith((".localhost", ".internal")):
        raise Blocked(f"SSRF: {host} is not public")
    try:
        infos = socket.getaddrinfo(h, None, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise Blocked(f"SSRF: {host} does not resolve") from None
    if not infos:
        raise Blocked(f"SSRF: {host} does not resolve")
    allowed = _allowlist()
    addrs = [ipaddress.ip_address(sa[0]) for _f, _t, _p, _c, sa in infos]
    if allowed and all(str(a) in allowed for a in addrs):
        return
    for ip in addrs:
        if _blocked_ip(ip):
            raise Blocked(f"SSRF: {host} resolves to non-public {ip}")


def _origin(url: str) -> str:
    p = urllib.parse.urlparse(url)
    return f"{p.scheme}://{p.hostname or ''}" + (f":{p.port}" if p.port else "")


async def _pace(host: str) -> None:
    """>= 1s between requests to one domain (per-process; single worker)."""
    now = time.monotonic()
    wait = DOMAIN_GAP_S - (now - _last_hit.get(host, 0.0))
    if wait > 0:
        await asyncio.sleep(wait)
    _last_hit[host] = time.monotonic()


async def _robots_allows(client: httpx.AsyncClient, url: str) -> bool:
    """Fail-open robots check, cached per origin for an hour."""
    p = urllib.parse.urlparse(url)
    origin = _origin(url)
    now = time.monotonic()
    cached = _robots.get(origin)
    if cached and now - cached[0] < ROBOTS_TTL_S:
        return cached[1].can_fetch(UA, url)
    rp = urllib.robotparser.RobotFileParser()
    try:
        r = await client.get(f"{origin}/robots.txt", timeout=10.0)
        lines = r.text.splitlines() if r.status_code == 200 else ["User-agent: *", "Disallow:"]
    except Exception:
        lines = ["User-agent: *", "Disallow:"]
    rp.parse(lines)
    _robots[origin] = (now, rp)
    return rp.can_fetch(UA, url)


async def _read_capped(response: httpx.Response, cap: int) -> tuple[bytes, bool]:
    body = bytearray()
    async for chunk in response.aiter_bytes(65536):
        body += chunk
        if len(body) >= cap:
            return bytes(body[:cap]), True
    return bytes(body), False


def _looks_js_rendered(html: str) -> bool:
    """Auto-escalation heuristic: scripts present but almost no text."""
    if "<script" not in html:
        return False
    text = re.sub(r"(?s)<(script|style|noscript)[^>]*>.*?</\1>|<[^>]+>", " ", html)
    return len(re.sub(r"\s+", " ", text).strip()) < 400


_browser_fetcher = None


def _browser() -> object:
    """One shared DynamicFetcher (session args go to the constructor —
    configure() only takes parser args and rejects these)."""
    global _browser_fetcher
    if _browser_fetcher is None:
        from scrapling.fetchers import DynamicFetcher

        _browser_fetcher = DynamicFetcher(headless=True, network_idle=True, max_pages=BROWSER_SLOTS)
    return _browser_fetcher


def _browser_fetch(url: str, wait_for: str | None, timeout_ms: int) -> tuple[int, str, str]:
    """Blocking Scrapling call — always run in a thread. Returns (status, final_url, html)."""
    kwargs: dict = {"timeout": timeout_ms, "block_ads": True}
    if wait_for:
        kwargs["wait_selector"] = wait_for
    page = _browser().fetch(url, **kwargs)  # type: ignore[union-attr]
    return page.status, str(page.url), page.html_content


async def _fetch_http(client: httpx.AsyncClient, url: str, cap: int, timeout_s: float) -> tuple[str, bytes, bool]:
    """Manual redirect loop so every hop re-passes the SSRF gate. Returns (final_url, body, truncated)."""
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        p = urllib.parse.urlparse(current)
        if p.scheme not in ("http", "https") or not p.hostname:
            raise Blocked(f"only http/https URLs (got {p.scheme or 'none'})")
        await asyncio.to_thread(_check_host, p.hostname)
        await _pace(p.hostname)
        response = await client.get(current, timeout=timeout_s)
        if response.status_code in (301, 302, 303, 307, 308) and response.headers.get("location"):
            current = urllib.parse.urljoin(current, response.headers["location"])
            await response.aclose()
            continue
        if response.status_code in (403, 429):
            await response.aclose()
            raise Blocked(f"HTTP {response.status_code} (no workaround per policy)")
        if response.status_code != 200:
            await response.aclose()
            raise Blocked(f"HTTP {response.status_code}")
        ctype = response.headers.get("content-type", "")
        if "text/html" not in ctype and "application/xhtml" not in ctype:
            await response.aclose()
            raise Blocked(f"HTML only (got {ctype or 'unknown type'})")
        body, truncated = await _read_capped(response, cap)
        await response.aclose()
        return current, body, truncated
    raise Blocked(f"too many redirects (>{MAX_REDIRECTS})")


@app.get("/health")
async def health(x_internal_token: str | None = Header(default=None)) -> dict:
    _auth(x_internal_token)
    return {"ok": True}


@app.post("/fetch")
async def fetch(body: FetchBody, x_internal_token: str | None = Header(default=None)) -> dict:
    _auth(x_internal_token)
    if body.mode == "stealth":
        raise HTTPException(status_code=400, detail='mode "stealth" is forbidden by policy')
    if body.mode not in ("auto", "http", "browser"):
        raise HTTPException(status_code=400, detail='mode must be "auto", "http" or "browser"')
    started = time.monotonic()
    try:
        url = body.url.strip()
        if not url:
            raise HTTPException(status_code=400, detail="url is required")
        # ponytail: DNS re-check inside the browser is coarse — the initial URL
        # is fully gated here, and the returned final URL is re-gated before
        # we hand the body back. A hostile in-browser redirect chain past that
        # is out of scope for the lite sidecar (upgrade: per-request proxy).
        p = urllib.parse.urlparse(url if "://" in url else f"https://{url}")
        if p.scheme not in ("http", "https") or not p.hostname:
            raise Blocked("only http/https URLs with a host")
        await asyncio.to_thread(_check_host, p.hostname)

        mode_used = body.mode
        async with httpx.AsyncClient(follow_redirects=False, headers={"User-Agent": UA}) as client:
            if not await _robots_allows(client, url):
                raise Blocked("robots.txt disallows this URL")
            if mode_used == "browser":
                final_url, html, truncated = await _fetch_browser(url, body)
            else:
                final_url, raw, truncated = await _fetch_http(client, url, body.max_bytes, body.timeout_ms / 1000.0)
                html = raw.decode("utf-8", errors="replace")
                if mode_used == "auto" and _looks_js_rendered(html):
                    mode_used = "browser"
                    final_url, html, truncated = await _fetch_browser(url, body)
            await asyncio.to_thread(_check_host, urllib.parse.urlparse(final_url).hostname or "")
        took_ms = int((time.monotonic() - started) * 1000)
        # Never log bodies: url + shape only.
        log.info("fetch mode=%s used=%s status=ok bytes=%d took_ms=%d url=%s", body.mode, mode_used, len(html), took_ms, url)
        return {"status": "ok", "url": final_url, "mode_used": mode_used, "html": html, "truncated": truncated, "took_ms": took_ms}
    except Blocked as b:
        log.info("fetch status=blocked url=%s reason=%s", body.url, str(b))
        return {"status": "blocked", "reason": str(b)}
    except HTTPException:
        raise
    except Exception as e:  # timeouts, DNS mid-flight, browser crashes
        log.info("fetch status=error url=%s kind=%s", body.url, type(e).__name__)
        return {"status": "error", "reason": f"{type(e).__name__}"}


async def _fetch_browser(url: str, body: FetchBody) -> tuple[str, str, bool]:
    async with _browser_sem:  # max 2 browser pages at once
        status, final_url, html = await asyncio.to_thread(_browser_fetch, url, body.wait_for, body.timeout_ms)
    if status in (403, 429):
        raise Blocked(f"HTTP {status} (no workaround per policy)")
    if status != 200:
        raise Blocked(f"HTTP {status}")
    capped = html[: body.max_bytes]
    return final_url, capped, len(html) > body.max_bytes


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    uvicorn.run(app, host="127.0.0.1", port=4318, log_level="warning")
