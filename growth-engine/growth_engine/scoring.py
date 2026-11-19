"""Lead scoring with our own model: weak labels -> active learning -> outcomes."""
from __future__ import annotations

import json

import numpy as np

from . import db
from .config import MODELS_DIR
from .model import LogisticRegression, load, save

MODEL_PATH = MODELS_DIR / "lead_model.json"
CATEGORIES = ["winkel", "horeca", "zorg", "kantoor", "ambacht", "fitness", "hotel"]
PLATFORM_NAMES = {"meta": "Meta", "google_ads": "Google Ads", "tiktok": "TikTok",
                  "pinterest": "Pinterest", "snapchat": "Snapchat"}
FEATURES = (["n_ad_platforms", "meta", "google_ads", "tiktok", "pinterest", "snapchat", "ga4", "gtm",
             "shop_platform", "cart", "generic_email", "any_email", "kvk", "legal_entity",
             "n_socials", "linkedin", "instagram", "fetch_ok", "lang_nl"]
            + [f"cat_{c}" for c in CATEGORIES])
# Sample weights per label source.
SOFT = {0: 0.15, 1: 0.85}
WEIGHTS = {"weak": 0.3, "human": 1.0, "replied": 1.5, "negative": 1.5, "demo": 2.5, "bought": 4.0}


def features(lead: dict) -> np.ndarray:
    sig = json.loads(lead["signals"]) if lead.get("signals") else {}
    px = sig.get("pixels", {})
    cat = (lead.get("category") or "").split(":")[0]
    socials = sig.get("socials", {})
    f = {
        "n_ad_platforms": sig.get("n_ad_platforms", 0),
        "meta": px.get("meta", False), "google_ads": px.get("google_ads", False),
        "tiktok": px.get("tiktok", False), "pinterest": px.get("pinterest", False),
        "snapchat": px.get("snapchat", False),
        "ga4": sig.get("ga4", False), "gtm": sig.get("gtm", False),
        "shop_platform": sig.get("platform") in ("shopify", "woocommerce", "lightspeed", "magento"),
        "cart": sig.get("cart", False),
        "generic_email": bool(sig.get("best_email")), "any_email": bool(sig.get("emails")),
        "kvk": bool(sig.get("kvk")), "legal_entity": sig.get("is_legal_entity", False),
        "n_socials": len(socials), "linkedin": "linkedin" in socials, "instagram": "instagram" in socials,
        "fetch_ok": bool(sig), "lang_nl": sig.get("lang") == "nl",
    }
    for c in CATEGORIES:
        f[f"cat_{c}"] = cat == c
    return np.array([float(f[k]) for k in FEATURES])


def weak_label(lead: dict) -> int | None:
    """Simple rules to bootstrap: advertisers with a reachable business are good, no ads is bad."""
    if not lead.get("signals"):
        return 0 if (lead.get("enrich_status") or "").startswith(("failed", "error")) else None
    sig = json.loads(lead["signals"])
    n = sig.get("n_ad_platforms", 0)
    extra = (sig.get("gtm", False) + sig.get("ga4", False) * 0.5
             + (sig.get("platform") in ("shopify", "woocommerce", "lightspeed", "magento"))
             + bool(sig.get("best_email")) * 0.5 + (len(sig.get("socials", {})) >= 2) * 0.5)
    if n >= 2 or (n == 1 and extra >= 1):
        return 1
    if n == 0 and extra <= 1:
        return 0
    return None


