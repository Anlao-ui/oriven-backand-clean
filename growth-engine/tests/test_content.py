import os
import shutil
from datetime import date

import pytest

from growth_engine.content import formats, perf_model, pipeline


def test_every_format_builds_and_has_no_brand_name():
    bank = formats.ideas()
    for fmt in formats.FORMATS:
        assert len(bank[fmt]) >= 2, fmt
        for idea in bank[fmt]:
            pages = formats.build(fmt, idea)
            assert pages and all("render" in p for p in pages)
            for p in pages:
                low = p.lower()
                assert "orivenai" not in low.replace("orivenai.com", "")
                for color in ("#fff;", "#ffffff", "cream", "#fdf"):
                    assert color not in low


def test_tokens():
    assert formats.TOKENS == {"bg": "#0A0A0A", "raised": "#141414", "ink": "#F0F0F0", "muted": "#A6AA9F",
                              "line": "#262626", "lime": "#EAFD13", "onlime": "#0B0C0A"}


def test_week_plan_rhythm(conn, cfg, monkeypatch):
    monkeypatch.setattr(pipeline, "llm_variant", lambda *a: None)
    ids = pipeline.plan_week(conn, cfg, week_offset=1, render=False)
    rows = conn.execute("SELECT * FROM posts").fetchall()
    days = lambda pl: sorted({date.fromisoformat(r["date"]).weekday() for r in rows if r["platform"] == pl})
    assert days("instagram") == [0, 1, 2]
    assert days("linkedin") == [0, 1, 3, 4]
    assert len(ids) == 7
    li = [r["format"] for r in rows if r["platform"] == "linkedin"]
    assert "funny_reel" not in li and len(set(li)) == len(li)
    assert pipeline.plan_week(conn, cfg, week_offset=1, render=False) == []


def test_perf_model_learns_best_format(conn, monkeypatch, tmp_path):
    monkeypatch.setattr(perf_model, "PATH", tmp_path / "p.json")
    for i in range(12):
        fmt = "carousel" if i % 2 else "hot_take"
        conn.execute("INSERT INTO posts (week,date,platform,format,kind,spec,caption,status) VALUES (?,?,?,?,?,?,?,?)",
                     ("w", f"2026-10-{i + 1:02d}", "instagram", fmt, "post", "{}", "x", "published"))
        pid = conn.execute("SELECT last_insert_rowid() i").fetchone()["i"]
        good = fmt == "carousel"
        conn.execute("INSERT INTO post_metrics (post_id,reach,likes,comments,saves,shares,clicks) VALUES (?,?,?,?,?,?,?)",
                     (pid, 1000, 80 if good else 10, 5 if good else 0, 30 if good else 1, 10 if good else 0, 0))
    conn.commit()
    m = perf_model.train(conn)
    c = m.predict(perf_model.features("carousel", "instagram", "2026-11-23"))[0]
    h = m.predict(perf_model.features("hot_take", "instagram", "2026-11-23"))[0]
    assert c > h


needs_browser = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg missing")


@needs_browser
def test_render_static_and_overflow_check(tmp_path, cfg):
    """Real render: PNG at 1080x1350 and the fit checker catches text that can't fit."""
    from playwright.sync_api import sync_playwright
    from growth_engine.content.render import FitError, launch, render_static
    try:
        with sync_playwright() as p:
            b = launch(p)
            out = render_static(b, formats.build("hot_take", formats.ideas()["hot_take"][0])[0], formats.POST,
                                tmp_path / "x.png", tmp_path)
            from struct import unpack
            w, h = unpack(">II", out.read_bytes()[16:24])
            assert (w, h) == (1080, 1350)
            broken = formats.page(1080, 1350, ".x{position:absolute;left:900px;width:400px}", "<div class='x'>off</div>")
            with pytest.raises(FitError):
                render_static(b, broken, formats.POST, tmp_path / "y.png", tmp_path)
            b.close()
    except Exception as exc:
        if "Executable doesn't exist" in str(exc):
            pytest.skip("no chromium")
        raise
