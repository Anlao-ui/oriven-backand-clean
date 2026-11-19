"""Format library: recurring post formats rendered from HTML/CSS/SVG with a deterministic render(t)."""
from __future__ import annotations

import html
import json
from pathlib import Path

from ..config import ASSETS_DIR

POST = (1080, 1350)
REEL = (1080, 1920)

FORMATS = {
    "hot_take": {"kind": "post", "size": POST, "duration": 0, "name": "One-line hot take"},
    "before_after": {"kind": "post", "size": POST, "duration": 0, "name": "Before / after"},
    "stat_card": {"kind": "post", "size": POST, "duration": 0, "name": "Big number"},
    "checklist": {"kind": "post", "size": POST, "duration": 0, "name": "Checklist"},
    "carousel": {"kind": "carousel", "size": POST, "duration": 0, "name": "Carousel"},
    "funny_reel": {"kind": "reel", "size": REEL, "duration": 10.0, "name": "Funny reel (setup/escalation/punchline)"},
    "demo_reel": {"kind": "reel", "size": REEL, "duration": 12.0, "name": "Product demo screen recording"},
}
# LinkedIn gets posts/carousels/static; reels are Instagram-first (LinkedIn gets the MP4 too).
PLATFORM_FORMATS = {
    "instagram": list(FORMATS),
    "linkedin": ["hot_take", "before_after", "stat_card", "checklist", "carousel", "demo_reel"],
}

TOKENS = {"bg": "#0A0A0A", "raised": "#141414", "ink": "#F0F0F0", "muted": "#A6AA9F", "line": "#262626",
          "lime": "#EAFD13", "onlime": "#0B0C0A"}


def ideas() -> dict:
    return json.loads((Path(__file__).parent / "ideas.json").read_text(encoding="utf-8"))


def e(s) -> str:
    return html.escape(str(s))


def base_css(w: int, h: int) -> str:
    f = (ASSETS_DIR / "fonts").as_uri()
    t = TOKENS
    return f"""
@font-face{{font-family:Geist;src:url({f}/Geist-Variable.woff2) format('woff2');font-weight:100 900}}
@font-face{{font-family:'Geist Mono';src:url({f}/GeistMono-Variable.woff2) format('woff2');font-weight:100 900}}
@font-face{{font-family:'Instrument Serif';font-style:italic;src:url({f}/instrument-serif-latin-400-italic.woff2) format('woff2')}}
@font-face{{font-family:'Instrument Serif';font-style:italic;src:url({f}/instrument-serif-latin-ext-400-italic.woff2) format('woff2');unicode-range:U+0100-024F}}
:root{{--bg:{t['bg']};--raised:{t['raised']};--ink:{t['ink']};--muted:{t['muted']};--line:{t['line']};--lime:{t['lime']};--onlime:{t['onlime']}}}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:{w}px;height:{h}px;overflow:hidden;background:var(--bg)}}
#stage{{position:relative;width:{w}px;height:{h}px;overflow:hidden;background:var(--bg);color:var(--ink);
  font-family:Geist,sans-serif;padding:96px 88px;display:flex;flex-direction:column}}
.mono{{font-family:'Geist Mono',monospace;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);font-size:30px}}
.serif{{font-family:'Instrument Serif',serif;font-style:italic;font-weight:400}}
.lime{{color:var(--lime)}}
.fit{{overflow:hidden}}
.grid{{display:none}}
#stage{{background-image:linear-gradient(#141414 1px,transparent 1px),linear-gradient(90deg,#141414 1px,transparent 1px);background-size:90px 90px}}
.fit-inner{{width:100%;min-width:0}}.fit-inner>span{{display:block}}
.chip{{border:1px solid var(--line);background:var(--raised);border-radius:18px;padding:22px 28px;font-size:36px}}
"""


FIT_JS = """
// Every .fit box gets an inner wrapper; we compare the wrapper's line-box size with the box,
// so glyph overhang of italic serifs doesn't count, but real overflow does.
function inner(el){
  let i=el.querySelector(':scope>.fit-inner');
  if(!i){i=document.createElement('div');i.className='fit-inner';while(el.firstChild)i.appendChild(el.firstChild);el.appendChild(i);}
  return i;
}
function over(el){const i=inner(el);return i.offsetHeight>el.clientHeight+1||i.scrollWidth>el.clientWidth+1||i.offsetWidth>el.clientWidth+1;}
// Shrink each .fit element's font until its content fits its box (no text runs off the frame).
function fitAll(){
  document.querySelectorAll('.fit').forEach(el=>{
    let fs=parseFloat(getComputedStyle(el).fontSize), n=0;
    while(over(el)&&fs>12&&n<200){fs*=0.96;el.style.fontSize=fs+'px';n++;}
  });
}
// Report anything that falls outside the frame or overflows its box.
function checkFit(){
  const st=document.getElementById('stage'),W=st.clientWidth,H=st.clientHeight,bad=[];
  document.querySelectorAll('#stage *').forEach(el=>{
    const cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden'||+cs.opacity===0)return;
    const r=el.getBoundingClientRect(); if(r.width===0||r.height===0)return;
    if(r.left<-1||r.top<-1||r.right>W+1||r.bottom>H+1)bad.push((el.className||el.tagName)+': outside frame');
    if(el.classList.contains('fit')&&over(el))bad.push(el.className+': overflow');
  });
  return bad;
}
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const ease=x=>1-Math.pow(1-clamp(x),3);
"""