def training_set(conn):
    rows = conn.execute("SELECT * FROM leads WHERE status != 'deleted'").fetchall()
    by_id = {r["id"]: dict(r) for r in rows}
    labels: dict[int, tuple[int, float]] = {}
    for lead in by_id.values():
        wl = weak_label(lead)
        if wl is not None:
            labels[lead["id"]] = (wl, WEIGHTS["weak"])
    # Human labels and outcomes override weak labels; strongest source wins.
    for r in conn.execute("SELECT lead_id, label, source FROM labels ORDER BY id"):
        if r["lead_id"] not in by_id:
            continue
        w = WEIGHTS.get(r["source"], 1.0)
        prev = labels.get(r["lead_id"])
        if prev is None or prev[1] <= w or prev[1] == WEIGHTS["weak"]:
            labels[r["lead_id"]] = (int(r["label"]), w)
    ids = list(labels)
    X = np.array([features(by_id[i]) for i in ids]) if ids else np.zeros((0, len(FEATURES)))
    # Weak labels are only rules of thumb: soft targets keep the model from becoming 100% sure,
    # so scores stay spread out and human labels/outcomes (hard 0/1) decide the fine ranking.
    y = np.array([SOFT[labels[i][0]] if labels[i][1] == WEIGHTS["weak"] else labels[i][0] for i in ids], float)
    w = np.array([labels[i][1] for i in ids])
    return X, y, w


def train(conn) -> LogisticRegression | None:
    X, y, w = training_set(conn)
    if len(y) < 4 or len({round(v) for v in y.tolist()}) < 2:
        print("Nog te weinig gelabelde leads (beide klassen nodig). Score valt terug op regels.")
        return None
    m = LogisticRegression(l2=max(5.0, 0.02 * len(y))).fit(X, y, sample_weight=w, feature_names=FEATURES)
    save(m, MODEL_PATH)
    acc = ((m.predict_proba(X) > 0.5) == (y > 0.5)).mean()
    n_human = int((w >= 1.0).sum())
    print(f"Model getraind op {len(y)} leads ({n_human} met menselijk label/uitkomst), "
          f"train-accuracy {acc:.0%}")
    return m


def load_model():
    return load(MODEL_PATH) if MODEL_PATH.exists() else None


def rule_proba(x: np.ndarray) -> float:
    f = dict(zip(FEATURES, x))
    z = -2.0 + 1.6 * f["n_ad_platforms"] + 0.6 * f["gtm"] + 0.3 * f["ga4"] + 0.6 * f["shop_platform"] \
        + 0.4 * f["generic_email"] + 0.3 * f["legal_entity"] + 0.15 * f["n_socials"] - 1.5 * (1 - f["fetch_ok"])
    return float(1 / (1 + np.exp(-z)))


