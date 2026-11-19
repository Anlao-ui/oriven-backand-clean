"""Draft personal outreach per lead. Nothing is ever sent from here: drafts go to the approval queue."""
from __future__ import annotations

import json
import re

from . import db
from .channel import EMAIL, MANUAL
from .llm import LocalLLM, clean_text, violations
from .scoring import PLATFORM_NAMES

SYSTEM_NL = """Je schrijft korte, persoonlijke e-mails in het Nederlands namens {sender} van OrivenAI.
OrivenAI is één werkplek voor advertenties van kleine bedrijven: Google, Meta, TikTok, Pinterest en Snapchat Ads
op één plek, met AI die advertenties maakt, onderzoek doet, alles in één overzicht en automatiseringen.
Aanbod: {trial}. Gratis demo zonder account: {demo}.

Regels:
- Maximaal {max_words} woorden, platte tekst, je/jij-vorm, begin met "Hoi" gevolgd door de bedrijfsnaam.
- Precies één concrete observatie over hun bedrijf (gebruik alleen de feiten die je krijgt, verzin niets).
- Eén zin over wat OrivenAI voor hén oplost.
- Eén duidelijke vraag of call-to-action naar de demo of de €1-proef.
- Geen hype, geen clichés, geen emoji, geen uitroeptekens, geen opsommingen, geen onderwerpregel.
- Sluit af met alleen de voornaam: {sender_first}. Geen handtekening, geen opt-out-zin (die voegen we zelf toe)."""

FOLLOWUP_NL = """Schrijf een korte follow-up (max 50 woorden) op je eerdere mail aan {name}. Geen schuldgevoel,
geen "even checken of je mijn mail hebt gezien". Voeg één nieuw, nuttig punt toe en herhaal de demo-link {demo}.
Sluit af met {sender_first}."""


def observation(lead: dict) -> str:
    sig = json.loads(lead["signals"]) if lead.get("signals") else {}
    plats = [PLATFORM_NAMES[p] for p in sig.get("ad_platforms", [])]
    facts = []
    if len(plats) >= 2:
        facts.append(f"ze adverteren via {', '.join(plats[:-1])} en {plats[-1]} (pixels op de site)")
    elif plats:
        facts.append(f"ze hebben de {plats[0]}-pixel op hun site staan")
    if sig.get("gtm"):
        facts.append("ze gebruiken Google Tag Manager")
    if sig.get("platform") in ("shopify", "woocommerce", "lightspeed", "magento"):
        facts.append(f"hun webshop draait op {sig['platform'].capitalize()}")
    return "; ".join(facts) or "ze hebben een eigen website"


def lead_context(lead: dict) -> str:
    sig = json.loads(lead["signals"]) if lead.get("signals") else {}
    return (f"Bedrijf: {lead['name']}\nPlaats: {lead['city']}\nBranche: {lead['category']}\n"
            f"Website: {lead['website']}\nTitel site: {sig.get('title') or '-'}\n"
            f"Observatie: {observation(lead)}")


def template_email(lead: dict, cfg: dict) -> str:
    """Deterministic fallback when the local model is unavailable or keeps breaking the rules."""
    o = cfg["outreach"]
    sig = json.loads(lead["signals"]) if lead.get("signals") else {}
    plats = [PLATFORM_NAMES[p] for p in sig.get("ad_platforms", [])]
    if len(plats) >= 2:
        obs = f"Ik zag dat {lead['name']} via {', '.join(plats[:-1])} en {plats[-1]} adverteert."
        fix = (f"Met OrivenAI zie je al die campagnes in één overzicht en maak je nieuwe advertenties "
               f"voor elk kanaal vanaf één plek, zonder te wisselen tussen {len(plats)} dashboards.")
    elif plats:
        obs = f"Ik zag dat {lead['name']} de {plats[0]}-pixel op de site heeft staan, dus jullie adverteren al."
        fix = ("Met OrivenAI maak en beheer je die advertenties vanaf één plek, en kun je met één klik ook "
               "Google of TikTok testen zonder een nieuw account te leren.")
    else:
        obs = f"Ik kwam {lead['name']} tegen terwijl ik naar bedrijven in {lead['city']} keek."
        fix = "OrivenAI zet je advertenties op Google, Meta en TikTok in één werkplek, met AI die de advertenties schrijft."
    first = o["sender_name"].split()[0]
    return (f"Hoi {lead['name']},\n\n{obs} {fix}\n\n"
            f"Zin om het te zien? De demo werkt zonder account: {o['demo_url']}. "
            f"Of probeer het {o['trial_text']}.\n\n{first}")


