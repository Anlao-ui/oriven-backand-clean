import json

from growth_engine import collect, db
from growth_engine.channel import EMAIL, MANUAL, NONE, decide_channel
from tests.conftest import FIX


def test_query_contains_categories():
    q = collect.build_query("Amersfoort")
    assert 'area["name"="Amersfoort"]' in q
    for frag in ('["shop"]', '["craft"]', '["office"]', "dentist", "fitness_centre", "hotel", '["website"]'):
        assert frag in q
    assert q.strip().endswith("out center tags;")


def test_parse_dedupe_and_skip():
    data = json.loads((FIX / "overpass.json").read_text())
    leads = collect.parse_elements(data, "Amersfoort")
    domains = [l["domain"] for l in leads]
    assert domains == ["bloemenhuisflora.nl", "tandartsdelinde.nl", "fit.example.nl"]
    flora = leads[0]
    assert flora["osm_email"] == "info@bloemenhuisflora.nl"
    assert flora["category"] == "winkel:florist"
    assert leads[1]["website"] == "https://tandartsdelinde.nl"
    assert leads[1]["category"] == "zorg:dentist"
    assert leads[2]["website"] == "https://fit.example.nl"


def test_store_dedupes_and_respects_optout(conn):
    data = json.loads((FIX / "overpass.json").read_text())
    leads = collect.parse_elements(data, "Amersfoort")
    db.add_optout(conn, "fit.example.nl", "domain")
    assert collect.store_leads(conn, leads) == 2
    assert collect.store_leads(conn, leads) == 0


def test_channel_rule():
    assert decide_channel("B.V.", "info@x.nl") == EMAIL
    assert decide_channel("Stichting", "info@x.nl") == EMAIL
    assert decide_channel("B.V.", None) == MANUAL
    assert decide_channel("Eenmanszaak", "info@x.nl") == MANUAL
    assert decide_channel("V.O.F.", "info@x.nl") == MANUAL
    assert decide_channel(None, "info@x.nl") == MANUAL
    assert decide_channel("B.V.", "info@x.nl", opted_out=True) == NONE


def test_optout_matches_domain_of_email(conn):
    db.add_optout(conn, "x.nl", "domain")
    assert db.is_opted_out(conn, email="info@x.nl")
    assert not db.is_opted_out(conn, email="info@y.nl")