def explain(lead: dict, x: np.ndarray, contrib: np.ndarray | None, score: float) -> list[str]:
    sig = json.loads(lead["signals"]) if lead.get("signals") else {}
    f = dict(zip(FEATURES, x))
    if not sig:
        return ["Website niet bereikbaar of nog niet bezocht"]
    texts = {}
    plats = [PLATFORM_NAMES[p] for p in sig.get("ad_platforms", [])]
    if plats:
        n = len(plats)
        texts["n_ad_platforms"] = (f"Adverteert al via {_join(plats)} "
                                   f"({n} advertentieplatform{'s' if n > 1 else ''} = meerdere dashboards)"
                                   if n > 1 else f"Adverteert al via {plats[0]} (pixel op de site)")
    else:
        texts["n_ad_platforms"] = "Geen advertentiepixels gevonden op de site"
    via = [PLATFORM_NAMES[p] for p in sig.get("pixels_via_gtm", [])]
    if plats and via:
        texts["n_ad_platforms"] += f"; {_join(via)} geladen via Google Tag Manager"
    if f["gtm"]:
        texts["gtm"] = "Gebruikt Google Tag Manager (daar zitten vaak extra advertentietags in)"
    if f["ga4"]:
        texts["ga4"] = "Meet bezoekers met Google Analytics 4"
    if f["shop_platform"]:
        texts["shop_platform"] = f"Webshop op {sig.get('platform', '').capitalize()}" + (
            " met winkelwagen" if f["cart"] else "")
    elif f["cart"]:
        texts["cart"] = "Verkoopt online (winkelwagen/checkout gevonden)"
    if f["legal_entity"]:
        texts["legal_entity"] = f"Rechtspersoon ({sig.get('legal_form')}): mailen mag, met opt-out"
    else:
        lf = sig.get("legal_form")
        texts["legal_entity"] = (f"{lf}: geen cold e-mail, via LinkedIn/contactformulier" if lf
                                 else "Geen rechtsvorm gevonden: via LinkedIn/contactformulier")
    if f["generic_email"]:
        texts["generic_email"] = f"Algemeen e-mailadres op eigen domein ({sig.get('best_email')})"
    if f["n_socials"] >= 2:
        texts["n_socials"] = f"Actief op {int(f['n_socials'])} sociale kanalen"
    group = {"meta": "n_ad_platforms", "google_ads": "n_ad_platforms", "tiktok": "n_ad_platforms",
             "pinterest": "n_ad_platforms", "snapchat": "n_ad_platforms", "cart": "shop_platform",
             "any_email": "generic_email", "linkedin": "n_socials", "instagram": "n_socials"}
    if contrib is None:
        contrib = np.array([{"n_ad_platforms": 3, "gtm": 1, "shop_platform": 1, "generic_email": 0.5,
                             "legal_entity": 0.4, "n_socials": 0.3, "ga4": 0.3}.get(k, 0) *
                            (1 if x[i] else -1) for i, k in enumerate(FEATURES)])
    agg: dict[str, float] = {}
    for i, k in enumerate(FEATURES):
        key = group.get(k, k)
        agg[key] = agg.get(key, 0.0) + float(contrib[i])
    if not plats:
        agg["n_ad_platforms"] = min(agg.get("n_ad_platforms", 0), -0.5)
    ordered = sorted((k for k in agg if k in texts), key=lambda k: -agg[k])
    pos = [k for k in ordered if agg[k] > 0]
    neg = [k for k in reversed(ordered) if agg[k] <= 0]
    picks = pos[:3] if score >= 50 else pos[:1] + neg[:2]
    if len(picks) < 2:
        picks += [k for k in neg + pos if k not in picks][: 2 - len(picks)]
    return [texts[k] for k in picks[:3]]


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " en " + items[-1]


def score_all(conn) -> int:
    model = load_model()
    rows = conn.execute("SELECT * FROM leads WHERE status != 'deleted'").fetchall()
    for r in rows:
        lead = dict(r)
        x = features(lead)
        if model is not None:
            p = float(model.predict_proba(x)[0])
            contrib = model.contributions(x)
        else:
            p, contrib = rule_proba(x), None
        score = round(100 * p, 1)
        reasons = explain(lead, x, contrib, score)
        conn.execute("UPDATE leads SET score=?, reasons=?, uncertainty=? WHERE id=?",
                     (score, json.dumps(reasons, ensure_ascii=False), abs(p - 0.5), lead["id"]))
    conn.commit()
    return len(rows)


def least_certain(conn, n: int = 10) -> list[dict]:
    """Active learning: enriched, unlabeled leads closest to p=0.5."""
    rows = conn.execute(
        """SELECT * FROM leads WHERE status != 'deleted' AND signals IS NOT NULL
           AND id NOT IN (SELECT lead_id FROM labels WHERE source='human')
           ORDER BY uncertainty ASC, score DESC LIMIT ?""", (n,)).fetchall()
    return [dict(r) for r in rows]


def add_label(conn, lead_id: int, label: int, source: str = "human") -> None:
    conn.execute("INSERT INTO labels (lead_id, label, source, weight, created_at) VALUES (?,?,?,?,?)",
                 (lead_id, int(label), source, WEIGHTS.get(source, 1.0), db.now()))
    conn.commit()


OUTCOMES = {"replied": 1, "demo": 1, "bought": 1, "negative": 0}


def record_outcome(conn, lead_id: int, outcome: str) -> None:
    add_label(conn, lead_id, OUTCOMES[outcome], source=outcome)
    status = {"replied": "replied", "demo": "demo_booked", "bought": "customer", "negative": "not_interested"}
    conn.execute("UPDATE leads SET status=? WHERE id=?", (status[outcome], lead_id))
    conn.commit()
    db.log_event(conn, f"outcome_{outcome}", lead_id=lead_id)
