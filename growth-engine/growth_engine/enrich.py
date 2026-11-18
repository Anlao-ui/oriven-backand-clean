"""Enrich leads: visit homepage + up to 2 contact/about pages and detect signals."""
from __future__ import annotations

import json

from . import db
from .channel import decide_channel
from .collect import domain_of
from .fetch import PoliteFetcher
from .signals import analyze_pages, find_contact_links


def enrich_lead(fetcher: PoliteFetcher, lead: dict, max_extra: int = 2) -> tuple[str, dict | None]:
    url = lead["website"]
    final, html = fetcher.get(url)
    if final is None and url.startswith("https://"):
        final, html = fetcher.get("http://" + url[8:])
    if final is None:
        return f"failed:{html}", None
    pages = [(final, html)]
    for link in find_contact_links(html, final, limit=max_extra):
        u, h = fetcher.get(link)
        if u:
            pages.append((u, h))
    domain = domain_of(final) or lead["domain"]
    sig = analyze_pages(pages, domain, lead.get("name") or "")
    sig["final_url"] = final
    sig["pages"] = [u for u, _ in pages]
    if not sig["best_email"] and lead.get("osm_email"):
        from .signals import best_email
        osm = [e.strip().lower() for e in lead["osm_email"].split(";")]
        sig["best_email"] = best_email(osm, domain)
        sig["emails"] = (sig["emails"] + osm)[:5]
    return "ok", sig


def apply_signals(conn, lead_id: int, status: str, sig: dict | None) -> None:
    if sig is None:
        conn.execute("UPDATE leads SET enriched_at=?, enrich_status=? WHERE id=?",
                     (db.now(), status, lead_id))
    else:
        channel = decide_channel(sig.get("legal_form"), sig.get("best_email"),
                                 opted_out=db.is_opted_out(conn, sig.get("best_email")))
        conn.execute(
            "UPDATE leads SET enriched_at=?, enrich_status=?, signals=?, email=?, legal_form=?, channel=? WHERE id=?",
            (db.now(), status, json.dumps(sig, ensure_ascii=False), sig.get("best_email"),
             sig.get("legal_form"), channel, lead_id))
    conn.commit()


def enrich(conn, cfg: dict, limit: int = 100, refresh: bool = False) -> int:
    """Visit sites in parallel across *different* hosts; per-host delay and robots.txt still apply."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading

    where = "1=1" if refresh else "enriched_at IS NULL"
    rows = conn.execute(f"SELECT * FROM leads WHERE {where} AND status != 'deleted' ORDER BY id LIMIT ?",
                        (limit,)).fetchall()
    workers = int(cfg["crawler"].get("workers", 8))
    local = threading.local()
    max_extra = cfg["crawler"].get("max_extra_pages", 2)

    def work(lead):
        if not hasattr(local, "fetcher"):
            local.fetcher = PoliteFetcher(cfg)
        try:
            return lead, *enrich_lead(local.fetcher, lead, max_extra)
        except Exception as exc:  # one broken site must never stop the run
            return lead, f"error:{type(exc).__name__}", None

    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work, dict(r)) for r in rows]
        for fut in as_completed(futures):
            lead, status, sig = fut.result()
            apply_signals(conn, lead["id"], status, sig)  # DB writes stay on this thread
            done += 1
            ads = ",".join(sig["ad_platforms"]) if sig else "-"
            print(f"[{done}/{len(rows)}] {lead['name'][:40]:40} {status:12} ads={ads}", flush=True)
    return done
