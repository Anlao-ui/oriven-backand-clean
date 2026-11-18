"""leads.csv export and GDPR delete."""
from __future__ import annotations

import csv
import json
from pathlib import Path

from . import db
from .config import ROOT

COLUMNS = ["id", "score", "name", "city", "category", "website", "channel", "email", "legal_form",
           "kvk", "ad_platforms", "platform", "gtm", "ga4", "socials", "reason_1", "reason_2", "reason_3", "status"]


def export_csv(conn, path: Path | None = None) -> Path:
    path = path or ROOT / "leads.csv"
    rows = conn.execute("SELECT * FROM leads WHERE status != 'deleted' AND score IS NOT NULL "
                        "ORDER BY score DESC").fetchall()
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:  # BOM so Excel shows é etc.
        w = csv.writer(fh, delimiter=";")
        w.writerow(COLUMNS)
        for r in rows:
            sig = json.loads(r["signals"]) if r["signals"] else {}
            reasons = (json.loads(r["reasons"]) if r["reasons"] else []) + ["", "", ""]
            w.writerow([r["id"], r["score"], r["name"], r["city"], r["category"], r["website"], r["channel"],
                        r["email"] or "", r["legal_form"] or "", sig.get("kvk") or "",
                        ",".join(sig.get("ad_platforms", [])), sig.get("platform") or "",
                        int(bool(sig.get("gtm"))), int(bool(sig.get("ga4"))),
                        " ".join(sig.get("socials", {}).values()), *reasons[:3], r["status"]])
    return path


def delete(conn, lead_id: int | None = None, domain: str | None = None, email: str | None = None) -> int:
    """Remove all data about a business and put it on the opt-out list so it is never re-collected."""
    ids = set()
    if lead_id:
        ids |= {r["id"] for r in conn.execute("SELECT id FROM leads WHERE id=?", (lead_id,))}
    if domain:
        domain = domain.lower().removeprefix("www.")
        ids |= {r["id"] for r in conn.execute("SELECT id FROM leads WHERE domain=?", (domain,))}
    if email:
        ids |= {r["id"] for r in conn.execute("SELECT id FROM leads WHERE lower(email)=?", (email.lower(),))}
        db.add_optout(conn, email, "email", "delete")
    for i in ids:
        row = conn.execute("SELECT domain, email FROM leads WHERE id=?", (i,)).fetchone()
        if row["domain"]:
            db.add_optout(conn, row["domain"], "domain", "delete")
        if row["email"]:
            db.add_optout(conn, row["email"], "email", "delete")
        conn.execute("DELETE FROM messages WHERE lead_id=?", (i,))
        conn.execute("DELETE FROM labels WHERE lead_id=?", (i,))
        conn.execute("DELETE FROM events WHERE lead_id=?", (i,))
        conn.execute("DELETE FROM leads WHERE id=?", (i,))
    if domain and not ids:
        db.add_optout(conn, domain, "domain", "delete")
    conn.commit()
    return len(ids)
