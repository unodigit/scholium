"""Side-by-side: the current wordmark (Source Serif 4 semibold) against the three
Scholium Display cuts, in the places the lockup actually appears. A decision
aid only; nothing in the brand or the app changes.

    uv run --project ~/.claude/skills/generating-business-collateral --with brotli \
        python docs/brand/type/compare_wordmark.py

Every variant uses the same lockup rules from docs/design.md section 2 --
wordmark x-height 0.46 of the lockup height, baseline 0.205 above its bottom
edge, gap 0.26 -- so only the face changes.
"""
from __future__ import annotations

import os
import pathlib
import sys

SKILL = pathlib.Path(os.environ.get(
    "COLLATERAL_SKILL", "~/.claude/skills/generating-business-collateral")).expanduser()
sys.path.insert(0, str(SKILL / "scripts"))
import render  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
WEB = ROOT / "apps/web/public/fonts"
SERIF = WEB / "source-serif-4-latin.woff2"

LIGHT = dict(accent="#2F4BA0", paper="#FBFAF7", note="#FFF6D6", ink="#1B1D22", ink2="#5A5F6B", rule="#E4E1D9")
DARK = dict(accent="#8FA6F0", paper="#14151A", note="#3A3320", ink="#ECEBE6", ink2="#A3A7B2", rule="#2C2F38")

VARIANTS = [  # label, css family, weight, font file for metrics, axes for a variable face
    ("Current: Source Serif 4, 600", "Source Serif 4", 600, SERIF, {"wght": 600, "opsz": 32}),
    ("Scholium Display Light", "Scholium Display", 300, HERE / "fonts/ScholiumDisplay-Light.otf", None),
    ("Scholium Display Regular", "Scholium Display", 400, HERE / "fonts/ScholiumDisplay-Regular.otf", None),
    ("Scholium Display Bold", "Scholium Display", 700, HERE / "fonts/ScholiumDisplay-Bold.otf", None),
]
GW, GH = 52, 54
TOPS = [15, 20.6, 26.2, 31.8, 37.4]


def metrics(path, axes):
    from fontTools.ttLib import TTFont
    f = TTFont(path)
    if axes:
        from fontTools.varLib.instancer import instantiateVariableFont
        f = instantiateVariableFont(f, axes)
    upm = f["head"].unitsPerEm
    size = 0.46 * GH / (f["OS/2"].sxHeight / upm)
    cmap, hmtx = f.getBestCmap(), f["hmtx"]
    em = sum(hmtx[cmap[ord(c)]][0] for c in "scholium") / upm
    tx = GW + 0.26 * GH
    return dict(size=size, tx=tx, vb=tx + size * em, base=GH * (1 - 0.205))


def lockup(h_px, t, fam, weight, m):
    lines = "".join(f'<rect x="5.5" y="{y}" width="{13 if i == 4 else 25}" height="1.6" rx="0.8" fill="{t["paper"]}"/>'
                    for i, y in enumerate(TOPS))
    return (f'<svg viewBox="0 0 {m["vb"]:.2f} {GH}" height="{h_px}" width="{h_px * m["vb"] / GH:.1f}" style="display:block">'
            f'<rect width="36" height="40" y="7" fill="{t["accent"]}"/>{lines}'
            f'<rect x="39" y="7" width="9" height="40" fill="{t["note"]}"/>'
            f'<path d="M39 0h13v54H39v-4h9V4h-9z" fill="{t["accent"]}"/>'
            f'<text data-font="{fam}" x="{m["tx"]:.2f}" y="{m["base"]:.2f}" font-family="\'{fam}\'" '
            f'font-weight="{weight}" font-size="{m["size"]:.2f}" fill="{t["ink"]}">scholium</text></svg>')


def cells(fam, weight, m):
    nav = lambda t: (f'<div class="nav" style="background:{t["paper"]};border-bottom:1px solid {t["rule"]}">'
                     f'{lockup(20, t, fam, weight, m)}<div class="search" style="border-color:{t["rule"]};color:{t["ink2"]}">'
                     f'Search papers…</div></div>')
    card = (f'<div class="card" style="background:{DARK["paper"]}">{lockup(44, DARK, fam, weight, m)}'
            f'<div class="tag" style="color:{DARK["ink2"]}">Signed, open preprints and peer review</div></div>')
    share = (f'<div class="share" style="background:{LIGHT["paper"]}">'
             f'<div class="chip">Under review</div>'
             f'<div data-font="Source Serif 4" class="title">Can a Meta-Agent Choose the Safer Branch?</div>'
             f'<div data-font="Inter" class="authors">Mei Zhang, Rafael Silva, Lena Haddad</div>'
             f'<div class="foot" style="border-color:{LIGHT["rule"]}"><span data-font="JetBrains Mono">sch:ty6m-3kiu-vpis</span>'
             f'{lockup(24, LIGHT, fam, weight, m)}</div></div>')
    return [nav(LIGHT), nav(DARK), card, share]


