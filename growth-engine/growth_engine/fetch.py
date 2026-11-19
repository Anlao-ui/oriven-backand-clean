"""Polite HTTP fetching: robots.txt, honest User-Agent, per-host delay, timeouts, size cap."""
from __future__ import annotations

import time
import urllib.robotparser
from urllib.parse import urlparse

import requests

from .config import user_agent


def decode_html(raw: bytes, header_encoding: str | None) -> str:
    """Header charset (ignoring requests' iso-8859-1 default), else <meta charset>, else utf-8."""
    import re
    enc = header_encoding if header_encoding and header_encoding.lower() != "iso-8859-1" else None
    if not enc:
        m = re.search(rb"<meta[^>]+charset=[\"']?([A-Za-z0-9_\-]+)", raw[:4096], re.I)
        enc = m.group(1).decode("ascii") if m else "utf-8"
    try:
        return raw.decode(enc, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


class PoliteFetcher:
    def __init__(self, cfg: dict):
        c = cfg["crawler"]
        self.delay = float(c.get("delay_seconds", 2.0))
        self.timeout = float(c.get("timeout_seconds", 12))
        self.max_bytes = int(c.get("max_bytes", 2_000_000))
        self.ua = user_agent(cfg)
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": self.ua, "Accept-Language": "nl,en;q=0.8",
                                     "Accept": "text/html,application/xhtml+xml"})
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._last: dict[str, float] = {}

    def _wait(self, host: str) -> None:
        last = self._last.get(host)
        if last is not None:
            gap = time.monotonic() - last
            if gap < self.delay:
                time.sleep(self.delay - gap)
        self._last[host] = time.monotonic()

    def allowed(self, url: str) -> bool:
        p = urlparse(url)
        origin = f"{p.scheme}://{p.netloc}"
        if origin not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                self._wait(p.netloc)
                r = self.session.get(origin + "/robots.txt", timeout=self.timeout)
                if r.status_code in (401, 403):
                    rp.disallow_all = True
                elif r.status_code >= 400:
                    rp.allow_all = True
                else:
                    rp.parse(r.text.splitlines())
            except requests.RequestException:
                rp.allow_all = True  # robots unreachable: standard behaviour is to allow
            self._robots[origin] = rp
        rp = self._robots[origin]
        return rp.can_fetch(self.ua, url)

    def get(self, url: str) -> tuple[str | None, str | None]:
        """Returns (final_url, html) or (None, None). Never raises on network errors."""
        if not self.allowed(url):
            return None, "robots"
        host = urlparse(url).netloc
        self._wait(host)
        try:
            with self.session.get(url, timeout=self.timeout, stream=True, allow_redirects=True) as r:
                ctype = r.headers.get("content-type", "")
                if r.status_code >= 400 or "html" not in ctype.lower():
                    return None, f"http {r.status_code}"
                chunks, size = [], 0
                for chunk in r.iter_content(65536):
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > self.max_bytes:
                        break
                raw = b"".join(chunks)
                html = decode_html(raw, r.encoding)
                return r.url, html
        except requests.RequestException as exc:
            return None, type(exc).__name__
