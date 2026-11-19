"""Pure signal detection on HTML. No network here, so everything is testable with fixtures."""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

AD_PIXELS = {
    "meta": [r"connect\.facebook\.net/[^\"'\s]*/fbevents\.js", r"fbq\(\s*['\"]init['\"]",
             r"facebook\.com/tr\?id="],
    "google_ads": [r"['\"]AW-\d{6,}", r"googleadservices\.com", r"googleads\.g\.doubleclick\.net",
                   r"gtag\(\s*['\"]config['\"]\s*,\s*['\"]AW-"],
    "tiktok": [r"analytics\.tiktok\.com", r"ttq\.load\(", r"ttq\.page\("],
    "pinterest": [r"s\.pinimg\.com/ct/core\.js", r"pintrk\(\s*['\"]load['\"]", r"ct\.pinterest\.com"],
    "snapchat": [r"sc-static\.net/scevent\.min\.js", r"snaptr\(\s*['\"]init['\"]", r"tr\.snapchat\.com"],
}
ANALYTICS = {
    "ga4": [r"googletagmanager\.com/gtag/js\?id=G-[A-Z0-9]{6,}", r"gtag\(\s*['\"]config['\"]\s*,\s*['\"]G-[A-Z0-9]{6,}"],
    "gtm": [r"googletagmanager\.com/gtm\.js", r"['\"]GTM-[A-Z0-9]{4,}['\"]", r"googletagmanager\.com/ns\.html\?id=GTM-"],
}
PLATFORMS = {
    "shopify": [r"cdn\.shopify\.com", r"Shopify\.theme", r"myshopify\.com"],
    "woocommerce": [r"woocommerce", r"wc-cart-fragments", r"wc_add_to_cart"],
    "lightspeed": [r"webshopapp\.com", r"lightspeedhq", r"seoshop", r"cdn\.shoplightspeed\.com"],
    "magento": [r"Magento_[A-Za-z]+", r"mage/cookies", r"text/x-magento-init"],
    "wix": [r"static\.wixstatic\.com", r"wix-code", r"_wixCssImports", r"parastorage\.com"],
    "squarespace": [r"static1\.squarespace\.com", r"Squarespace\.", r"squarespace-cdn\.com"],
}
CART_PATTERNS = [r"/(cart|winkelwagen|winkelmand|checkout|afrekenen|mandje|basket)\b",
                 r"add[-_]to[-_]cart", r"in (de )?winkelwagen", r"toevoegen aan winkelwagen"]
SOCIAL_HOSTS = {
    "facebook": ("facebook.com", "fb.com"),
    "instagram": ("instagram.com",),
    "linkedin": ("linkedin.com",),
    "tiktok": ("tiktok.com",),
    "pinterest": ("pinterest.com", "pinterest.nl"),
    "youtube": ("youtube.com",),
    "x": ("twitter.com", "x.com"),
}
GENERIC_PREFIXES = ("info", "contact", "hallo", "hello", "hi", "mail", "office", "sales",
                    "verkoop", "klantenservice", "service", "support", "receptie", "praktijk",
                    "welkom", "boekingen", "reserveringen", "reservations", "shop", "webshop", "team")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
KVK_RE = re.compile(r"(?:kvk|k\.v\.k\.|kamer van koophandel|coc|chamber of commerce)[\s\-:.]*(?:nummer|nr\.?|no\.?|number)?[\s\-:.#]*(\d{8})\b", re.I)
LEGAL_FORMS = [
    ("B.V.", r"(?<![A-Za-z])B\.\s?V\.(?![A-Za-z])|(?<![A-Za-z0-9])BV(?![A-Za-z0-9])|besloten vennootschap"),
    ("N.V.", r"(?<![A-Za-z])N\.\s?V\.(?![A-Za-z])|naamloze vennootschap"),
    ("Stichting", r"\bStichting\b"),
    ("Coöperatie", r"\bCo[öo]peratie(ve)?\b|\bU\.A\.(?![A-Za-z])"),
    ("Vereniging", r"\bVereniging\b"),
    ("V.O.F.", r"(?<![A-Za-z])V\.\s?O\.\s?F\.?(?![A-Za-z])|(?<![A-Za-z0-9])VOF(?![A-Za-z0-9])|vennootschap onder firma"),
    ("C.V.", r"(?<![A-Za-z])C\.\s?V\.(?![A-Za-z])|commanditaire vennootschap"),
    ("Eenmanszaak", r"\beenmanszaak\b|\bzzp(?:'er|er)?\b"),
]
# Rechtspersonen: cold B2B email is allowed (with opt-out) under the Dutch Telecommunicatiewet.
LEGAL_ENTITIES = {"B.V.", "N.V.", "Stichting", "Coöperatie", "Vereniging"}
CONTACT_LINK_RE = re.compile(r"contact|over[-_ ]?ons|overons|about|wie[-_ ]?zijn|impressum|colofon|team", re.I)
NL_WORDS = {"de", "het", "een", "en", "van", "voor", "met", "onze", "wij", "jouw", "uw", "bij", "niet", "ook"}
EN_WORDS = {"the", "and", "our", "with", "for", "your", "you", "we", "are", "about", "not"}
DE_WORDS = {"und", "der", "die", "das", "mit", "für", "unsere", "wir", "nicht", "sie"}