def page(w: int, h: int, css: str, body: str, render_js: str = "window.render=function(t){};") -> str:
    return (f"<!doctype html><html><head><meta charset='utf-8'><style>{base_css(w, h)}{css}</style></head>"
            f"<body><div id='stage'><div class='grid'></div>{body}</div>"
            f"<script>{FIT_JS}{render_js}document.fonts.ready.then(()=>{{fitAll();window.__ready=true;}});</script>"
            f"</body></html>")


def hot_take(d: dict) -> list[str]:
    w, h = POST
    css = (".k{margin-bottom:auto}.line{font-size:118px;line-height:1.02;height:820px;display:flex;align-items:flex-end}"
           ".bar{width:180px;height:14px;background:var(--lime);margin-top:56px;border-radius:7px}")
    body = (f"<div class='mono k'>{e(d['kicker'])}</div><div class='line serif fit'><span>{e(d['line'])}</span></div>"
            f"<div class='bar'></div>")
    return [page(w, h, css, body)]


def before_after(d: dict) -> list[str]:
    w, h = POST
    css = (".t{font-size:64px;font-weight:600;height:90px;margin:20px 0 48px}"
           ".cols{display:grid;grid-template-columns:1fr 1fr;gap:28px;flex:1}"
           ".col{border:1px solid var(--line);border-radius:28px;padding:36px;display:flex;flex-direction:column;gap:16px;background:var(--raised)}"
           ".col.after{background:var(--lime);color:var(--onlime);border-color:var(--lime)}"
           ".col .chip{font-size:30px;padding:16px 20px;color:var(--muted)}"
           ".big{font-size:84px;line-height:1;height:270px}.note{margin-top:auto;font-size:44px}"
           ".after .mono{color:var(--onlime)}")
    chips = "".join(f"<div class='chip fit' style='height:74px'>{e(x)}</div>" for x in d["before"][:5])
    body = (f"<div class='mono'>BEFORE / AFTER</div><div class='t fit'>{e(d['title'])}</div><div class='cols'>"
            f"<div class='col'><div class='mono'>Before</div>{chips}<div class='note serif fit' style='height:60px'>{e(d['before_note'])}</div></div>"
            f"<div class='col after'><div class='mono'>After</div><div class='big serif fit'>{e(d['after'])}</div>"
            f"<div class='note serif fit' style='height:60px'>{e(d['after_note'])}</div></div></div>")
    return [page(w, h, css, body)]


def stat_card(d: dict) -> list[str]:
    w, h = POST
    css = (".big{font-size:300px;line-height:1;height:420px;margin-top:auto;font-weight:700;letter-spacing:-.04em;color:var(--lime);white-space:nowrap}"
           ".l{font-size:78px;line-height:1.05;height:200px;margin-top:24px}")
    body = (f"<div class='mono'>BY THE NUMBERS</div><div class='big fit'>{e(d['big'])}</div>"
            f"<div class='l serif fit'>{e(d['line'])}</div>")
    return [page(w, h, css, body)]


def checklist(d: dict) -> list[str]:
    w, h = POST
    css = (".t{font-size:92px;line-height:1.02;height:300px;margin:24px 0 40px}"
           ".it{display:flex;gap:28px;align-items:center;border-top:1px solid var(--line);padding:30px 0}"
           ".box{flex:0 0 56px;height:56px;border-radius:14px;background:var(--lime);display:flex;align-items:center;justify-content:center}"
           ".txt{font-size:44px;height:112px;display:flex;align-items:center;flex:1}")
    check = "<svg width='32' height='32' viewBox='0 0 24 24'><path d='M4 12l5 5L20 6' stroke='#0B0C0A' stroke-width='3.2' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>"
    items = "".join(f"<div class='it'><div class='box'>{check}</div><div class='txt fit'>{e(x)}</div></div>" for x in d["items"][:4])
    body = f"<div class='mono'>CHECKLIST</div><div class='t serif fit'>{e(d['title'])}</div>{items}"
    return [page(w, h, css, body)]


