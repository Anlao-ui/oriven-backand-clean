"""Configuration (config.json) and secrets (.env) loading."""
from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUTPUT_DIR = ROOT / "output"
MODELS_DIR = ROOT / "models"
ASSETS_DIR = ROOT / "assets"


def load_env(path: Path | None = None) -> None:
    """Minimal .env parser (KEY=VALUE lines); does not override real env vars."""
    path = path or ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def load_config(path: Path | None = None) -> dict:
    load_env()
    path = path or Path(os.environ.get("GROWTH_CONFIG", ROOT / "config.json"))
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def secret(name: str) -> str | None:
    load_env()
    value = os.environ.get(name)
    return value or None


def user_agent(cfg: dict) -> str:
    contact = secret("ZOHO_USER") or cfg["crawler"].get("contact_url", "https://orivenai.com")
    return f"OrivenAI-GrowthEngine/0.1 (+https://orivenai.com; contact: {contact})"