def main() -> int:
    faces = (render.font_face_css("Source Serif 4", SERIF, "200 900")
             + render.font_face_css("Inter", WEB / "inter-latin.woff2", "100 900")
             + render.font_face_css("JetBrains Mono", WEB / "jetbrains-mono-latin.woff2", "100 800")
             + "".join(render.font_face_css("Scholium Display", p, str(w)) for _l, _f, w, p, _a in VARIANTS[1:]))
    head = ("<div></div>" + "".join(f'<div class="h">{h}</div>' for h in
            ("Nav bar, 20 px (light)", "Nav bar, 20 px (dark)", "Card front, 11 mm", "Share card (1200 x 630, half size)")))
    rows = ""
    for label, fam, w, path, axes in VARIANTS:
        rows += f'<div class="lab">{label}</div>' + "".join(f"<div>{c}</div>" for c in cells(fam, w, metrics(path, axes)))
    html = f"""<!doctype html><meta charset="utf-8"><style>{faces}
*{{box-sizing:border-box;font-synthesis:none}}
body{{margin:0;padding:28px;background:#E9E7E1;font:13px Inter;color:#1B1D22;width:1640px}}
h1{{font:600 18px Inter;margin:0 0 4px}} p.i{{margin:0 0 20px;color:#5A5F6B;font-size:13px}}
.grid{{display:grid;grid-template-columns:150px 250px 250px 300px 600px;gap:16px 14px;align-items:center}}
.h{{font:600 12px Inter;color:#5A5F6B}} .lab{{font:600 13px Inter}}
.nav{{height:64px;display:flex;align-items:center;gap:22px;padding:0 18px}}
.search{{flex:1;height:34px;white-space:nowrap;overflow:hidden;border:1px solid;border-radius:6px;display:flex;align-items:center;padding:0 10px;font:13px Inter}}
.card{{width:300px;height:183px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;border-radius:4px}}
.tag{{font:11px Inter;letter-spacing:.02em}}
.share{{width:600px;height:315px;padding:32px 32px 24px;display:flex;flex-direction:column;border-radius:4px}}
.chip{{align-self:flex-start;font:500 12px Inter;color:#9A6B00;background:#FBF1D9;border:1px solid #9A6B00;border-radius:99px;padding:4px 12px}}
.title{{font:600 30px/1.2 'Source Serif 4';margin:18px 0 10px}} .authors{{font:16px Inter;color:#5A5F6B}}
.foot{{margin-top:auto;border-top:1px solid;padding-top:14px;display:flex;justify-content:space-between;align-items:center;font:14px 'JetBrains Mono'}}
</style><body><h1>Wordmark: Source Serif 4 (today) against Scholium Display</h1>
<p class="i">Same mark, same lockup rules (docs/design.md section 2); only the wordmark's face changes. Rendered at 2x: zoom in for detail.</p>
<div class="grid">{head}{rows}</div></body>"""
    out = HERE / "wordmark-comparison.png"
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1640, "height": 900}, device_scale_factor=2)
        pg.set_content(html, wait_until="load")
        pg.evaluate("document.fonts.ready")
        cdp = pg.context.new_cdp_session(pg)
        cdp.send("DOM.enable"); cdp.send("CSS.enable")
        root = cdp.send("DOM.getDocument", {"depth": -1})["root"]["nodeId"]
        bad = []
        for n in cdp.send("DOM.querySelectorAll", {"nodeId": root, "selector": "[data-font]"})["nodeIds"]:
            a = cdp.send("DOM.getAttributes", {"nodeId": n})["attributes"]
            want = dict(zip(a[::2], a[1::2]))["data-font"]
            bad += [f"{want} -> {u['familyName']}" for u in cdp.send("CSS.getPlatformFontsForNode", {"nodeId": n})["fonts"]
                    if not u["familyName"].replace(" ", "").lower().startswith(want.replace(" ", "").lower())]
        pg.screenshot(path=str(out), full_page=True)
        b.close()
    if bad:
        raise SystemExit(f"FAIL: font fallback: {sorted(set(bad))}")
    print(f"wrote {out.relative_to(ROOT)}; every element in its intended face")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
