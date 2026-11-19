"""Render formats to PNG/MP4 with Playwright + ffmpeg. Deterministic: frame i = render(i / fps)."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from ..config import OUTPUT_DIR
from . import formats


class FitError(RuntimeError):
    pass


def launch(p):
    """Chromium from Playwright; CHROMIUM_PATH overrides the binary (e.g. a preinstalled one)."""
    import os
    exe = os.environ.get("CHROMIUM_PATH")
    return p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg niet gevonden (scripts\\setup_windows.ps1 installeert het via winget)")
    return exe


def _open_page(browser, html: str, w: int, h: int, tmp: Path, name: str):
    f = tmp / f"{name}.html"
    f.write_text(html, encoding="utf-8")
    page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
    page.goto(f.as_uri())
    page.wait_for_function("window.__ready === true", timeout=15000)
    return page


def _check(page, t: float, label: str) -> None:
    page.evaluate(f"window.render({t})")
    bad = page.evaluate("checkFit()")
    if bad:
        raise FitError(f"{label} @ t={t:.2f}s: {bad[:5]}")


def render_static(browser, html: str, size, out: Path, tmp: Path) -> Path:
    w, h = size
    page = _open_page(browser, html, w, h, tmp, out.stem)
    _check(page, 0, out.name)
    page.screenshot(path=str(out), clip={"x": 0, "y": 0, "width": w, "height": h})
    page.close()
    return out


def render_video(browser, html: str, size, duration: float, out: Path, tmp: Path, fps: int = 30,
                 crf: int = 18) -> Path:
    w, h = size
    page = _open_page(browser, html, w, h, tmp, out.stem)
    frames = tmp / f"{out.stem}_frames"
    frames.mkdir(exist_ok=True)
    n = int(round(duration * fps))
    check_every = max(1, fps // 2)
    for i in range(n):
        t = i / fps
        if i % check_every == 0 or i == n - 1:
            _check(page, t, out.name)  # nothing may run off the frame at any time
        else:
            page.evaluate(f"window.render({t})")
        page.screenshot(path=str(frames / f"{i:05d}.png"), clip={"x": 0, "y": 0, "width": w, "height": h})
    page.close()
    encode(frames, out, fps, crf)
    return out


def encode(frames: Path, out: Path, fps: int, crf: int, pattern: str = "%05d.png") -> None:
    subprocess.run([_ffmpeg(), "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(frames / pattern),
                    "-c:v", "libx264", "-preset", "slow", "-crf", str(crf), "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", str(out)], check=True)


PREP_DEMO_JS = """
() => {
  // Decline cookies, hide site chrome and any brand name: the visuals carry no product name.
  for (const b of document.querySelectorAll('button')) {
    if (/reject|weiger|alleen noodzakelijk|decline/i.test(b.textContent)) { b.click(); break; }
  }
  const st = document.createElement('style');
  st.textContent = 'header, nav, [class*=cookie], [id*=cookie], [class*=consent], [id*=consent] {display:none !important}';
  document.head.appendChild(st);
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) { if (/oriven/i.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/oriven\\s*ai/ig, '').replace(/oriven/ig, ''); }
  document.querySelectorAll('img[alt*=riven i], svg[aria-label*=riven i], a[href="/"] img, a[href="/"] svg').forEach(e => e.style.visibility = 'hidden');
  // The demo may scroll inside a container instead of the document: pick the biggest scroller.
  let best = document.scrollingElement, bestRange = best.scrollHeight - best.clientHeight;
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowY)) continue;
    const range = el.scrollHeight - el.clientHeight;
    if (range > bestRange && el.clientHeight > innerHeight * 0.4) { best = el; bestRange = range; }
  }
  window.__scroller = best;
  return bestRange;
}
"""


def record_demo(browser, url: str, duration: float, fps: int, tmp: Path, slot_w: int, slot_h: int) -> Path:
    """Deterministic 'screen recording' of the live demo: scroll position is a function of t."""
    page = browser.new_page(viewport={"width": slot_w, "height": slot_h}, device_scale_factor=1)
    page.goto(url, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1500)
    total = page.evaluate(PREP_DEMO_JS)
    page.wait_for_timeout(500)
    travel = min(total, slot_h * 0.9)  # stay inside the app view
    frames = tmp / "demo_frames"
    frames.mkdir(exist_ok=True)
    n = int(round(duration * fps))
    for i in range(n):
        t = i / fps
        k = max(0.0, min(1.0, (t - 1.0) / max(0.1, duration - 2.5)))
        k = k * k * (3 - 2 * k)  # smoothstep: hold, glide, hold
        page.evaluate(f"window.__scroller.scrollTop = {travel * k:.1f}")
        page.screenshot(path=str(frames / f"{i:05d}.png"))
    page.close()
    return frames


def render_demo_reel(browser, cfg: dict, spec: dict, out: Path, tmp: Path) -> Path:
    c = cfg["content"]
    fps, crf = c.get("fps", 30), c.get("crf", 18)
    w, h = formats.REEL
    frame_png = render_static(browser, formats.build("demo_reel", spec)[0], (w, h), tmp / "demo_bg.png", tmp)
    x, y, sw, sh = formats.DEMO_SLOT
    dur = formats.FORMATS["demo_reel"]["duration"]
    frames = record_demo(browser, c["demo_url"], dur, fps, tmp, sw, sh)
    subprocess.run([_ffmpeg(), "-y", "-loglevel", "error", "-loop", "1", "-framerate", str(fps), "-i", str(frame_png),
                    "-framerate", str(fps), "-i", str(frames / "%05d.png"),
                    "-filter_complex", f"[0:v][1:v]overlay={x}:{y}:shortest=1,format=yuv420p",
                    "-c:v", "libx264", "-preset", "slow", "-crf", str(crf), "-movflags", "+faststart", str(out)],
                   check=True)
    return out


def render_format(cfg: dict, fmt: str, spec: dict, out_dir: Path, browser=None) -> list[Path]:
    from playwright.sync_api import sync_playwright
    meta = formats.FORMATS[fmt]
    out_dir.mkdir(parents=True, exist_ok=True)
    fps, crf = cfg["content"].get("fps", 30), cfg["content"].get("crf", 18)

    def go(b):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            if fmt == "demo_reel":
                return [render_demo_reel(b, cfg, spec, out_dir / f"{fmt}.mp4", tmp)]
            pages = formats.build(fmt, spec)
            if meta["kind"] == "reel":
                return [render_video(b, pages[0], meta["size"], meta["duration"], out_dir / f"{fmt}.mp4", tmp, fps, crf)]
            outs = []
            for i, html in enumerate(pages, 1):
                name = f"{fmt}_{i:02d}.png" if len(pages) > 1 else f"{fmt}.png"
                outs.append(render_static(b, html, meta["size"], out_dir / name, tmp))
            return outs

    if browser is not None:
        return go(browser)
    with sync_playwright() as p:
        b = launch(p)
        try:
            return go(b)
        finally:
            b.close()


def demo_samples(cfg: dict) -> list[Path]:
    """Render the first idea of every format into output/samples (handy visual check)."""
    from playwright.sync_api import sync_playwright
    out = OUTPUT_DIR / "samples"
    bank = formats.ideas()
    paths = []
    with sync_playwright() as p:
        b = launch(p)
        for fmt in formats.FORMATS:
            try:
                paths += render_format(cfg, fmt, bank[fmt][0], out, browser=b)
                print(f"  {fmt}: ok")
            except Exception as exc:
                print(f"  {fmt}: MISLUKT — {exc}")
        b.close()
    return paths
