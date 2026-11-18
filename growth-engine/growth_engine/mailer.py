"""Zoho SMTP sending with daily cap and follow-ups; Zoho IMAP for replies, bounces and opt-outs."""
from __future__ import annotations

import email
import email.utils
import imaplib
import re
import smtplib
import ssl
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage

from . import db
from .config import DATA_DIR, secret

STOP_WORDS = re.compile(r"^\s*(stop|afmelden|uitschrijven|unsubscribe|geen interesse|niet geïnteresseerd|"
                        r"verwijder)", re.I | re.M)
BOUNCE_FROM = re.compile(r"mailer-daemon|postmaster|mail delivery", re.I)
BOUNCE_SUBJ = re.compile(r"undeliver|delivery status|returned mail|failure notice|niet bezorgd|onbestelbaar", re.I)


def add_business_days(d: date, n: int) -> date:
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def sent_today(conn) -> int:
    today = date.today().isoformat()
    return conn.execute("SELECT COUNT(*) c FROM messages WHERE status='sent' AND channel='email' "
                        "AND substr(sent_at,1,10)=?", (today,)).fetchone()["c"]


def lead_stopped(conn, lead_id: int) -> bool:
    row = conn.execute("SELECT status, email, domain FROM leads WHERE id=?", (lead_id,)).fetchone()
    if row is None:
        return True
    if row["status"] in ("replied", "bounced", "opted_out", "not_interested", "demo_booked", "customer", "deleted"):
        return True
    return db.is_opted_out(conn, row["email"], row["domain"])


def build_message(cfg: dict, msg_row, from_addr: str) -> EmailMessage:
    m = EmailMessage()
    m["From"] = email.utils.formataddr((f"{cfg['outreach']['sender_name']} | OrivenAI", from_addr))
    m["To"] = msg_row["to_addr"]
    m["Subject"] = msg_row["subject"]
    m["Date"] = email.utils.formatdate(localtime=True)
    domain = from_addr.split("@", 1)[1]
    m["Message-ID"] = email.utils.make_msgid(domain=domain)
    m["List-Unsubscribe"] = f"<mailto:{from_addr}?subject=stop>"
    if msg_row["in_reply_to"]:
        m["In-Reply-To"] = msg_row["in_reply_to"]
        m["References"] = msg_row["in_reply_to"]
    m.set_content(msg_row["body"])
    return m


