"""Turn approved / edited messages into a chat-format dataset for the QLoRA fine-tune."""
from __future__ import annotations

import json

from .config import DATA_DIR, load_config
from .outreach import SYSTEM_NL, strip_footer


def examples(conn) -> list[dict]:
    cfg = load_config()
    o = cfg["outreach"]
    system = SYSTEM_NL.format(sender=o["sender_name"], sender_first=o["sender_name"].split()[0],
                              trial=o["trial_text"], demo=o["demo_url"], max_words=o["max_words"])
    rows = conn.execute("SELECT prompt, body, original_body, channel FROM messages WHERE step=0 "
                        "AND status IN ('approved','sent') AND prompt IS NOT NULL").fetchall()
    out = []
    for r in rows:
        out.append({"messages": [{"role": "system", "content": system},
                                 {"role": "user", "content": r["prompt"]},
                                 {"role": "assistant", "content": strip_footer(r["body"])}],
                    "edited": r["body"] != r["original_body"], "channel": r["channel"]})
    return out


def export_dataset(conn):
    path = DATA_DIR / "training" / "messages.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    ex = examples(conn)
    with open(path, "w", encoding="utf-8") as fh:
        for e in ex:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    return path, len(ex)
