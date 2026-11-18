from growth_engine import signals as s


def test_pixels_shopify_bv(fixture_html):
    html = fixture_html("shopify_bv.html")
    px = s.detect_pixels(html)
    assert px == {"meta": True, "google_ads": True, "tiktok": True, "pinterest": False, "snapchat": False}
    a = s.detect_analytics(html)
    assert a["ga4"] and a["gtm"]
    assert s.detect_platform(html) == "shopify"
    assert s.detect_cart(html)


def test_pinterest_snapchat_lightspeed(fixture_html):
    html = fixture_html("lightspeed_pins.html")
    px = s.detect_pixels(html)
    assert px["pinterest"] and px["snapchat"] and not px["meta"] and not px["google_ads"]
    assert s.detect_platform(html) == "lightspeed"
    assert s.detect_cart(html)
    assert s.detect_language(html) == "en"


def test_no_pixels_plain_site(fixture_html):
    html = fixture_html("wix_plain.html")
    assert not any(s.detect_pixels(html).values())
    assert not any(s.detect_analytics(html).values())
    assert s.detect_platform(html) == "wix"
    assert not s.detect_cart(html)


def test_ga4_alone_is_not_google_ads():
    html = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ZZZZ9999"></script>'
    assert s.detect_analytics(html)["ga4"]
    assert not s.detect_pixels(html)["google_ads"]


def test_emails_prefer_generic_own_domain(fixture_html):
    html = fixture_html("shopify_bv.html") + fixture_html("contact_page.html")
    emails = s.extract_emails(html, "bloemenhuisflora.nl")
    assert emails[0] == "info@bloemenhuisflora.nl"
    assert "logo@2x.png" not in emails
    assert s.best_email(emails, "bloemenhuisflora.nl") == "info@bloemenhuisflora.nl"


def test_obfuscated_email(fixture_html):
    emails = s.extract_emails(fixture_html("wix_plain.html"), "tandartsdelinde.nl")
    assert emails == ["praktijk@tandartsdelinde.nl"]


def test_personal_gmail_is_not_best_email(fixture_html):
    emails = s.extract_emails(fixture_html("woo_eenmanszaak.html"), "kapsalonjet.nl")
    assert "jet.kapper@gmail.com" in emails
    assert s.best_email(emails, "kapsalonjet.nl") is None


def test_other_domain_generic_not_used(fixture_html):
    emails = s.extract_emails(fixture_html("lightspeed_pins.html"), "nordichome.com")
    assert s.best_email(emails, "nordichome.com") == "sales@nordichome.com"


def test_kvk():
    assert s.extract_kvk("KvK 12345678") == "12345678"
    assert s.extract_kvk("KvK-nummer: 87654321") == "87654321"
    assert s.extract_kvk("Chamber of Commerce: 11223344") == "11223344"
    assert s.extract_kvk("Telefoon 0612345678") is None


def test_legal_forms(fixture_html):
    from bs4 import BeautifulSoup
    t = lambda n: BeautifulSoup(fixture_html(n), "html.parser").get_text("\n")
    assert s.detect_legal_form(t("shopify_bv.html"), "Bloemenhuis Flora") == "B.V."
    assert s.detect_legal_form(t("woo_eenmanszaak.html"), "Studio Kapsalon Jet") == "Eenmanszaak"
    assert s.detect_legal_form(t("lightspeed_pins.html"), "Nordic Home Store") == "B.V."
    assert s.detect_legal_form("", "Stichting Buurtzorg Oost") == "Stichting"
    assert s.detect_legal_form("© 2025 Bakkerij Jansen V.O.F.", "Bakkerij Jansen") == "V.O.F."


def test_third_party_bv_is_ignored(fixture_html):
    """'Mollie B.V.' or the web designer's B.V. must not turn a business into a legal entity."""
    from bs4 import BeautifulSoup
    text = BeautifulSoup(fixture_html("wix_plain.html"), "html.parser").get_text("\n")
    assert s.detect_legal_form(text, "Tandartspraktijk De Linde") is None


def test_socials_skip_share_links(fixture_html):
    soc = s.extract_socials(fixture_html("shopify_bv.html"), "https://bloemenhuisflora.nl/")
    assert soc["instagram"].startswith("https://www.instagram.com/bloemenhuisflora")
    assert soc["facebook"] == "https://www.facebook.com/bloemenhuisflora"


def test_contact_links(fixture_html):
    links = s.find_contact_links(fixture_html("shopify_bv.html"), "https://bloemenhuisflora.nl/")
    assert links == ["https://bloemenhuisflora.nl/pages/contact", "https://bloemenhuisflora.nl/pages/over-ons"]


def test_meta_and_language(fixture_html):
    html = fixture_html("shopify_bv.html")
    m = s.page_meta(html)
    assert m["title"].startswith("Bloemenhuis Flora")
    assert "boeketten" in m["description"]
    assert s.detect_language(html) == "nl"
    assert s.detect_language(fixture_html("wix_plain.html")) == "nl"  # no lang attr: word count


def test_analyze_pages_combines(fixture_html):
    pages = [("https://bloemenhuisflora.nl/", fixture_html("shopify_bv.html")),
             ("https://bloemenhuisflora.nl/pages/contact", fixture_html("contact_page.html"))]
    sig = s.analyze_pages(pages, "bloemenhuisflora.nl", "Bloemenhuis Flora")
    assert sig["n_ad_platforms"] == 3
    assert sig["ad_platforms"] == ["meta", "google_ads", "tiktok"]
    assert sig["is_legal_entity"] and sig["kvk"] == "12345678"
    assert set(sig["socials"]) == {"instagram", "facebook", "linkedin"}
    assert sig["best_email"] == "info@bloemenhuisflora.nl"