def schedule_followups(conn, cfg: dict, initial_id: int) -> None:
    """Create follow-up drafts (+3 / +7 business days). They still need your approval."""
    from .outreach import followup_body
    init = conn.execute("SELECT * FROM messages WHERE id=?", (initial_id,)).fetchone()
    lead = dict(conn.execute("SELECT * FROM leads WHERE id=?", (init["lead_id"],)).fetchone())
    base = date.today()
    for step, days in enumerate(cfg["outreach"]["followup_business_days"], 1):
        body, gen = followup_body(conn, cfg, lead, step)
        subj = init["subject"] if init["subject"].lower().startswith("re:") else f"Re: {init['subject']}"
        conn.execute(
            """INSERT INTO messages (lead_id, channel, kind, step, to_addr, subject, body, original_body,
               generator, status, due_date, in_reply_to, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (lead["id"], "email", f"followup{step}", step, init["to_addr"], subj, body, body, gen, "draft",
             add_business_days(base, days).isoformat(), init["message_id"], db.now()))
    conn.commit()


def _log_file(line: str) -> None:
    path = DATA_DIR / "logs" / "send.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"{datetime.now().isoformat(timespec='seconds')} {line}\n")


def send_due(conn, cfg: dict, dry_run: bool = False, smtp_factory=None) -> int:
    o = cfg["outreach"]
    user, pwd = secret("ZOHO_USER"), secret("ZOHO_APP_PASSWORD")
    if not dry_run and not (user and pwd):
        print("ZOHO_USER / ZOHO_APP_PASSWORD ontbreken in .env — er wordt niets verstuurd.")
        return 0
    room = o["daily_cap"] - sent_today(conn)
    if room <= 0:
        print(f"Daglimiet van {o['daily_cap']} bereikt.")
        return 0
    today = date.today().isoformat()
    rows = conn.execute(
        """SELECT * FROM messages WHERE status='approved' AND channel='email'
           AND (due_date IS NULL OR due_date <= ?) ORDER BY step, approved_at LIMIT ?""", (today, room)).fetchall()
    if not rows:
        print("Geen goedgekeurde mails die vandaag weg mogen.")
        return 0
    smtp = None
    sent = 0
    try:
        for r in rows:
            if lead_stopped(conn, r["lead_id"]) or db.is_opted_out(conn, r["to_addr"]):
                conn.execute("UPDATE messages SET status='cancelled', error='lead gestopt/opt-out' WHERE id=?", (r["id"],))
                conn.commit()
                continue
            msg = build_message(cfg, r, user or "test@orivenai.com")
            if dry_run:
                print(f"[dry-run] naar {r['to_addr']}: {r['subject']}")
                continue
            if smtp is None:
                smtp = smtp_factory() if smtp_factory else smtplib.SMTP_SSL(
                    o["smtp_host"], o["smtp_port"], context=ssl.create_default_context(), timeout=30)
                if not smtp_factory:
                    smtp.login(user, pwd)
            try:
                smtp.send_message(msg)
            except smtplib.SMTPException as exc:
                conn.execute("UPDATE messages SET status='failed', error=? WHERE id=?", (str(exc)[:300], r["id"]))
                conn.commit()
                _log_file(f"FAILED msg={r['id']} to={r['to_addr']} {exc}")
                continue
            conn.execute("UPDATE messages SET status='sent', sent_at=?, message_id=? WHERE id=?",
                         (db.now(), msg["Message-ID"], r["id"]))
            conn.execute("UPDATE leads SET status='contacted' WHERE id=? AND status='new'", (r["lead_id"],))
            conn.commit()
            db.log_event(conn, "sent", lead_id=r["lead_id"], message_id=r["id"], detail={"to": r["to_addr"]})
            _log_file(f"SENT msg={r['id']} to={r['to_addr']} subject={r['subject']!r}")
            if r["step"] == 0:
                schedule_followups(conn, cfg, r["id"])
            sent += 1
    finally:
        if smtp is not None:
            try:
                smtp.quit()
            except Exception:
                pass
    print(f"{sent} mail(s) verstuurd (limiet {o['daily_cap']}/dag)")
    return sent


def _body_text(m: email.message.Message) -> str:
    parts = []
    for part in m.walk() if m.is_multipart() else [m]:
        if part.get_content_type() in ("text/plain", "message/delivery-status", "text/rfc822-headers"):
            try:
                parts.append(part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace"))
            except Exception:
                pass
    return "\n".join(parts)


def classify_incoming(m: email.message.Message, our_ids: set[str], known_addrs: set[str]) -> tuple[str, str | None]:
    """Returns (kind, address): kind in reply/optout/bounce/other."""
    from_addr = email.utils.parseaddr(m.get("From", ""))[1].lower()
    subject = m.get("Subject", "")
    body = _body_text(m)
    if BOUNCE_FROM.search(m.get("From", "")) or BOUNCE_SUBJ.search(subject):
        for addr in re.findall(r"[\w.+\-]+@[\w.\-]+\.\w+", body):
            if addr.lower() in known_addrs:
                return "bounce", addr.lower()
        return "bounce", None
    refs = set(re.findall(r"<[^>]+>", (m.get("In-Reply-To", "") + " " + m.get("References", ""))))
    if refs & our_ids or from_addr in known_addrs:
        reply_part = re.split(r"\n(?:Op .+ schreef|On .+ wrote|-----Original|> )", body, maxsplit=1)[0]
        if STOP_WORDS.search(reply_part) or re.search(r"\bstop\b", subject, re.I):
            return "optout", from_addr
        return "reply", from_addr
    return "other", from_addr


def check_inbox(conn, cfg: dict, imap_factory=None, days: int = 14) -> dict:
    user, pwd = secret("ZOHO_USER"), secret("ZOHO_APP_PASSWORD")
    if not imap_factory and not (user and pwd):
        print("Geen Zoho-gegevens in .env: inbox niet gecontroleerd.")
        return {}
    o = cfg["outreach"]
    our_ids = {r["message_id"] for r in conn.execute("SELECT message_id FROM messages WHERE message_id IS NOT NULL")}
    addr_to_lead = {r["to_addr"].lower(): r["lead_id"] for r in
                    conn.execute("SELECT to_addr, lead_id FROM messages WHERE status='sent' AND to_addr IS NOT NULL")}
    id_to_lead = {r["message_id"]: r["lead_id"] for r in
                  conn.execute("SELECT message_id, lead_id FROM messages WHERE message_id IS NOT NULL")}
    imap = imap_factory() if imap_factory else imaplib.IMAP4_SSL(o["imap_host"], o["imap_port"])
    if not imap_factory:
        imap.login(user, pwd)
    counts = {"reply": 0, "optout": 0, "bounce": 0}
    try:
        imap.select("INBOX", readonly=True)
        since = (date.today() - timedelta(days=days)).strftime("%d-%b-%Y")
        _, data = imap.search(None, "SINCE", since)
        for num in data[0].split():
            _, msg_data = imap.fetch(num, "(RFC822)")
            m = email.message_from_bytes(msg_data[0][1])
            key = m.get("Message-ID", "")
            if conn.execute("SELECT 1 FROM events WHERE kind LIKE 'inbox_%' AND detail LIKE ?",
                            (f"%{key}%",)).fetchone():
                continue
            kind, addr = classify_incoming(m, our_ids, set(addr_to_lead))
            if kind == "other":
                continue
            lead_id = addr_to_lead.get(addr or "")
            if lead_id is None:
                for ref in re.findall(r"<[^>]+>", m.get("In-Reply-To", "") + m.get("References", "")):
                    lead_id = id_to_lead.get(ref) or lead_id
            handle_incoming(conn, kind, addr, lead_id, key)
            counts[kind] += 1
    finally:
        try:
            imap.logout()
        except Exception:
            pass
    print(f"Inbox: {counts['reply']} antwoorden, {counts['optout']} opt-outs, {counts['bounce']} bounces")
    return counts


def handle_incoming(conn, kind: str, addr: str | None, lead_id: int | None, key: str = "") -> None:
    from .scoring import add_label
    status = {"reply": "replied", "optout": "opted_out", "bounce": "bounced"}[kind]
    if kind == "optout" and addr:
        db.add_optout(conn, addr, "email", "antwoord stop")
    if lead_id:
        conn.execute("UPDATE leads SET status=? WHERE id=?", (status, lead_id))
        conn.execute("UPDATE messages SET status='cancelled', error=? WHERE lead_id=? AND status IN ('draft','approved')",
                     (f"gestopt: {status}", lead_id))
        if kind == "reply":
            add_label(conn, lead_id, 1, source="replied")
    conn.commit()
    db.log_event(conn, f"inbox_{kind}", lead_id=lead_id, detail={"from": addr, "message_id": key})
