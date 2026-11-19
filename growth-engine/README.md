# OrivenAI Growth Engine

Je eigen lokale systeem dat bedrijven vindt die **al adverteren**, ze een persoonlijke mail (of LinkedIn-bericht)
schrijft die naar de demo / €1-proef leidt, en je social content voor de week klaarzet. Alles draait lokaal en
gratis: geen betaalde tools of API's. Niets gaat de deur uit zonder jouw OK in het dashboard.

## In één keer installeren (Windows)

Open PowerShell in deze map en draai:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
```

Dat doet: Python-venv + dependencies, Chromium voor Playwright, ffmpeg en Ollama (via winget), het juiste
Qwen2.5-basismodel voor jouw GPU (7B bij ≥ 8 GB VRAM, anders 3B), `.env` aanmaken, tests draaien en de
geplande taken registreren (zondag 19:00 de weekjob, werkdagen 09:12 versturen van wat jij hebt goedgekeurd).

Daarna alleen nog in `.env` invullen:

```
ZOHO_USER=jij@orivenai.com
ZOHO_APP_PASSWORD=...      # Zoho → Account → Security → App passwords
IG_USER_ID=...             # pas nodig voor Instagram-publicatie
IG_ACCESS_TOKEN=...
```

## Dagelijks gebruik

```powershell
.\.venv\Scripts\python.exe -m growth_engine dashboard     # http://127.0.0.1:8765
```

| Commando | Wat het doet |
|---|---|
| `collect --city Amersfoort` | Bedrijven met website uit OpenStreetMap (Overpass) halen |
| `enrich --limit 300` | Homepage + max. 2 contact/over-ons-pagina's bezoeken, signalen detecteren |
| `label` | De leads waar het model het minst zeker over is: jij zegt goed/slecht, het model hertraint |
| `train` / `score` | Model trainen, alle leads scoren, `leads.csv` schrijven, top 20 tonen |
| `outcome 12 demo` | Uitkomst vastleggen (`replied`, `demo`, `bought`, `negative`) — het model leert ervan |
| `draft` | Concepten schrijven voor de beste leads → wachtrij |
| `send` | Goedgekeurde mails versturen (daglimiet), inbox lezen (antwoorden, bounces, stop) |
| `content plan` | Posts voor volgende week plannen en renderen → wachtrij |
| `content publish` | Goedgekeurde Instagram-posts publiceren, LinkedIn-posts exporteren |
| `content metrics --post-id 3 --reach 900 --likes 40 ...` | Postcijfers invoeren (Instagram haalt ze zelf op) |
| `finetune` | Je eigen tekstmodel fine-tunen zodra er ~50 goedgekeurde berichten zijn |
| `optout info@x.nl` / `delete --domain x.nl` | Opt-out / alle data van een bedrijf wissen (AVG) |
| `weekly` | Alles van hierboven in de juiste volgorde (draait zondagavond vanzelf) |

## Hoe het werkt

### Fase 1 — Leadmachine
1. **Verzamelen**: per stad (lijst in `config.json`, start met Nederlandse steden) haalt het via de gratis
   Overpass-API winkels, ambachten, kantoren, horeca, tandartsen/klinieken/dierenartsen, sportscholen en hotels
   op die een website-tag hebben. Ketens (merk-tags, bekende domeinen) worden overgeslagen; ontdubbeld op
   OSM-id en domein. De stadsgrens komt van Nominatim (eenmalig per stad, gecachet).
2. **Verrijken**: robots.txt wordt gerespecteerd, eerlijke User-Agent met contactgegevens, 2 s tussen requests
   per site, timeouts en een maximale paginagrootte. Gedetecteerd: Meta-, Google Ads-, TikTok-, Pinterest- en
   Snapchat-pixels, GA4, GTM, shopplatform (Shopify, WooCommerce, Lightspeed, Magento, Wix, Squarespace),
   winkelwagen, e-mailadressen (voorkeur info@/contact@ op eigen domein), KvK-nummer, rechtsvorm, socials,
   titel/omschrijving en taal.
3. **Scoren — eigen model**: logistische regressie, from scratch in numpy, draait in milliseconden op de CPU.
   Start op zwakke labels uit simpele regels (aantal advertentieplatforms weegt het zwaarst), daarna
   **active learning** via `label` of het dashboard, en later uitkomsten (antwoord 1,5×, demo 2,5×, klant 4×).
   Elke lead krijgt een score van 0–100 en 2–3 redenen in het Nederlands.
4. **Kanaalregel (Telecommunicatiewet)**: cold e-mail alleen naar rechtspersonen (B.V., N.V., stichting,
   vereniging, coöperatie) met een generiek adres op eigen domein en altijd een opt-out-regel.
   Eenmanszaak, zzp, V.O.F., C.V. of onbekend → kanaal "LinkedIn of contactformulier", nooit cold mail.
   Een "B.V." van een derde partij ("betalen via Mollie B.V.", "website door X B.V.") telt bewust niet mee.
   De opt-out-lijst geldt overal (verzamelen, concepten, versturen). Alleen openbare bedrijfsgegevens.
5. **Output**: `leads.csv` (gesorteerd op score, `;`-gescheiden zodat Excel het direct opent) + dashboard.

### Fase 2 — Outreach
- Het lokale tekstmodel schrijft per lead een korte Nederlandse mail in jouw stem: één concrete observatie
  ("jullie adverteren via Meta en Google"), één zin wat OrivenAI voor hen oplost, CTA naar demo of €1-proef.
  Max ~90 woorden, platte tekst. Uitvoer met clichés, emoji, vreemde links of te veel woorden wordt
  opnieuw gegenereerd; lukt dat niet, dan valt het terug op een nette sjabloontekst.
- **Wachtrij**: jij keurt goed, past aan of wijst af. Elke goedgekeurde/aangepaste tekst wordt trainingsdata.
- Versturen via Zoho SMTP (`smtp.zoho.eu`), daglimiet 20, follow-ups op +3 en +7 werkdagen (ook die moet je
  goedkeuren), stopt bij antwoord, bounce of opt-out (gelezen via Zoho IMAP). Alles gelogd
  (`data/logs/send.log` + tabel `events`).
- LinkedIn: alleen de tekst, jij verstuurt zelf (geen automatisering, dat is tegen hun voorwaarden).

### Tekstmodel — eigen fine-tune
- Tot ~50 goedgekeurde berichten: het basismodel (Qwen2.5-Instruct via Ollama) met je recentste goedgekeurde
  berichten als few-shot voorbeelden.
- Daarna: `scripts\setup_gpu.ps1` (eenmalig, aparte venv met CUDA) en `python -m growth_engine finetune`.
  QLoRA op je NVIDIA-GPU (Unsloth als het lukt, anders PEFT + bitsandbytes), export naar GGUF en registratie
  in Ollama als `orivenai-writer`. Vanaf dan gebruikt de engine automatisch jouw model. De gewichten staan in
  `models/` (niet in git).

### Fase 3 — Content
- 7 vaste formats: one-line hot take, before/after, groot getal, checklist, carousel, grappige reel
  (setup → escalatie → punchline) en een echte productdemo-opname van orivenai.com/demo.
- Gerenderd uit HTML/CSS/SVG met Playwright: posts 1080×1350, reels 1080×1920, 30 fps, H.264 CRF 18,
  deterministisch (`render(t)` per frame). Lange tekst krimpt automatisch tot hij past en elke render wordt
  gecontroleerd: valt er iets buiten beeld, dan faalt de render in plaats van een kapotte post te maken.
- Huisstijl: #0A0A0A / #141414 / #F0F0F0 / #A6AA9F / #262626 / lime #EAFD13 (tekst op lime #0B0C0A),
  Geist, Geist Mono, Instrument Serif Italic (fonts zitten in `assets/fonts`, OFL). Geen OrivenAI-naam of
  logo op de visuals (ook niet in de demo-opname), geen lichte achtergronden. Teksten zijn Engels.
- Ritme: Instagram ma/di/wo, LinkedIn-bedrijfspagina ma/di/do/vr.
- Instagram via de officiële Graph API. Let op: Instagram haalt media zelf op via een **publieke URL**.
  Zet `content.media_public_base_url` in `config.json` op een plek waar de map `output/` online staat.
  LinkedIn: map `output/linkedin_te_posten/` met bestanden + caption, jij post zelf.
- **Postmodel** (eigen, ridge-regressie in numpy) leert uit je postcijfers welke formats werken en kiest
  formats met een verkenningsbonus, zodat nieuwe formats ook kansen blijven krijgen.

## Projectstructuur

```
growth_engine/   collect, fetch, signals, enrich, channel, model, scoring, export,
                 llm, outreach, mailer, training_data, dashboard, weekly, cli
growth_engine/content/   formats, ideas.json, render, perf_model, pipeline, instagram
finetune/        train_qlora.py
scripts/         setup_windows.ps1, setup_gpu.ps1, weekly.ps1, daily_send.ps1, register_task.ps1
tests/           tests met lokale HTML-fixtures (geen live sites)
config.json      instellingen     .env   geheimen (nooit in git)
data/            SQLite-database en logs (niet in git)
```

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```
