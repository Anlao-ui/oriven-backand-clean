"""Post-performance model, trained from scratch (ridge regression in numpy) on our own post metrics."""
from __future__ import annotations

import math
from datetime import date

import numpy as np

from ..config import MODELS_DIR
from ..model import RidgeRegression, load, save
from .formats import FORMATS

PATH = MODELS_DIR / "post_model.json"
PLATFORMS = ["instagram", "linkedin"]
FEATURES = [f"fmt_{f}" for f in FORMATS] + [f"pl_{p}" for p in PLATFORMS] + [f"wd_{i}" for i in range(7)] \
    + ["caption_len", "has_question"]


def features(fmt: str, platform: str, day: str, caption: str = "") -> np.ndarray:
    wd = date.fromisoformat(day).weekday()
    v = [float(fmt == f) for f in FORMATS] + [float(platform == p) for p in PLATFORMS] + \
        [float(wd == i) for i in range(7)] + [min(len(caption), 600) / 600, float("?" in caption)]
    return np.array(v)


def engagement(m) -> float:
    """Weighted engagement per reach; saves/shares count most, clicks are the real goal."""
    reach = max(m["reach"] or 0, 1)
    score = (m["likes"] or 0) + 3 * (m["comments"] or 0) + 4 * (m["saves"] or 0) + 4 * (m["shares"] or 0) \
        + 6 * (m["clicks"] or 0)
    return math.log1p(1000 * score / reach)


def dataset(conn):
    rows = conn.execute(
        """SELECT p.*, m.reach, m.likes, m.comments, m.saves, m.shares, m.clicks FROM posts p
           JOIN post_metrics m ON m.id = (SELECT id FROM post_metrics WHERE post_id=p.id ORDER BY id DESC LIMIT 1)""").fetchall()
    X = [features(r["format"], r["platform"], r["date"], r["caption"] or "") for r in rows]
    y = [engagement(r) for r in rows]
    return np.array(X), np.array(y)


def train(conn):
    X, y = dataset(conn)
    if len(y) < 6:
        print(f"{len(y)} posts met cijfers; minimaal 6 nodig om het postmodel te trainen.")
        return None
    m = RidgeRegression(l2=3.0).fit(X, y, feature_names=FEATURES)
    save(m, PATH)
    print(f"Postmodel getraind op {len(y)} posts.")
    for f in FORMATS:
        x = features(f, "instagram", date.today().isoformat())
        print(f"  {f:14} verwachte score {m.predict(x)[0]:.2f}")
    return m


def choose_format(conn, platform: str, day: str, allowed: list[str], used: list[str], rng=None) -> str:
    """Exploit what works, keep exploring: predicted score + UCB bonus for rarely tried formats."""
    rng = rng or np.random.default_rng()
    model = load(PATH) if PATH.exists() else None
    counts = {f: 0 for f in allowed}
    for r in conn.execute("SELECT format, COUNT(*) n FROM posts WHERE platform=? GROUP BY format", (platform,)):
        if r["format"] in counts:
            counts[r["format"]] = r["n"]
    total = sum(counts.values()) + 1
    best, best_v = None, -1e9
    for f in allowed:
        pred = float(model.predict(features(f, platform, day))[0]) if model else 0.0
        bonus = (model.resid_std if model else 1.0) * math.sqrt(2 * math.log(total + 1) / (counts[f] + 1))
        penalty = 2.0 * used.count(f)  # variety within one week
        v = pred + bonus - penalty + rng.normal(0, 0.05)
        if v > best_v:
            best, best_v = f, v
    return best
