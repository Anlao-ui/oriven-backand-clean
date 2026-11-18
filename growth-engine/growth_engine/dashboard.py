"""Local dashboard on localhost: leads, labeling, approval queues for messages and posts."""
from __future__ import annotations

import json

from flask import Flask, abort, redirect, render_template_string, request, send_file, url_for

from . import db
from .config import OUTPUT_DIR, load_config

BASE = """<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Growth Engine</title>
<style>
:root{--bg:#0A0A0A;--raised:#141414;--ink:#F0F0F0;--muted:#A6AA9F;--line:#262626;--lime:#EAFD13;--onlime:#0B0C0A}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif}
nav{display:flex;gap:18px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
nav a{color:var(--muted);text-decoration:none}nav a.on,nav a:hover{color:var(--lime)}
main{padding:20px;max-width:1200px;margin:auto}h1{font-size:20px;margin:0 0 14px}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:500}a{color:var(--ink)}.muted{color:var(--muted)}
.card{background:var(--raised);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.score{font-family:ui-monospace,monospace;color:var(--lime)}
button,.btn{background:var(--lime);color:var(--onlime);border:0;border-radius:6px;padding:7px 14px;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
textarea,input{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:8px;font:inherit}
textarea{min-height:200px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:1px 8px;margin:2px;color:var(--muted);font-size:12px}
img.prev,video.prev{max-width:260px;border:1px solid var(--line);border-radius:8px}
ul{margin:4px 0;padding-left:18px}
</style></head><body><nav>
<a href="/" class="{{'on' if page=='leads'}}">Leads</a><a href="/label" class="{{'on' if page=='label'}}">Labelen</a>
<a href="/queue" class="{{'on' if page=='queue'}}">Wachtrij berichten ({{counts.msgs}})</a>
<a href="/posts" class="{{'on' if page=='posts'}}">Wachtrij posts ({{counts.posts}})</a>
<a href="/optout" class="{{'on' if page=='optout'}}">Opt-out</a></nav><main>{{body|safe}}</main></body></html>"""

LEADS = """<h1>Leads <span class="muted">({{rows|length}} getoond)</span></h1>
<form class="row" method="get"><input name="q" value="{{q}}" placeholder="zoek naam/plaats" style="max-width:260px">
<input name="min" value="{{minscore}}" placeholder="min score" style="max-width:110px"><button>Filter</button></form><br>
<table><tr><th>Score</th><th>Bedrijf</th><th>Waarom</th><th>Kanaal</th><th>Status</th><th></th></tr>
{% for r in rows %}<tr><td class="score">{{'%.0f'|format(r.score or 0)}}</td>
<td><b>{{r.name}}</b><br><span class="muted">{{r.city}} · {{r.category}}</span><br><a href="{{r.website}}" target="_blank">{{r.domain}}</a></td>
<td><ul>{% for t in r.reasons %}<li>{{t}}</li>{% endfor %}</ul></td>
<td>{{r.channel}}<br><span class="muted">{{r.email or ''}}</span></td><td>{{r.status}}</td>
<td><form method="post" action="/lead/{{r.id}}/outcome" class="row">
<select name="outcome"><option value="">uitkomst…</option><option>replied</option><option>demo</option><option>bought</option><option>negative</option></select>
<button class="ghost">Opslaan</button></form></td></tr>{% endfor %}</table>"""

LABEL = """<h1>Labelen <span class="muted">— leads waar het model het minst zeker over is</span></h1>
{% if lead %}<div class="card"><div class="row"><h2 style="margin:0">{{lead.name}}</h2><span class="score">score {{lead.score}}</span></div>
<p class="muted">{{lead.city}} · {{lead.category}} · <a href="{{lead.website}}" target="_blank">{{lead.website}}</a></p>
<p>{{sig.title or ''}}<br><span class="muted">{{sig.description or ''}}</span></p>
<p>{% for p in sig.ad_platforms %}<span class="pill">{{p}}</span>{% else %}<span class="pill">geen ad-pixels</span>{% endfor %}
<span class="pill">platform: {{sig.platform or '-'}}</span><span class="pill">GTM: {{'ja' if sig.gtm else 'nee'}}</span>
<span class="pill">rechtsvorm: {{sig.legal_form or '?'}}</span><span class="pill">e-mail: {{sig.best_email or '-'}}</span></p>
<ul>{% for t in reasons %}<li>{{t}}</li>{% endfor %}</ul>
<form method="post" class="row"><input type="hidden" name="lead_id" value="{{lead.id}}">
<button name="label" value="1">Goede lead</button><button class="ghost" name="label" value="0">Slechte lead</button>
<button class="ghost" name="label" value="skip">Overslaan</button></form></div>
<p class="muted">{{n_labels}} labels gegeven. Elke 5 labels traint het model opnieuw.</p>
{% else %}<p>Niets meer te labelen.</p>{% endif %}"""

