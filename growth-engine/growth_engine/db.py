"""SQLite storage. Only public business data is stored."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import DATA_DIR

SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    osm_id TEXT UNIQUE,
    name TEXT,
    website TEXT,
    domain TEXT,
    city TEXT,
    country TEXT,
    category TEXT,
    osm_tags TEXT,
    osm_email TEXT,
    osm_phone TEXT,
    collected_at TEXT,
    enriched_at TEXT,
    enrich_status TEXT,
    signals TEXT,
    email TEXT,
    legal_form TEXT,
    channel TEXT,
    score REAL,
    reasons TEXT,
    uncertainty REAL,
    status TEXT DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(domain);
CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    label INTEGER,
    source TEXT,
    weight REAL,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS optout (
    value TEXT PRIMARY KEY,
    kind TEXT,
    reason TEXT,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    channel TEXT,
    kind TEXT,
    step INTEGER DEFAULT 0,
    to_addr TEXT,
    subject TEXT,
    body TEXT,
    original_body TEXT,
    prompt TEXT,
    generator TEXT,
    status TEXT DEFAULT 'draft',
    due_date TEXT,
    message_id TEXT,
    in_reply_to TEXT,
    created_at TEXT,
    approved_at TEXT,
    sent_at TEXT,
    error TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT,
    kind TEXT,
    lead_id INTEGER,
    message_id INTEGER,
    detail TEXT
);
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week TEXT,
    date TEXT,
    platform TEXT,
    format TEXT,
    kind TEXT,
    spec TEXT,
    caption TEXT,
    media TEXT,
    status TEXT DEFAULT 'draft',
    external_id TEXT,
    created_at TEXT,
    approved_at TEXT,
    published_at TEXT,
    error TEXT
);
CREATE TABLE IF NOT EXISTS post_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER,
    reach INTEGER,
    likes INTEGER,
    comments INTEGER,
    saves INTEGER,
    shares INTEGER,
    clicks INTEGER,
    recorded_at TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    path = Path(path) if path else DATA_DIR / "growth.db"
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def log_event(conn, kind: str, lead_id=None, message_id=None, detail=None) -> None:
    conn.execute(
        "INSERT INTO events (ts, kind, lead_id, message_id, detail) VALUES (?,?,?,?,?)",
        (now(), kind, lead_id, message_id, json.dumps(detail, ensure_ascii=False) if detail is not None else None),
    )
    conn.commit()


def is_opted_out(conn, email: str | None = None, domain: str | None = None) -> bool:
    values = [v.lower() for v in (email, domain) if v]
    if email and "@" in email:
        values.append(email.split("@", 1)[1].lower())
    if not values:
        return False
    q = "SELECT 1 FROM optout WHERE value IN (%s) LIMIT 1" % ",".join("?" * len(values))
    return conn.execute(q, values).fetchone() is not None


def add_optout(conn, value: str, kind: str = "email", reason: str = "") -> None:
    conn.execute(
        "INSERT OR IGNORE INTO optout (value, kind, reason, created_at) VALUES (?,?,?,?)",
        (value.strip().lower(), kind, reason, now()),
    )
    conn.commit()


def lead_signals(row) -> dict:
    return json.loads(row["signals"]) if row["signals"] else {}
