import email
import json
from datetime import date

from growth_engine import db, mailer, outreach
from growth_engine.dashboard import create_app
from growth_engine.llm import violations
from growth_engine.training_data import examples
from tests.test_scoring import _lead, sig


class NoLLM:
    def model(self):
        return None

    def chat(self, *a, **k):
        return None


class FakeLLM(NoLLM):
    def __init__(self, outputs):
        self.outputs = list(outputs)

    def model(self):
        return "fake"

    def chat(self, *a, **k):
        return self.outputs.pop(0) if self.outputs else None


def _email_lead(conn, name="Shop A", ads=("meta", "google_ads"), legal="B.V."):
    lid = _lead(conn, name, sig(ads, email=f"info@{name.lower().replace(' ', '')}.nl", legal=legal))
    ch = "email" if legal == "B.V." else "linkedin_of_contactformulier"
    conn.execute("UPDATE leads SET email=?, channel=?, score=80 WHERE id=?",
                 (f"info@{name.lower().replace(' ', '')}.nl", ch, lid))
    conn.commit()
    return dict(conn.execute("SELECT * FROM leads WHERE id=?", (lid,)).fetchone())


def test_template_email_rules(conn, cfg):
    lead = _email_lead(conn)
    body = outreach.template_email(lead, cfg)
    assert "Meta en Google Ads" in body
    assert cfg["outreach"]["demo_url"] in body
    assert violations(body, cfg["outreach"]["max_words"]) == []
    full = outreach.finalize_email(body, cfg)
    assert "Antwoord met 'stop'" in full


def test_llm_output_with_cliche_falls_back(conn, cfg):
    lead = _email_lead(conn)
    bad = "Hoi! 🚀 Wij gaan jouw advertenties naar een hoger niveau tillen, een echte game-changer."
    prompt, text, gen = outreach.write_message(conn, cfg, lead, FakeLLM([bad, bad, bad]))
    assert gen == "template"
    good = "Hoi Shop A,\n\nIk zag dat jullie via Meta en Google adverteren. Met OrivenAI zie je dat op één scherm. Demo: https://orivenai.com/demo\n\nAlec"
    prompt, text, gen = outreach.write_message(conn, cfg, lead, FakeLLM([good]))
    assert gen == "fake" and text.startswith("Hoi Shop A")


def test_linkedin_channel_never_gets_email_address(conn, cfg):
    lead = _email_lead(conn, "Kapper B", legal="Eenmanszaak")
    mid = outreach.create_draft(conn, cfg, lead, NoLLM())
    m = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
    assert m["channel"] == "linkedin_of_contactformulier" and m["to_addr"] is None and m["subject"] is None


def test_optout_blocks_draft(conn, cfg):
    lead = _email_lead(conn)
    db.add_optout(conn, lead["email"])
    assert outreach.create_draft(conn, cfg, lead, NoLLM()) is None


def test_business_days():
    assert mailer.add_business_days(date(2026, 11, 20), 3) == date(2026, 11, 25)  # Fri + 3 = Wed
    assert mailer.add_business_days(date(2026, 11, 16), 7) == date(2026, 11, 25)


class FakeSMTP:
    def __init__(self):
        self.sent = []

    def send_message(self, m):
        self.sent.append(m)

    def quit(self):
        pass


def test_send_only_approved_with_cap_and_followups(conn, cfg, monkeypatch):
    monkeypatch.setenv("ZOHO_USER", "test@orivenai.com")
    monkeypatch.setenv("ZOHO_APP_PASSWORD", "x")
    monkeypatch.setattr(outreach, "LocalLLM", lambda cfg: NoLLM())
    cfg = json.loads(json.dumps(cfg))
    cfg["outreach"]["daily_cap"] = 2
    ids = [outreach.create_draft(conn, cfg, _email_lead(conn, n), NoLLM()) for n in ("Shop A", "Shop B", "Shop C")]
    smtp = FakeSMTP()
    assert mailer.send_due(conn, cfg, smtp_factory=lambda: smtp) == 0  # nothing approved yet
    for i in ids:
        conn.execute("UPDATE messages SET status='approved', approved_at=? WHERE id=?", (db.now(), i))
    conn.commit()
    assert mailer.send_due(conn, cfg, smtp_factory=lambda: smtp) == 2  # daily cap
    assert mailer.send_due(conn, cfg, smtp_factory=lambda: smtp) == 0
    m = smtp.sent[0]
    assert m["List-Unsubscribe"] and "stop" in m.get_content()
    fus = conn.execute("SELECT * FROM messages WHERE step>0 ORDER BY id").fetchall()
    assert len(fus) == 4 and all(f["status"] == "draft" and f["due_date"] for f in fus)
    assert fus[0]["in_reply_to"] == m["Message-ID"]


def _mail(frm, subject, body, in_reply_to=""):
    m = email.message.EmailMessage()
    m["From"], m["Subject"] = frm, subject
    if in_reply_to:
        m["In-Reply-To"] = in_reply_to
    m.set_content(body)
    return m


def test_classify_incoming():
    ids, addrs = {"<abc@orivenai.com>"}, {"info@shopa.nl"}
    assert mailer.classify_incoming(_mail("info@shopa.nl", "Re: x", "Leuk, vertel meer"), ids, addrs) == ("reply", "info@shopa.nl")
    assert mailer.classify_incoming(_mail("Piet <piet@shopa.nl>", "Re: x", "Stop\n\nOp ma schreef Alec:", "<abc@orivenai.com>"), ids, addrs)[0] == "optout"
    assert mailer.classify_incoming(_mail("MAILER-DAEMON@zoho.eu", "Undelivered Mail", "to info@shopa.nl failed"), ids, addrs) == ("bounce", "info@shopa.nl")
    assert mailer.classify_incoming(_mail("news@other.nl", "Nieuwsbrief", "hoi"), ids, addrs)[0] == "other"


def test_reply_stops_sequence(conn, cfg):
    lead = _email_lead(conn)
    mid = outreach.create_draft(conn, cfg, lead, NoLLM())
    mailer.handle_incoming(conn, "optout", lead["email"], lead["id"])
    assert conn.execute("SELECT status FROM messages WHERE id=?", (mid,)).fetchone()["status"] == "cancelled"
    assert db.is_opted_out(conn, lead["email"])
    assert mailer.lead_stopped(conn, lead["id"])


def test_dashboard_approve_and_edit_become_training_data(conn, cfg, tmp_path):
    lead = _email_lead(conn)
    mid = outreach.create_draft(conn, cfg, lead, NoLLM())
    app = create_app(cfg, db_path=tmp_path / "test.db").test_client()
    assert app.get("/").status_code == 200
    assert b"Shop A" in app.get("/queue").data
    edited = "Hoi Shop A,\n\nMijn eigen versie.\n\nAlec"
    r = app.post(f"/message/{mid}", data={"body": edited, "subject": "Vraag", "action": "approve"})
    assert r.status_code == 302
    row = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
    assert row["status"] == "approved" and row["body"] == edited
    ex = examples(conn)
    assert ex[0]["edited"] and ex[0]["messages"][-1]["content"] == edited
    for path in ("/label", "/posts", "/optout"):
        assert app.get(path).status_code == 200
