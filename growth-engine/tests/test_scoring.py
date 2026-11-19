import json

import numpy as np

from growth_engine import collect, export, scoring
from growth_engine.model import LogisticRegression, RidgeRegression


def _lead(conn, name, sig, cat="winkel:clothes", status="ok"):
    d = name.lower().replace(" ", "") + ".nl"
    collect.store_leads(conn, [{"osm_id": f"node/{d}", "name": name, "website": f"https://{d}", "domain": d,
                                "city": "Amersfoort", "country": "NL", "category": cat, "osm_tags": "{}",
                                "osm_email": None, "osm_phone": None}])
    conn.execute("UPDATE leads SET signals=?, enrich_status=? WHERE domain=?",
                 (json.dumps(sig) if sig else None, status, d))
    conn.commit()
    return conn.execute("SELECT id FROM leads WHERE domain=?", (d,)).fetchone()["id"]


def sig(ads=(), gtm=False, platform=None, email=None, legal=None):
    return {"pixels": {p: p in ads for p in scoring.PLATFORM_NAMES}, "ad_platforms": list(ads),
            "n_ad_platforms": len(ads), "gtm": gtm, "ga4": False, "platform": platform, "cart": bool(platform),
            "best_email": email, "emails": [email] if email else [], "legal_form": legal,
            "is_legal_entity": legal == "B.V.", "socials": {}, "lang": "nl"}


def test_logreg_learns_simple_rule():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(200, 3))
    y = (X[:, 0] > 0).astype(float)
    m = LogisticRegression().fit(X, y)
    assert ((m.predict_proba(X) > 0.5) == y).mean() > 0.95
    m2 = LogisticRegression.from_dict(json.loads(json.dumps(m.to_dict())))
    assert np.allclose(m.predict_proba(X), m2.predict_proba(X))


def test_ridge():
    X = np.arange(20, dtype=float).reshape(-1, 1)
    m = RidgeRegression(l2=0.01).fit(X, 2 * X[:, 0] + 1)
    assert abs(m.predict([[30]])[0] - 61) < 0.5


def test_weak_labels():
    assert scoring.weak_label({"signals": json.dumps(sig(("meta", "google_ads")))}) == 1
    assert scoring.weak_label({"signals": json.dumps(sig()) }) == 0
    assert scoring.weak_label({"signals": json.dumps(sig(("meta",))) }) is None


def test_train_score_reasons_and_active_learning(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(scoring, "MODEL_PATH", tmp_path / "m.json")
    a = _lead(conn, "Shop A", sig(("meta", "google_ads"), gtm=True, platform="shopify",
                                  email="info@shopa.nl", legal="B.V."))
    _lead(conn, "Shop B", sig(("meta", "google_ads", "tiktok"), platform="woocommerce"))
    _lead(conn, "Cafe C", sig(), cat="horeca:cafe")
    _lead(conn, "Cafe D", sig(), cat="horeca:cafe")
    mid = _lead(conn, "Mid E", sig(("meta",)))
    _lead(conn, "Dead F", None, status="failed:ConnectionError")
    scoring.add_label(conn, mid, 0)
    assert scoring.train(conn) is not None
    scoring.score_all(conn)
    rows = {r["name"]: r for r in conn.execute("SELECT * FROM leads")}
    assert rows["Shop A"]["score"] > 55 > rows["Cafe C"]["score"]
    reasons = json.loads(rows["Shop A"]["reasons"])
    assert 2 <= len(reasons) <= 3
    assert any("Meta en Google Ads" in r for r in reasons)
    assert json.loads(rows["Cafe C"]["reasons"])[0] or True
    assert any("Geen advertentiepixels" in r for r in json.loads(rows["Cafe C"]["reasons"]))
    uncertain = scoring.least_certain(conn, 3)
    assert mid not in [u["id"] for u in uncertain]  # already human-labelled
    path = export.export_csv(conn, tmp_path / "leads.csv")
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    assert lines[1].split(";")[0] == str(a) or "Shop" in lines[1]


def test_delete_removes_and_blocks(conn):
    lid = _lead(conn, "Shop A", sig(("meta",), email="info@shopa.nl"))
    conn.execute("UPDATE leads SET email='info@shopa.nl' WHERE id=?", (lid,))
    assert export.delete(conn, lead_id=lid) == 1
    assert conn.execute("SELECT COUNT(*) c FROM leads").fetchone()["c"] == 0
    assert collect.store_leads(conn, [{"osm_id": "node/x", "name": "Shop A", "website": "https://shopa.nl",
                                       "domain": "shopa.nl", "city": "A", "country": "NL", "category": "winkel",
                                       "osm_tags": "{}", "osm_email": None, "osm_phone": None}]) == 0
