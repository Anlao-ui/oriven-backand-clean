"""Collect businesses with a website from OpenStreetMap via the Overpass API."""
from __future__ import annotations

import json
import time
from urllib.parse import urlparse

import requests

from . import db
from .config import user_agent

# (osm key, value regex or None for "any") -> our category
SELECTORS = [
    ("shop", None, "winkel"),
    ("craft", None, "ambacht"),
    ("office", None, "kantoor"),
    ("amenity", "^(restaurant|cafe|bar|fast_food|ice_cream)$", "horeca"),
    ("amenity", "^(dentist|clinic|doctors|veterinary|pharmacy)$", "zorg"),
    ("healthcare", None, "zorg"),
    ("leisure", "^(fitness_centre|sports_centre)$", "fitness"),
    ("tourism", "^(hotel|guest_house|hostel|apartment)$", "hotel"),
]

WEBSITE_KEYS = ("website", "contact:website", "url")
SOCIAL_KEYS = ("contact:facebook", "contact:instagram", "contact:linkedin", "contact:tiktok",
               "facebook", "instagram")


def _selector(key: str, regex: str | None) -> str:
    return f'["{key}"]' if regex is None else f'["{key}"~"{regex}"]'


def build_query(city: str, admin_level: int = 8, timeout: int = 180, selectors=None,
                bbox: tuple[float, float, float, float] | None = None) -> str:
    """Overpass QL. With a bbox (south, west, north, east) the costly area lookup is skipped."""
    scope = "(%s)" % ",".join(f"{v:.5f}" for v in bbox) if bbox else "(area.a)"
    parts = []
    for key, regex, _ in selectors or SELECTORS:
        for wk in ("website", "contact:website"):
            parts.append(f'  nwr{_selector(key, regex)}["{wk}"]{scope};')
    body = "\n".join(parts)
    city_q = city.replace('"', '\\"')
    head = f"[out:json][timeout:{timeout}];\n"
    if not bbox:
        head += f'area["name"="{city_q}"]["boundary"="administrative"]["admin_level"="{admin_level}"]->.a;\n'
    return head + f"(\n{body}\n);\nout center tags;"


def geocode_bbox(cfg: dict, city: str, country: str = "NL") -> tuple[float, float, float, float] | None:
    """City bounding box from Nominatim (cached on disk; 1 request per city, ever)."""
    from .config import DATA_DIR
    cache_path = DATA_DIR / "geo_cache.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    key = f"{city}|{country}"
    if key not in cache:
        try:
            r = requests.get("https://nominatim.openstreetmap.org/search", timeout=30,
                             params={"city": city, "country": country, "format": "json", "limit": 1},
                             headers={"User-Agent": user_agent(cfg)})
            res = r.json() if r.status_code == 200 else []
        except (requests.RequestException, ValueError):
            res = []
        if not res:
            return None
        s_, n_, w_, e_ = map(float, res[0]["boundingbox"])
        cache[key] = [s_, w_, n_, e_]
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=1))
        time.sleep(1.1)  # Nominatim policy: max 1 request per second
    return tuple(cache[key])


def normalize_website(url: str | None) -> str | None:
    if not url:
        return None
    url = url.strip().split(";")[0].strip()
    if not url:
        return None
    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    return url


def domain_of(url: str | None) -> str | None:
    if not url:
        return None
    host = urlparse(url).hostname or ""
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return host or None


# Big chains / platforms are not our customer: skip them.
SKIP_DOMAINS = {
    "facebook.com", "instagram.com", "linktr.ee", "albertheijn.nl", "ah.nl", "jumbo.com",
    "kruidvat.nl", "hema.nl", "action.com", "lidl.nl", "aldi.nl", "mcdonalds.com", "mcdonalds.nl",
    "dominos.nl", "subway.com", "etos.nl", "blokker.nl", "gamma.nl", "praxis.nl", "karwei.nl",
    "ing.nl", "rabobank.nl", "abnamro.nl", "postnl.nl", "starbucks.nl", "burgerking.nl",
    "kfc.nl", "zeeman.com", "primark.com", "hm.com", "zara.com", "intertoys.nl", "bol.com",
    "google.com", "booking.com", "thuisbezorgd.nl", "plus.nl", "dirk.nl", "coop.nl", "spar.nl",
    "vomar.nl", "dekamarkt.nl", "hoogvliet.com", "trekpleister.nl", "specsavers.nl",
    "pearle.nl", "hans-anders.nl", "bakkerbart.nl", "nh-hotels.com", "vandervalk.nl",
}


def category_of(tags: dict) -> str:
    import re
    for key, regex, cat in SELECTORS:
        if key in tags and (regex is None or re.match(regex, tags[key])):
            return f"{cat}:{tags[key]}"
    return "overig"


