"""Weekly content plan: pick formats (perf model), fill copy, render, queue for approval, publish/export."""
from __future__ import annotations

import json
import random
import shutil
from datetime import date, datetime, timedelta

from .. import db
from ..config import OUTPUT_DIR, secret
from ..llm import LocalLLM
from . import formats
from .perf_model import choose_format

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
HASHTAGS = "#smallbusiness #onlineads #metaads #googleads #tiktokads #marketingtips"


def week_dates(week_offset: int = 1) -> list[date]:
    today = date.today()
    monday = today - timedelta(days=today.weekday()) + timedelta(weeks=week_offset)
    return [monday + timedelta(days=i) for i in range(7)]


def pick_spec(conn, fmt: str, cfg: dict) -> dict:
    """Least-used idea from the bank; optionally a fresh variant from the local model."""
    bank = formats.ideas()[fmt]
    used = [json.loads(r["spec"]) for r in conn.execute("SELECT spec FROM posts WHERE format=?", (fmt,))]
    fresh = [i for i in bank if i not in used]
    spec = dict(random.choice(fresh or bank))
    variant = llm_variant(cfg, fmt, spec)
    return variant or spec


def llm_variant(cfg: dict, fmt: str, example: dict) -> dict | None:
    """Ask the local model for a new idea in the same JSON shape (English, no brand name)."""
    llm = LocalLLM(cfg)
    if llm.model() is None:
        return None
    sys = ("You write social content for a tool that puts Google, Meta, TikTok, Pinterest and Snapchat ads for "
           "small businesses in one place. Write in plain, dry, witty English. No hype, no emoji, no hashtags, "
           "never mention any brand or product name. Reply with JSON only, same keys and types as the example.")
    out = llm.chat([{"role": "system", "content": sys},
                    {"role": "user", "content": "Example:\n" + json.dumps(example) + "\nWrite a new, different one."}],
                   max_tokens=500)
    try:
        d = json.loads(out[out.index("{"): out.rindex("}") + 1])
    except (TypeError, ValueError):
        return None
    if set(d) != set(example) or "orivenai" in json.dumps(d).lower():
        return None
    return d


def caption_for(spec: dict, platform: str, fmt: str) -> str:
    base = spec.get("caption", "")
    if platform == "linkedin":
        return (f"{base}\n\nWe built one workspace for Google, Meta, TikTok, Pinterest and Snapchat ads, made for "
                f"small businesses. Try the demo without an account: orivenai.com/demo")
    cta = "Free demo, no account needed. Link in bio." if fmt != "carousel" else "Save this. Demo link in bio."
    return f"{base}\n\n{cta}\n\n{HASHTAGS}"


def plan_week(conn, cfg: dict, week_offset: int = 1, render: bool = True) -> list[int]:
    c = cfg["content"]
    dates = week_dates(week_offset)
    week = dates[0].isocalendar()
    week_key = f"{week[0]}-W{week[1]:02d}"
    if conn.execute("SELECT 1 FROM posts WHERE week=?", (week_key,)).fetchone():
        print(f"Week {week_key} is al gepland.")
        return []
    ids = []
    used = {"instagram": [], "linkedin": []}
    for d in dates:
        dayname = DAYS[d.weekday()]
        for platform, days in (("instagram", c["instagram_days"]), ("linkedin", c["linkedin_days"])):
            if dayname not in days:
                continue
            fmt = choose_format(conn, platform, d.isoformat(), formats.PLATFORM_FORMATS[platform], used[platform])
            used[platform].append(fmt)
            spec = pick_spec(conn, fmt, cfg)
            cur = conn.execute(
                "INSERT INTO posts (week, date, platform, format, kind, spec, caption, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (week_key, d.isoformat(), platform, fmt, formats.FORMATS[fmt]["kind"], json.dumps(spec, ensure_ascii=False),
                 caption_for(spec, platform, fmt), "draft", db.now()))
            ids.append(cur.lastrowid)
    conn.commit()
    print(f"Week {week_key}: {len(ids)} posts gepland")
    if render:
        render_many(conn, cfg, ids)
    return ids


def post_dir(row) -> "Path":
    return OUTPUT_DIR / "content" / row["week"] / f"{row['date']}_{row['platform']}_{row['format']}_{row['id']}"