def carousel(d: dict) -> list[str]:
    w, h = POST
    n = len(d["slides"]) + 2
    css = (".n{font-family:'Geist Mono';color:var(--lime);font-size:34px}.t{font-size:132px;line-height:1;height:760px;margin-top:auto;display:flex;align-items:flex-end}"
           ".h{font-size:96px;line-height:1.02;height:330px;margin-top:auto}.p{font-size:48px;line-height:1.3;color:var(--muted);height:330px;margin-top:40px}"
           ".foot{display:flex;justify-content:space-between;margin-top:48px}.dots{display:flex;gap:10px}"
           ".dot{width:14px;height:14px;border-radius:7px;background:var(--line)}.dot.on{background:var(--lime)}"
           ".cta{background:var(--lime);color:var(--onlime);border-radius:28px;padding:56px;font-size:72px;line-height:1.08;height:420px;margin-top:auto}")

    def foot(i):
        dots = "".join(f"<div class='dot{' on' if j == i else ''}'></div>" for j in range(n))
        arrow = "Swipe →" if i < n - 1 else ""
        return f"<div class='foot'><div class='dots'>{dots}</div><div class='mono'>{arrow}</div></div>"

    pages = [page(w, h, css, f"<div class='mono'>SAVE THIS</div><div class='t serif fit'><span>{e(d['title'])}</span></div>{foot(0)}")]
    for i, (head, para) in enumerate(d["slides"], 1):
        pages.append(page(w, h, css, f"<div class='n'>{i:02d}</div><div class='h fit'>{e(head)}</div>"
                                     f"<div class='p fit'>{e(para)}</div>{foot(i)}"))
    pages.append(page(w, h, css, f"<div class='mono'>NEXT STEP</div><div class='cta serif fit'>{e(d['cta'])}</div>{foot(n - 1)}"))
    return pages


def funny_reel(d: dict) -> list[str]:
    w, h = REEL
    lines = d["escalation"][:5]
    css = (".setup{font-size:84px;line-height:1.05;height:330px;margin-top:80px}"
           ".stack{display:flex;flex-direction:column;gap:22px;margin-top:60px;height:820px}"
           ".n{display:flex;gap:22px;align-items:center;background:var(--raised);border:1px solid var(--line);border-radius:26px;padding:26px 30px;height:136px}"
           ".ic{flex:0 0 22px;height:22px;border-radius:11px;background:var(--lime)}"
           ".nt{font-size:40px;height:84px;display:flex;align-items:center;flex:1}"
           ".punch{position:absolute;left:88px;right:88px;bottom:220px;height:300px;font-size:170px;line-height:1;color:var(--lime);display:flex;align-items:flex-end}"
           ".tag{position:absolute;left:88px;top:96px}")
    notes = "".join(f"<div class='n' id='n{i}'><div class='ic'></div><div class='nt fit'>{e(x)}</div></div>" for i, x in enumerate(lines))
    body = (f"<div class='mono tag'>POV</div><div class='setup serif fit' id='setup'>{e(d['setup'])}</div>"
            f"<div class='stack'>{notes}</div><div class='punch serif fit' id='punch'><span>{e(d['punchline'])}</span></div>")
    js = f"""
window.render=function(t){{
  const s=document.getElementById('setup'); s.style.opacity=ease(t/0.5); s.style.transform='translateY('+(30*(1-ease(t/0.5)))+'px)';
  for(let i=0;i<{len(lines)};i++){{const el=document.getElementById('n'+i), st=2.2+i*0.75, k=ease((t-st)/0.35);
    el.style.opacity=k; el.style.transform='translateX('+(-60*(1-k))+'px) rotate('+((i%2?1:-1)*1.2*k)+'deg)';
    if(t>6.4){{el.style.opacity=k*(1-ease((t-6.4)/0.4)*0.75);}}}}
  const p=document.getElementById('punch'), pk=ease((t-6.8)/0.35); p.style.opacity=pk; p.style.transform='scale('+(0.92+0.08*pk)+')';
  p.style.transformOrigin='left bottom';
}};"""
    return [page(w, h, css, body, js)]


def demo_frame(d: dict) -> list[str]:
    """Static frame around the demo recording (the recording is overlaid by ffmpeg)."""
    w, h = REEL
    css = (".hl{font-size:96px;line-height:1.02;height:300px;margin-top:40px}"
           ".slot{position:absolute;left:60px;right:60px;top:500px;height:1100px;border:2px solid var(--line);border-radius:36px;background:var(--raised)}"
           ".ft{position:absolute;left:88px;right:88px;bottom:110px;height:110px;display:flex;align-items:center;gap:20px}"
           ".pill{background:var(--lime);color:var(--onlime);border-radius:55px;padding:0 44px;height:100px;display:flex;align-items:center;font-size:42px;font-weight:600;white-space:nowrap}")
    body = (f"<div class='mono'>REAL PRODUCT, NO MOCKUP</div><div class='hl serif fit'>{e(d['headline'])}</div>"
            f"<div class='slot'></div><div class='ft'><div class='pill fit'>{e(d['footer'])}</div></div>")
    return [page(w, h, css, body)]


BUILDERS = {"hot_take": hot_take, "before_after": before_after, "stat_card": stat_card, "checklist": checklist,
            "carousel": carousel, "funny_reel": funny_reel, "demo_reel": demo_frame}
# The recording slot inside demo_frame, in px (x, y, w, h) — inset by the 2px border.
DEMO_SLOT = (62, 502, 956, 1096)


def build(fmt: str, spec: dict) -> list[str]:
    return BUILDERS[fmt](spec)