def optout_line() -> str:
    return "Liever geen mail meer van ons? Antwoord met 'stop' en je hoort niets meer."


def finalize_email(body: str, cfg: dict) -> str:
    sig = cfg["outreach"]["signature"]
    first = cfg["outreach"]["sender_name"].split()[0]
    body = body.rstrip()
    if body.endswith(first):
        body = body[: -len(first)].rstrip()
    return f"{body}\n\n{sig}\n\n{optout_line()}"


# Seed examples in the house style, used until there are approved messages of your own.
SEED_EXAMPLES = [
    ("Bedrijf: Fietsenwinkel De Spaak\nPlaats: Utrecht\nBranche: winkel:bicycle\nWebsite: https://despaak.nl\n"
     "Titel site: Fietsen en onderhoud in Utrecht\nObservatie: ze adverteren via Meta en Google Ads (pixels op de site); "
     "hun webshop draait op Woocommerce",
     "Hoi De Spaak,\n\nIk zag dat jullie zowel via Meta als Google adverteren voor de webshop. Dat betekent waarschijnlijk "
     "twee dashboards, twee keer inloggen en zelf uitzoeken welke advertentie de fietsen verkoopt.\n\n"
     "Met OrivenAI zie je alles op één scherm en maak je nieuwe advertenties voor beide kanalen tegelijk.\n\n"
     "Kijk gerust in de demo, daar heb je geen account voor nodig: {demo}\n\n{first}"),
    ("Bedrijf: Studio Noor\nPlaats: Haarlem\nBranche: winkel:beauty\nWebsite: https://studionoor.nl\n"
     "Titel site: Huidverzorging in Haarlem\nObservatie: ze hebben de Meta-pixel op hun site staan; ze gebruiken Google Tag Manager",
     "Hoi Studio Noor,\n\nJullie hebben de Meta-pixel op de site staan, dus ik neem aan dat er af en toe een campagne loopt.\n\n"
     "OrivenAI schrijft die advertenties met AI en zet ze met één klik ook op Google of TikTok, zodat je kunt zien waar je "
     "klanten echt vandaan komen.\n\nZin om het te proberen? {trial}: {demo}\n\n{first}"),
]


def seed_shots(cfg: dict) -> list[dict]:
    o = cfg["outreach"]
    out = []
    for prompt, answer in SEED_EXAMPLES:
        out += [{"role": "user", "content": prompt},
                {"role": "assistant", "content": answer.format(demo=o["demo_url"], trial=o["trial_text"].capitalize(),
                                                               first=o["sender_name"].split()[0])}]
    return out


def few_shot(conn, n: int, channel: str) -> list[dict]:
    rows = conn.execute(
        """SELECT m.prompt, m.body FROM messages m WHERE m.status IN ('approved','sent') AND m.step=0
           AND m.channel=? AND m.prompt IS NOT NULL ORDER BY m.approved_at DESC LIMIT ?""",
        (channel, n)).fetchall()
    msgs = []
    for r in reversed(rows):
        msgs += [{"role": "user", "content": r["prompt"]}, {"role": "assistant", "content": strip_footer(r["body"])}]
    return msgs


def strip_footer(body: str) -> str:
    return body.split("\n\nLiever geen mail")[0].strip()


def write_message(conn, cfg: dict, lead: dict, llm: LocalLLM | None = None, linkedin: bool = False):
    o = cfg["outreach"]
    llm = llm or LocalLLM(cfg)
    system = SYSTEM_NL.format(sender=o["sender_name"], sender_first=o["sender_name"].split()[0],
                              trial=o["trial_text"], demo=o["demo_url"],
                              max_words=60 if linkedin else o["max_words"])
    if linkedin:
        system += "\nDit is een LinkedIn-bericht of contactformulier: nog korter (max 60 woorden)."
    prompt = lead_context(lead)
    channel = MANUAL if linkedin else EMAIL
    shots = few_shot(conn, cfg["llm"]["few_shot_examples"], channel) or seed_shots(cfg)
    messages = [{"role": "system", "content": system}] + shots + [{"role": "user", "content": prompt}]
    for _ in range(3):
        out = llm.chat(messages)
        if out is None:
            break
        text = clean_text(out)
        problems = violations(text, 60 if linkedin else o["max_words"]) + structure_problems(text, lead, cfg)
        if not problems:
            return prompt, text, llm.model()
    return prompt, template_email(lead, cfg), "template"