def _any(patterns, text, flags=0) -> bool:
    return any(re.search(p, text, flags) for p in patterns)


# Signatures inside a public GTM container (gtm.js). Slashes are escaped there ("\/").
GTM_PIXELS = {
    "meta": [r"fbevents\.js", r"connect\.facebook\.net", r"fbq\(\s*\\?['\"]init"],
    "google_ads": [r'"__awct"', r'"__sp"', r"AW-\d{6,}", r"vtp_conversionId"],
    "tiktok": [r"analytics\.tiktok\.com", r"ttq\.load"],
    "pinterest": [r"pintrk\(", r"s\.pinimg\.com"],
    "snapchat": [r"sc-static\.net", r"snaptr\("],
}
GTM_ID_RE = re.compile(r"GTM-[A-Z0-9]{4,10}\b")


def gtm_ids(html: str) -> list[str]:
    return sorted(set(GTM_ID_RE.findall(html)))[:3]


def scan_gtm_container(js: str) -> dict:
    """Ad platforms configured inside a GTM container (pixels you can't see in the page HTML)."""
    return {name: _any(pats, js) for name, pats in GTM_PIXELS.items()}


def merge_gtm_pixels(sig: dict, gtm_pixels: dict) -> dict:
    """Add GTM-loaded pixels to the page signals and remember where each one came from."""
    via = [k for k, v in gtm_pixels.items() if v and not sig["pixels"].get(k)]
    for k in via:
        sig["pixels"][k] = True
    sig["pixels_via_gtm"] = via
    sig["ad_platforms"] = [k for k, v in sig["pixels"].items() if v]
    sig["n_ad_platforms"] = len(sig["ad_platforms"])
    return sig


def detect_pixels(html: str) -> dict:
    return {name: _any(pats, html) for name, pats in AD_PIXELS.items()}


def detect_analytics(html: str) -> dict:
    return {name: _any(pats, html) for name, pats in ANALYTICS.items()}


def detect_platform(html: str) -> str | None:
    for name, pats in PLATFORMS.items():
        if _any(pats, html):
            return name
    return None


def detect_cart(html: str) -> bool:
    return _any(CART_PATTERNS, html, re.I)


def _registrable(host: str) -> str:
    host = host.lower().strip(".")
    if host.startswith("www."):
        host = host[4:]
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def extract_emails(html: str, domain: str | None) -> list[str]:
    """Emails sorted by preference: generic on own domain > own domain > generic elsewhere > rest."""
    soup = BeautifulSoup(html, "html.parser")
    found = set()
    for a in soup.select('a[href^="mailto:"]'):
        addr = a["href"][7:].split("?")[0].strip()
        if EMAIL_RE.fullmatch(addr):
            found.add(addr.lower())
    text = soup.get_text(" ")
    text = re.sub(r"\s*[\[\(\{]\s*(?:at|apenstaartje)\s*[\]\)\}]\s*", "@", text, flags=re.I)
    text = re.sub(r"\s*[\[\(\{]\s*(?:dot|punt)\s*[\]\)\}]\s*", ".", text, flags=re.I)
    for m in EMAIL_RE.findall(text):
        found.add(m.lower().strip("."))
    bad_ext = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".css", ".js")
    bad_hosts = ("sentry", "wixpress.com", "example.com", "domain.com", "email.com", "yourdomain")
    emails = [e for e in found if not e.endswith(bad_ext) and not any(b in e for b in bad_hosts)]
    own = _registrable(domain) if domain else None

    def rank(e: str):
        local, _, host = e.partition("@")
        on_own = own is not None and _registrable(host) == own
        generic = local.split(".")[0] in GENERIC_PREFIXES or local in GENERIC_PREFIXES
        return (0 if on_own and generic else 1 if on_own else 2 if generic else 3, e)

    return sorted(emails, key=rank)


def best_email(emails: list[str], domain: str | None) -> str | None:
    """Only a generic address on the business's own domain is used for cold email."""
    own = _registrable(domain) if domain else None
    for e in emails:
        local, _, host = e.partition("@")
        if own and _registrable(host) == own and (local.split(".")[0] in GENERIC_PREFIXES):
            return e
    return None


def extract_kvk(text: str) -> str | None:
    m = KVK_RE.search(text)
    return m.group(1) if m else None


THIRD_PARTIES = re.compile(r"mollie|shopify|lightspeed|wix|google|meta platforms|facebook|booking\.com|"
                           r"thuisbezorgd|adyen|paypal|klarna|postnl|dhl|bol\.com|tripadvisor|"
                           r"zenchef|treatwell|squarespace|woocommerce|wordpress|hosting|webdesign by|"
                           r"ontwikkeld door|gemaakt door|website door|realisatie|powered by", re.I)