def parse_elements(data: dict, city: str, country: str = "NL", keep_other_cities: bool = False) -> list[dict]:
    """Turn an Overpass JSON response into lead dicts (deduped by id and domain)."""
    leads: dict[str, dict] = {}
    seen_domains: set[str] = set()
    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        website = None
        for k in WEBSITE_KEYS:
            website = normalize_website(tags.get(k))
            if website:
                break
        dom = domain_of(website)
        if not dom or dom in SKIP_DOMAINS or any(dom.endswith("." + s) for s in SKIP_DOMAINS):
            continue
        if tags.get("brand:wikidata") or tags.get("brand:wikipedia"):
            continue  # chain store
        osm_id = f"{el.get('type')}/{el.get('id')}"
        city_tag = tags.get("addr:city")
        if city_tag and city_tag.strip().lower() != city.lower() and not keep_other_cities:
            continue  # bbox overlaps neighbouring towns
        if osm_id in leads or dom in seen_domains:
            continue
        seen_domains.add(dom)
        socials = {k: v for k, v in tags.items() if k in SOCIAL_KEYS}
        leads[osm_id] = {
            "osm_id": osm_id,
            "name": tags.get("name") or tags.get("brand") or dom,
            "website": website,
            "domain": dom,
            "city": tags.get("addr:city") or city,
            "country": country,
            "category": category_of(tags),
            "osm_email": tags.get("email") or tags.get("contact:email"),
            "osm_phone": tags.get("phone") or tags.get("contact:phone"),
            "osm_tags": json.dumps({"socials": socials, "opening_hours": tags.get("opening_hours")},
                                   ensure_ascii=False),
        }
    return list(leads.values())


_DEAD: set[str] = set()  # endpoints that refused the connection this run


def _post(cfg: dict, query: str, retries: int) -> dict:
    urls = cfg.get("overpass_urls") or [cfg.get("overpass_url", "https://overpass-api.de/api/interpreter")]
    errors = []
    for attempt in range(retries):
        for url in [u for u in urls if u not in _DEAD] or urls:
            try:
                r = requests.post(url, data={"data": query}, headers={"User-Agent": user_agent(cfg)},
                                  timeout=(15, 180))
                if r.status_code == 200:
                    return r.json()
                errors.append(f"{url}: HTTP {r.status_code}")
            except requests.ConnectionError as exc:
                _DEAD.add(url)
                errors.append(f"{url}: {type(exc).__name__}")
            except (requests.RequestException, ValueError) as exc:
                errors.append(f"{url}: {type(exc).__name__}")
        time.sleep(min(45, 5 * (attempt + 1)))  # busy servers: back off politely
    raise RuntimeError("; ".join(errors[-2:]))


def fetch_overpass(cfg: dict, city: str, admin_level: int = 8, country: str = "NL", retries: int = 8) -> dict:
    """One small query per category (big combined queries time out on public servers).

    A category that keeps failing is skipped with a warning instead of aborting the city.
    """
    bbox = geocode_bbox(cfg, city, country)
    elements, failed = [], []
    for sel in SELECTORS:
        try:
            data = _post(cfg, build_query(city, admin_level, timeout=120, selectors=[sel], bbox=bbox), retries)
            elements += data.get("elements", [])
            print(f"  {sel[2]:8} ({sel[0]}): {len(data.get('elements', []))} objecten", flush=True)
        except RuntimeError as exc:
            failed.append(sel[0])
            print(f"  waarschuwing: categorie {sel[0]}/{sel[2]} overgeslagen ({exc})")
        time.sleep(2)
    if failed and not elements:
        raise RuntimeError(f"Overpass failed for {city}: alle categorieën mislukt")
    return {"elements": elements}


def store_leads(conn, leads: list[dict]) -> int:
    """Insert new leads; skip known osm ids, known domains and opted-out domains."""
    added = 0
    for lead in leads:
        if db.is_opted_out(conn, domain=lead["domain"]):
            continue
        exists = conn.execute("SELECT 1 FROM leads WHERE osm_id=? OR domain=?",
                              (lead["osm_id"], lead["domain"])).fetchone()
        if exists:
            continue
        conn.execute(
            """INSERT INTO leads (osm_id, name, website, domain, city, country, category,
               osm_tags, osm_email, osm_phone, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (lead["osm_id"], lead["name"], lead["website"], lead["domain"], lead["city"],
             lead["country"], lead["category"], lead["osm_tags"], lead["osm_email"],
             lead["osm_phone"], db.now()),
        )
        added += 1
    conn.commit()
    return added


def collect(conn, cfg: dict, cities: list[dict]) -> int:
    total = 0
    for c in cities:
        data = fetch_overpass(cfg, c["name"], c.get("admin_level", 8), c.get("country", "NL"))
        leads = parse_elements(data, c["name"], c.get("country", "NL"))
        added = store_leads(conn, leads)
        db.log_event(conn, "collect", detail={"city": c["name"], "found": len(leads), "added": added})
        print(f"{c['name']}: {len(leads)} bedrijven met website gevonden, {added} nieuw")
        total += added
    return total
