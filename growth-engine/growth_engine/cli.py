"""One CLI for the whole engine:  python -m growth_engine <command>"""
from __future__ import annotations

import argparse
import json
import sys

from . import db
from .config import load_config


def _cities(cfg, names):
    if not names:
        return cfg["cities"][:1]
    by = {c["name"].lower(): c for c in cfg["cities"]}
    return [by.get(n.lower(), {"name": n, "admin_level": 8, "country": "NL"}) for n in names]


def cmd_collect(a, cfg, conn):
    from .collect import collect
    collect(conn, cfg, _cities(cfg, a.city))


def cmd_enrich(a, cfg, conn):
    from .enrich import enrich
    enrich(conn, cfg, limit=a.limit, refresh=a.refresh)


def cmd_train(a, cfg, conn):
    from .scoring import score_all, train
    train(conn)
    score_all(conn)


def cmd_score(a, cfg, conn):
    from .export import export_csv
    from .scoring import load_model, score_all, train
    if load_model() is None:
        train(conn)
    score_all(conn)
    path = export_csv(conn)
    print(f"{path} geschreven")
    show_top(conn, a.top)


def show_top(conn, n):
    rows = conn.execute("SELECT * FROM leads WHERE status!='deleted' AND score IS NOT NULL "
                        "ORDER BY score DESC LIMIT ?", (n,)).fetchall()
    for i, r in enumerate(rows, 1):
        reasons = json.loads(r["reasons"] or "[]")
        print(f"{i:>2}. [{r['score']:5.1f}] {r['name']} — {r['city']} — {r['website']}  ({r['channel']})")
        for t in reasons:
            print(f"      · {t}")


def cmd_label(a, cfg, conn):
    from .scoring import add_label, least_certain, score_all, train
    done = 0
    while done < a.n:
        batch = least_certain(conn, 1)
        if not batch:
            print("Niets meer te labelen.")
            break
        lead = batch[0]
        sig = json.loads(lead["signals"])
        print("\n" + "=" * 70)
        print(f"{lead['name']}  ({lead['category']}, {lead['city']})  score {lead['score']}")
        print(f"{lead['website']}\n{sig.get('title') or ''}\n{(sig.get('description') or '')[:160]}")
        print(f"ads: {', '.join(sig.get('ad_platforms', [])) or 'geen'} | platform: {sig.get('platform') or '-'}"
              f" | GTM: {'ja' if sig.get('gtm') else 'nee'} | rechtsvorm: {sig.get('legal_form') or '?'}"
              f" | e-mail: {sig.get('best_email') or '-'}")
        ans = input("Goede lead? [g]oed / [s]lecht / [o]verslaan / [q] stoppen: ").strip().lower()
        if ans.startswith("q"):
            break
        if ans.startswith("g"):
            add_label(conn, lead["id"], 1)
        elif ans.startswith("s") or ans.startswith("b"):
            add_label(conn, lead["id"], 0)
        else:
            conn.execute("UPDATE leads SET uncertainty=1 WHERE id=?", (lead["id"],))
            conn.commit()
            continue
        done += 1
        if done % 5 == 0:
            train(conn); score_all(conn)
    train(conn); score_all(conn)


def cmd_outcome(a, cfg, conn):
    from .scoring import record_outcome
    record_outcome(conn, a.lead_id, a.outcome)
    print(f"Uitkomst '{a.outcome}' opgeslagen voor lead {a.lead_id}")


def cmd_optout(a, cfg, conn):
    kind = "email" if "@" in a.value else "domain"
    db.add_optout(conn, a.value, kind, "handmatig")
    print(f"{a.value} staat op de opt-out lijst")


def cmd_delete(a, cfg, conn):
    from .export import delete
    n = delete(conn, lead_id=a.lead, domain=a.domain, email=a.email)
    print(f"{n} lead(s) verwijderd; staat op de opt-out lijst zodat het niet terugkomt")


def cmd_draft(a, cfg, conn):
    from .outreach import draft_for_top
    n = draft_for_top(conn, cfg, limit=a.limit)
    print(f"{n} concepten in de goedkeuringswachtrij (dashboard → Wachtrij)")


def cmd_send(a, cfg, conn):
    from .mailer import check_inbox, send_due
    if not a.no_inbox:
        check_inbox(conn, cfg)
    send_due(conn, cfg, dry_run=a.dry_run)


def cmd_inbox(a, cfg, conn):
    from .mailer import check_inbox
    check_inbox(conn, cfg)