def _legal_contexts(text: str, name: str) -> list[str]:
    """Snippets where a legal form most likely belongs to this business itself."""
    contexts = []
    name_key = next((w for w in re.findall(r"[\wÀ-ÿ'&-]+", name or "") if len(w) > 3), None)
    for raw in re.split(r"[\n|•·]+|(?<=[.!?])\s{2,}", text):
        line = " ".join(raw.split())
        if not line or len(line) > 400:
            continue
        low = line.lower()
        anchored = ("©" in line or "copyright" in low or "kvk" in low or "k.v.k" in low
                    or "kamer van koophandel" in low or "handelsregister" in low
                    or (name_key and name_key.lower() in low))
        if anchored and not THIRD_PARTIES.search(line):
            contexts.append(line)
    return contexts


def detect_legal_form(text: str, name: str = "") -> str | None:
    """Legal form of the business itself: from its name, else from footer/KvK/name contexts.

    Mentions of third parties ("powered by Mollie B.V.") are ignored on purpose: a wrong
    "B.V." would allow cold email to a sole trader, which Dutch law does not allow.
    """
    sources = [name or ""] + _legal_contexts(text, name)
    for source in sources:
        for form, pat in LEGAL_FORMS:
            flags = re.I if form in ("Stichting", "Vereniging", "Eenmanszaak", "Coöperatie") else 0
            if re.search(pat, source, flags):
                return form
    return None


def extract_socials(html: str, base_url: str = "") -> dict:
    soup = BeautifulSoup(html, "html.parser")
    out = {}
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])
        host = (urlparse(href).hostname or "").lower()
        for name, hosts in SOCIAL_HOSTS.items():
            if name not in out and any(host == h or host.endswith("." + h) for h in hosts):
                path = urlparse(href).path.strip("/")
                if path and not path.startswith(("sharer", "share", "intent", "dialog")):
                    out[name] = href
    return out


def detect_language(html: str) -> str | None:
    m = re.search(r"<html[^>]*\blang=['\"]?([a-zA-Z]{2})", html, re.I)
    if m:
        return m.group(1).lower()
    words = re.findall(r"[a-zäöüß]+", BeautifulSoup(html, "html.parser").get_text(" ").lower())
    counts = {"nl": sum(w in NL_WORDS for w in words), "en": sum(w in EN_WORDS for w in words),
              "de": sum(w in DE_WORDS for w in words)}
    best = max(counts, key=counts.get)
    return best if counts[best] >= 3 else None


def page_meta(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else None
    desc = None
    tag = soup.find("meta", attrs={"name": re.compile("^description$", re.I)}) or \
        soup.find("meta", attrs={"property": "og:description"})
    if tag and tag.get("content"):
        desc = tag["content"].strip()
    return {"title": (title or "")[:200] or None, "description": (desc or "")[:300] or None}


def find_contact_links(html: str, base_url: str, limit: int = 2) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    base_host = _registrable(urlparse(base_url).hostname or "")
    scored = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"]).split("#")[0]
        host = _registrable(urlparse(href).hostname or "")
        if host != base_host or not href.startswith("http"):
            continue
        label = f"{a.get_text(' ', strip=True)} {urlparse(href).path}"
        if CONTACT_LINK_RE.search(label):
            prio = 0 if re.search("contact", label, re.I) else 1
            scored.append((prio, href))
    out = []
    for _, href in sorted(scored):
        if href not in out and href.rstrip("/") != base_url.rstrip("/"):
            out.append(href)
        if len(out) >= limit:
            break
    return out


def analyze_pages(pages: list[tuple[str, str]], domain: str | None, name: str = "") -> dict:
    """Combine signals from homepage + extra pages. pages = [(url, html), ...]."""
    all_html = "\n".join(h for _, h in pages)
    text = "\n".join(BeautifulSoup(h, "html.parser").get_text("\n") for _, h in pages)
    pixels = detect_pixels(all_html)
    analytics = detect_analytics(all_html)
    emails = extract_emails(all_html, domain)
    socials = {}
    for url, h in pages:
        for k, v in extract_socials(h, url).items():
            socials.setdefault(k, v)
    home_html = pages[0][1] if pages else ""
    legal = detect_legal_form(text, name)
    return {
        "pixels": pixels,
        "ad_platforms": [k for k, v in pixels.items() if v],
        "n_ad_platforms": sum(pixels.values()),
        "ga4": analytics["ga4"],
        "gtm": analytics["gtm"],
        "platform": detect_platform(all_html),
        "cart": detect_cart(all_html),
        "emails": emails[:5],
        "best_email": best_email(emails, domain),
        "kvk": extract_kvk(text),
        "legal_form": legal,
        "is_legal_entity": legal in LEGAL_ENTITIES,
        "socials": socials,
        "lang": detect_language(home_html),
        **page_meta(home_html),
    }