QUEUE = """<h1>Wachtrij berichten</h1><p class="muted">Niets gaat de deur uit zonder jouw OK. Aanpassingen worden trainingsdata.</p>
{% for m in msgs %}<div class="card"><div class="row"><b>{{m.name}}</b><span class="pill">{{m.channel}}</span>
<span class="pill">{{m.kind}}</span><span class="pill">score {{'%.0f'|format(m.score or 0)}}</span><span class="pill">{{m.generator}}</span>
{% if m.due_date %}<span class="pill">vanaf {{m.due_date}}</span>{% endif %}</div>
<p class="muted">{{m.to_addr or 'Zelf versturen via LinkedIn / contactformulier'}} · <a href="{{m.website}}" target="_blank">{{m.website}}</a></p>
<form method="post" action="/message/{{m.id}}">{% if m.subject %}<input name="subject" value="{{m.subject}}"><br><br>{% endif %}
<textarea name="body">{{m.body}}</textarea><br><br><div class="row">
<button name="action" value="approve">Goedkeuren</button><button class="ghost" name="action" value="save">Opslaan</button>
<button class="ghost" name="action" value="reject">Afwijzen</button></div></form></div>{% else %}<p>Geen concepten.</p>{% endfor %}
<h1>Goedgekeurd, nog niet verstuurd</h1><table>{% for m in approved %}<tr><td>{{m.name}}</td><td>{{m.kind}}</td><td>{{m.channel}}</td><td>{{m.due_date or 'direct'}}</td></tr>{% endfor %}</table>"""

POSTS = """<h1>Wachtrij posts</h1>{% for p in posts %}<div class="card"><div class="row"><b>{{p.date}}</b>
<span class="pill">{{p.platform}}</span><span class="pill">{{p.format}}</span><span class="pill">{{p.status}}</span></div><br>
<div class="row" style="align-items:flex-start">{% for f in p.files %}{% if f.endswith('.mp4') %}
<video class="prev" src="/media?p={{f}}" controls muted></video>{% else %}<img class="prev" src="/media?p={{f}}">{% endif %}{% endfor %}</div>
<form method="post" action="/post/{{p.id}}"><br><textarea name="caption" style="min-height:120px">{{p.caption}}</textarea><br><br>
<div class="row"><button name="action" value="approve">Goedkeuren</button><button class="ghost" name="action" value="save">Opslaan</button>
<button class="ghost" name="action" value="reject">Afwijzen</button></div></form></div>{% else %}<p>Geen posts in de wachtrij.</p>{% endfor %}"""

OPTOUT = """<h1>Opt-out lijst</h1><form method="post" class="row"><input name="value" placeholder="e-mail of domein" style="max-width:320px">
<button>Toevoegen</button></form><br><table>{% for r in rows %}<tr><td>{{r.value}}</td><td>{{r.kind}}</td><td>{{r.reason}}</td><td>{{r.created_at}}</td></tr>{% endfor %}</table>"""