def cmd_content(a, cfg, conn):
    from .content import pipeline
    if a.action == "plan":
        pipeline.plan_week(conn, cfg, week_offset=a.week_offset, render=not a.no_render)
    elif a.action == "render":
        pipeline.render_post(conn, cfg, a.post_id)
    elif a.action == "publish":
        pipeline.publish_due(conn, cfg)
    elif a.action == "metrics":
        pipeline.record_metrics(conn, a.post_id, reach=a.reach, likes=a.likes, comments=a.comments,
                                saves=a.saves, shares=a.shares, clicks=a.clicks)
    elif a.action == "fetch-metrics":
        pipeline.fetch_instagram_metrics(conn, cfg)
    elif a.action == "train":
        from .content.perf_model import train
        train(conn)
    elif a.action == "demo":
        from .content.render import demo_samples
        demo_samples(cfg)


def cmd_finetune(a, cfg, conn):
    from .training_data import export_dataset
    path, n = export_dataset(conn)
    need = cfg["llm"]["min_examples_for_finetune"]
    print(f"{n} goedgekeurde berichten geëxporteerd naar {path}")
    if n < need and not a.force:
        print(f"Nog {need - n} nodig voor een fine-tune; tot die tijd few-shot met het basismodel.")
        return
    import subprocess
    from .config import ROOT
    py = ROOT / ".venv-gpu" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if not py.exists():
        print("GPU-omgeving ontbreekt: draai eerst scripts\\setup_gpu.ps1")
        return
    subprocess.run([str(py), str(ROOT / "finetune" / "train_qlora.py"), "--data", str(path)], check=True)


def cmd_weekly(a, cfg, conn):
    from .weekly import run_weekly
    run_weekly(conn, cfg)


def cmd_dashboard(a, cfg, conn):
    from .dashboard import run
    run(cfg)


def main(argv=None):
    p = argparse.ArgumentParser(prog="growth", description="OrivenAI Growth Engine")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("collect", help="bedrijven ophalen uit OpenStreetMap"); s.add_argument("--city", nargs="*")
    s.set_defaults(f=cmd_collect)
    s = sub.add_parser("enrich", help="websites bezoeken en signalen detecteren")
    s.add_argument("--limit", type=int, default=100); s.add_argument("--refresh", action="store_true")
    s.set_defaults(f=cmd_enrich)
    s = sub.add_parser("label", help="leads labelen (active learning)"); s.add_argument("-n", type=int, default=20)
    s.set_defaults(f=cmd_label)
    sub.add_parser("train", help="scoremodel trainen").set_defaults(f=cmd_train)
    s = sub.add_parser("score", help="leads scoren + leads.csv"); s.add_argument("--top", type=int, default=20)
    s.set_defaults(f=cmd_score)
    s = sub.add_parser("outcome", help="uitkomst vastleggen"); s.add_argument("lead_id", type=int)
    s.add_argument("outcome", choices=["replied", "demo", "bought", "negative"]); s.set_defaults(f=cmd_outcome)
    s = sub.add_parser("optout", help="e-mail of domein op opt-out lijst"); s.add_argument("value")
    s.set_defaults(f=cmd_optout)
    s = sub.add_parser("delete", help="alle data van een bedrijf verwijderen (AVG)")
    s.add_argument("--lead", type=int); s.add_argument("--domain"); s.add_argument("--email")
    s.set_defaults(f=cmd_delete)
    s = sub.add_parser("draft", help="outreach-concepten schrijven"); s.add_argument("--limit", type=int, default=None)
    s.set_defaults(f=cmd_draft)
    s = sub.add_parser("send", help="goedgekeurde mails versturen")
    s.add_argument("--dry-run", action="store_true"); s.add_argument("--no-inbox", action="store_true")
    s.set_defaults(f=cmd_send)
    sub.add_parser("inbox", help="antwoorden/bounces lezen via IMAP").set_defaults(f=cmd_inbox)
    s = sub.add_parser("content", help="social content")
    s.add_argument("action", choices=["plan", "render", "publish", "metrics", "fetch-metrics", "train", "demo"])
    s.add_argument("--post-id", type=int); s.add_argument("--week-offset", type=int, default=1)
    s.add_argument("--no-render", action="store_true")
    for m in ("reach", "likes", "comments", "saves", "shares", "clicks"):
        s.add_argument(f"--{m}", type=int, default=0)
    s.set_defaults(f=cmd_content)
    s = sub.add_parser("finetune", help="eigen tekstmodel fine-tunen (QLoRA, GPU)")
    s.add_argument("--force", action="store_true"); s.set_defaults(f=cmd_finetune)
    sub.add_parser("weekly", help="wekelijkse job (zondagavond)").set_defaults(f=cmd_weekly)
    sub.add_parser("dashboard", help="lokaal dashboard").set_defaults(f=cmd_dashboard)
    a = p.parse_args(argv)
    cfg = load_config()
    conn = db.connect()
    a.f(a, cfg, conn)


if __name__ == "__main__":
    main()