def render_many(conn, cfg: dict, ids: list[int]) -> None:
    from playwright.sync_api import sync_playwright
    from .render import launch, render_format
    with sync_playwright() as p:
        b = launch(p)
        for pid in ids:
            row = conn.execute("SELECT * FROM posts WHERE id=?", (pid,)).fetchone()
            try:
                files = render_format(cfg, row["format"], json.loads(row["spec"]), post_dir(row), browser=b)
                (post_dir(row) / "caption.txt").write_text(row["caption"], encoding="utf-8")
                conn.execute("UPDATE posts SET media=?, error=NULL WHERE id=?", (json.dumps([str(f) for f in files]), pid))
                print(f"  {row['date']} {row['platform']:9} {row['format']}: {len(files)} bestand(en)")
            except Exception as exc:
                conn.execute("UPDATE posts SET error=? WHERE id=?", (str(exc)[:500], pid))
                print(f"  {row['date']} {row['platform']:9} {row['format']}: MISLUKT — {exc}")
            conn.commit()
        b.close()


def render_post(conn, cfg: dict, post_id: int) -> None:
    render_many(conn, cfg, [post_id])


def publish_due(conn, cfg: dict) -> None:
    """Instagram: publish approved posts that are due via the Graph API. LinkedIn: export folder for manual posting."""
    from pathlib import Path
    from .instagram import Instagram
    today = date.today().isoformat()
    rows = conn.execute("SELECT * FROM posts WHERE status='approved' AND date<=?", (today,)).fetchall()
    ig_id, ig_token = secret("IG_USER_ID"), secret("IG_ACCESS_TOKEN")
    base = cfg["content"].get("media_public_base_url", "").rstrip("/")
    for r in rows:
        media = [Path(m) for m in json.loads(r["media"] or "[]")]
        if not media:
            continue
        if r["platform"] == "linkedin":
            dest = OUTPUT_DIR / "linkedin_te_posten" / f"{r['date']}_{r['format']}"
            dest.mkdir(parents=True, exist_ok=True)
            for m in media:
                shutil.copy(m, dest / m.name)
            (dest / "caption.txt").write_text(r["caption"], encoding="utf-8")
            conn.execute("UPDATE posts SET status='exported', published_at=? WHERE id=?", (db.now(), r["id"]))
            print(f"LinkedIn {r['date']}: klaar om te posten in {dest}")
            continue
        if not (ig_id and ig_token and base):
            print("Instagram: IG_USER_ID/IG_ACCESS_TOKEN (.env) of content.media_public_base_url (config) ontbreekt.")
            continue
        rel = [m.resolve().relative_to(OUTPUT_DIR.resolve()).as_posix() for m in media]
        try:
            ext = Instagram(ig_id, ig_token).publish(r["kind"], [f"{base}/{x}" for x in rel], r["caption"])
            conn.execute("UPDATE posts SET status='published', external_id=?, published_at=? WHERE id=?",
                         (ext, db.now(), r["id"]))
            print(f"Instagram {r['date']} {r['format']}: gepubliceerd ({ext})")
        except Exception as exc:
            conn.execute("UPDATE posts SET error=? WHERE id=?", (str(exc)[:500], r["id"]))
            print(f"Instagram {r['date']}: MISLUKT — {exc}")
    conn.commit()


def record_metrics(conn, post_id: int, **m) -> None:
    conn.execute("INSERT INTO post_metrics (post_id, reach, likes, comments, saves, shares, clicks, recorded_at) "
                 "VALUES (?,?,?,?,?,?,?,?)", (post_id, m.get("reach", 0), m.get("likes", 0), m.get("comments", 0),
                                              m.get("saves", 0), m.get("shares", 0), m.get("clicks", 0), db.now()))
    conn.commit()
    print(f"Cijfers opgeslagen voor post {post_id}")


def fetch_instagram_metrics(conn, cfg: dict) -> None:
    from .instagram import Instagram
    ig_id, ig_token = secret("IG_USER_ID"), secret("IG_ACCESS_TOKEN")
    if not (ig_id and ig_token):
        print("IG_USER_ID / IG_ACCESS_TOKEN ontbreken in .env")
        return
    ig = Instagram(ig_id, ig_token)
    cutoff = (datetime.now() - timedelta(days=2)).isoformat()
    for r in conn.execute("SELECT * FROM posts WHERE platform='instagram' AND external_id IS NOT NULL "
                          "AND published_at <= ?", (cutoff,)).fetchall():
        try:
            record_metrics(conn, r["id"], **ig.insights(r["external_id"], r["kind"]))
        except Exception as exc:
            print(f"post {r['id']}: {exc}")