def create_app(cfg: dict | None = None, db_path=None) -> Flask:
    cfg = cfg or load_config()
    app = Flask(__name__)

    def conn():
        return db.connect(db_path)

    def page(name, tpl, **kw):
        c = conn()
        counts = {"msgs": c.execute("SELECT COUNT(*) n FROM messages WHERE status='draft'").fetchone()["n"],
                  "posts": c.execute("SELECT COUNT(*) n FROM posts WHERE status='draft'").fetchone()["n"]}
        body = render_template_string(tpl, **kw)
        return render_template_string(BASE, body=body, page=name, counts=counts)

    @app.get("/")
    def leads():
        c = conn()
        q = request.args.get("q", "").strip()
        minscore = request.args.get("min", "")
        sql = "SELECT * FROM leads WHERE status!='deleted' AND score IS NOT NULL"
        args = []
        if q:
            sql += " AND (name LIKE ? OR city LIKE ? OR domain LIKE ?)"
            args += [f"%{q}%"] * 3
        if minscore:
            sql += " AND score >= ?"
            args.append(float(minscore))
        rows = []
        for r in c.execute(sql + " ORDER BY score DESC LIMIT 300", args):
            d = dict(r); d["reasons"] = json.loads(r["reasons"] or "[]"); rows.append(d)
        return page("leads", LEADS, rows=rows, q=q, minscore=minscore)

    @app.route("/label", methods=["GET", "POST"])
    def label():
        from .scoring import add_label, least_certain, score_all, train
        c = conn()
        if request.method == "POST":
            lid = int(request.form["lead_id"])
            v = request.form["label"]
            if v == "skip":
                c.execute("UPDATE leads SET uncertainty=1 WHERE id=?", (lid,)); c.commit()
            else:
                add_label(c, lid, int(v))
                n = c.execute("SELECT COUNT(*) n FROM labels WHERE source='human'").fetchone()["n"]
                if n % 5 == 0:
                    train(c); score_all(c)
            return redirect(url_for("label"))
        batch = least_certain(c, 1)
        lead = batch[0] if batch else None
        n_labels = c.execute("SELECT COUNT(*) n FROM labels WHERE source='human'").fetchone()["n"]
        return page("label", LABEL, lead=lead, sig=json.loads(lead["signals"]) if lead else {},
                    reasons=json.loads(lead["reasons"] or "[]") if lead else [], n_labels=n_labels)

    @app.post("/lead/<int:lid>/outcome")
    def outcome(lid):
        from .scoring import record_outcome
        o = request.form.get("outcome")
        if o:
            record_outcome(conn(), lid, o)
        return redirect(request.referrer or "/")

    @app.get("/queue")
    def queue():
        c = conn()
        msgs = c.execute("""SELECT m.*, l.name, l.website, l.score FROM messages m JOIN leads l ON l.id=m.lead_id
                            WHERE m.status='draft' ORDER BY m.step, l.score DESC""").fetchall()
        approved = c.execute("""SELECT m.*, l.name FROM messages m JOIN leads l ON l.id=m.lead_id
                                WHERE m.status='approved' ORDER BY m.due_date""").fetchall()
        return page("queue", QUEUE, msgs=msgs, approved=approved)

    @app.post("/message/<int:mid>")
    def message(mid):
        c = conn()
        if not c.execute("SELECT 1 FROM messages WHERE id=?", (mid,)).fetchone():
            abort(404)
        body = request.form.get("body", "").replace("\r\n", "\n").strip()
        subject = request.form.get("subject")
        action = request.form["action"]
        if subject is not None:
            c.execute("UPDATE messages SET subject=? WHERE id=?", (subject.strip(), mid))
        c.execute("UPDATE messages SET body=? WHERE id=?", (body, mid))
        if action == "approve":
            c.execute("UPDATE messages SET status='approved', approved_at=? WHERE id=?", (db.now(), mid))
        elif action == "reject":
            c.execute("UPDATE messages SET status='rejected' WHERE id=?", (mid,))
        c.commit()
        db.log_event(c, f"message_{action}", message_id=mid)
        return redirect(url_for("queue"))

    @app.get("/posts")
    def posts():
        c = conn()
        rows = []
        for r in c.execute("SELECT * FROM posts WHERE status IN ('draft','approved') ORDER BY date, platform"):
            d = dict(r); d["files"] = json.loads(r["media"] or "[]"); rows.append(d)
        return page("posts", POSTS, posts=rows)

    @app.post("/post/<int:pid>")
    def post(pid):
        c = conn()
        action = request.form["action"]
        c.execute("UPDATE posts SET caption=? WHERE id=?", (request.form.get("caption", "").replace("\r\n", "\n"), pid))
        if action == "approve":
            c.execute("UPDATE posts SET status='approved', approved_at=? WHERE id=?", (db.now(), pid))
        elif action == "reject":
            c.execute("UPDATE posts SET status='rejected' WHERE id=?", (pid,))
        c.commit()
        return redirect(url_for("posts"))

    @app.get("/media")
    def media():
        from pathlib import Path
        p = Path(request.args["p"]).resolve()
        if OUTPUT_DIR.resolve() not in p.parents or not p.exists():
            abort(404)
        return send_file(p)

    @app.route("/optout", methods=["GET", "POST"])
    def optout():
        c = conn()
        if request.method == "POST" and request.form.get("value"):
            v = request.form["value"].strip()
            db.add_optout(c, v, "email" if "@" in v else "domain", "dashboard")
            return redirect(url_for("optout"))
        rows = c.execute("SELECT * FROM optout ORDER BY created_at DESC").fetchall()
        return page("optout", OPTOUT, rows=rows)

    return app


def run(cfg: dict) -> None:
    d = cfg["dashboard"]
    print(f"Dashboard: http://{d['host']}:{d['port']}")
    create_app(cfg).run(host=d["host"], port=d["port"], debug=False)