def structure_problems(text: str, lead: dict, cfg: dict) -> list[str]:
    """Hard checks a small model tends to fail: placeholders, missing CTA, misplaced name."""
    o = cfg["outreach"]
    first = o["sender_name"].split()[0]
    out = []
    if re.search(r"[{}\[\]<>]", text):
        out.append("placeholder")
    if o["demo_url"].replace("https://", "") not in text:
        out.append("geen demo-link")
    if not re.match(r"^(hoi|hallo|beste|goedemorgen|goedemiddag)\b", text, re.I):
        out.append("geen begroeting")
    if text.count(first) != 1 or not text.rstrip().endswith(first):
        out.append("naam niet (alleen) onderaan")
    return out


def subject_for(lead: dict) -> str:
    return f"Vraag over de advertenties van {lead['name']}"[:78]


def create_draft(conn, cfg: dict, lead: dict, llm: LocalLLM | None = None) -> int | None:
    if lead.get("channel") not in (EMAIL, MANUAL):
        return None
    if db.is_opted_out(conn, lead.get("email"), lead.get("domain")):
        return None
    if conn.execute("SELECT 1 FROM messages WHERE lead_id=? AND step=0", (lead["id"],)).fetchone():
        return None
    linkedin = lead["channel"] == MANUAL
    prompt, body, gen = write_message(conn, cfg, lead, llm, linkedin=linkedin)
    full = body if linkedin else finalize_email(body, cfg)
    cur = conn.execute(
        """INSERT INTO messages (lead_id, channel, kind, step, to_addr, subject, body, original_body, prompt,
           generator, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (lead["id"], lead["channel"], "initial", 0, lead.get("email") if not linkedin else None,
         None if linkedin else subject_for(lead), full, full, prompt, gen, "draft", db.now()))
    conn.commit()
    db.log_event(conn, "draft", lead_id=lead["id"], message_id=cur.lastrowid, detail={"generator": gen})
    return cur.lastrowid


def draft_for_top(conn, cfg: dict, limit: int | None = None) -> int:
    limit = limit or cfg["outreach"]["drafts_per_week"]
    min_score = cfg["scoring"]["min_score_for_draft"]
    rows = conn.execute(
        """SELECT * FROM leads WHERE status='new' AND score >= ? AND channel IN (?,?)
           AND id NOT IN (SELECT lead_id FROM messages) ORDER BY score DESC LIMIT ?""",
        (min_score, EMAIL, MANUAL, limit)).fetchall()
    llm = LocalLLM(cfg)
    if llm.model() is None:
        print("Let op: Ollama draait niet of het model ontbreekt; concepten komen uit het sjabloon.")
    n = 0
    for r in rows:
        if create_draft(conn, cfg, dict(r), llm):
            n += 1
            print(f"  concept voor {r['name']} ({r['channel']})")
    return n


def followup_body(conn, cfg: dict, lead: dict, step: int, llm: LocalLLM | None = None) -> tuple[str, str]:
    o = cfg["outreach"]
    llm = llm or LocalLLM(cfg)
    first = o["sender_name"].split()[0]
    sys_prompt = FOLLOWUP_NL.format(name=lead["name"], demo=o["demo_url"], sender_first=first)
    out = llm.chat([{"role": "system", "content": sys_prompt}, {"role": "user", "content": lead_context(lead)}])
    if out:
        text = clean_text(out)
        if not violations(text, 60):
            return finalize_email(text, cfg), llm.model()
    if step == 1:
        text = (f"Hoi,\n\nNog één ding over mijn vorige mail: in de demo zie je in twee minuten hoe één overzicht "
                f"voor al je advertenties eruitziet, zonder account: {o['demo_url']}\n\n{first}")
    else:
        text = (f"Hoi,\n\nDit is mijn laatste mailtje hierover. Als advertenties voor {lead['name']} ooit "
                f"tijdrovend worden: {o['trial_text']}, via {o['demo_url']}.\n\n{first}")
    return finalize_email(text, cfg), "template"
