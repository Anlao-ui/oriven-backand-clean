"""Sunday-evening job: next week's leads, drafts and content, all waiting for your approval."""
from __future__ import annotations

import traceback

from . import db


def _step(conn, name, fn):
    print(f"\n== {name} ==")
    try:
        fn()
        db.log_event(conn, "weekly_step", detail={"step": name, "ok": True})
    except Exception as exc:  # keep going: one failing step must not block the rest of the week
        traceback.print_exc()
        db.log_event(conn, "weekly_step", detail={"step": name, "ok": False, "error": str(exc)})


def next_cities(conn, cfg) -> list[dict]:
    done = {r["city"] for r in conn.execute("SELECT DISTINCT city FROM leads")}
    todo = [c for c in cfg["cities"] if c["name"] not in done]
    return todo[: cfg.get("cities_per_week", 1)]


def run_weekly(conn, cfg) -> None:
    from .collect import collect
    from .content.perf_model import train as train_posts
    from .content.pipeline import fetch_instagram_metrics, plan_week
    from .enrich import enrich
    from .export import export_csv
    from .mailer import check_inbox
    from .outreach import draft_for_top
    from .scoring import score_all, train

    _step(conn, "inbox (antwoorden/bounces)", lambda: check_inbox(conn, cfg))
    cities = next_cities(conn, cfg)
    if cities:
        _step(conn, f"collect {', '.join(c['name'] for c in cities)}", lambda: collect(conn, cfg, cities))
    _step(conn, "enrich", lambda: enrich(conn, cfg, limit=cfg.get("enrich_per_week", 300)))
    _step(conn, "train + score", lambda: (train(conn), score_all(conn), export_csv(conn)))
    _step(conn, "drafts", lambda: draft_for_top(conn, cfg))
    _step(conn, "post-cijfers", lambda: (fetch_instagram_metrics(conn, cfg), train_posts(conn)))
    _step(conn, "content volgende week", lambda: plan_week(conn, cfg, week_offset=1))
    print("\nKlaar. Open het dashboard om goed te keuren: python -m growth_engine dashboard")
