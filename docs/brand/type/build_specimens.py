"""Draw three cuts of a Scholium display face and set each one beside the current
Source Serif 4 on real Scholium copy, so a cut can be chosen before any
marketing piece uses it.

Regenerate everything in this folder with:

    uv run --project ~/.claude/skills/generating-business-collateral --with brotli \
        python docs/brand/type/build_specimens.py

The cuts are drawn by the generating-business-collateral skill's typeface tool
(scripts/typeface.py): one weight per cut, capitals, lowercase, figures and
common punctuation, display sizes only. The fonts are written with fsType 0 and
no donor outlines, so Scholium owns them outright.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

SKILL = pathlib.Path(os.environ.get(
    "COLLATERAL_SKILL", "~/.claude/skills/generating-business-collateral")).expanduser()
sys.path.insert(0, str(SKILL / "scripts"))

import fonts  # noqa: E402  (skill module, found through the path insertion)
import render  # noqa: E402
import typeface  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
WEB_FONTS = ROOT / "apps/web/public/fonts"
OUT_FONTS = HERE / "fonts"

# Brand tokens, light theme (docs/design.md section 3).
BG, SURFACE, INK, INK2, RULE = "#FBFAF7", "#FFFFFF", "#1B1D22", "#5A5F6B", "#E4E1D9"
ACCENT, MARGIN_NOTE = "#2F4BA0", "#FFF6D6"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from cuts import CUTS as _CUTS  # noqa: E402  (key, style, params, weight, use)

CUTS = [(k, st, prm, use) for k, st, prm, _w, use in _CUTS]

# Real copy, from docs/homepage/index.html and docs/design.md. Every string the
# specimen sets is checked for missing glyphs before anything renders.
HEADLINE = "Signed by you. Checkable by anyone."
SECOND = "Peer review, out in the open. Sealed until it’s fair."
TAGLINE = "Signed, open preprints and peer review"
STEPS = "From draft to discussed, in four steps."
ID = "sch:k3f9-q2xz-7mwd/v3"
URL = "scholium.fyi"
CONFUSABLES = "0O 1Il 5S 8B 2Z 6G"
CHARSET = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz",
           "0123456789 &.,:;-/?!’'\"()"]
EXTRA = "– — · → ‘ “ ” @ # %"  # en/em dash, middle dot, arrow, quotes
COPY = " ".join([HEADLINE, SECOND, TAGLINE, STEPS, ID, URL, CONFUSABLES, *CHARSET, EXTRA])

# BrandMark "glyph" variant, copied from apps/web/src/features/ui-kit/brand-mark.tsx.
GLYPH_W, GLYPH_H = 52, 54
LINE_TOPS = [15, 20.6, 26.2, 31.8, 37.4]


def glyph_svg_parts() -> str:
    lines = "".join(
        f'<rect x="5.5" y="{t}" width="{13 if i == 4 else 25}" height="1.6" rx="0.8" fill="{BG}"/>'
        for i, t in enumerate(LINE_TOPS))
    return (f'<rect width="36" height="40" y="7" fill="{ACCENT}"/>{lines}'
            f'<rect x="39" y="7" width="9" height="40" fill="{MARGIN_NOTE}"/>'
            f'<path d="M39 0h13v54H39v-4h9V4h-9z" fill="{ACCENT}"/>')


def lockup_svg(height_px: float) -> str:
    """Mark + lowercase serif wordmark, laid out by docs/design.md section 2.

    In grid units the lockup is 54 tall: wordmark x-height 0.46 of it, baseline
    0.205 of it above the bottom edge, gap 0.26 of it after the bracket.
    """
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
    ss = instantiateVariableFont(TTFont(WEB_FONTS / "source-serif-4-latin.woff2"),
                                 {"wght": 600, "opsz": 32})
    upm = ss["head"].unitsPerEm
    x_ratio = ss["OS/2"].sxHeight / upm
    size = 0.46 * GLYPH_H / x_ratio
    baseline = GLYPH_H * (1 - 0.205)
    text_x = GLYPH_W + 0.26 * GLYPH_H
    cmap, hmtx = ss.getBestCmap(), ss["hmtx"]
    word_em = sum(hmtx[cmap[ord(c)]][0] for c in "scholium") / upm  # measured, not guessed
    vb_w = text_x + size * word_em
    width_px = height_px * vb_w / GLYPH_H
    # The family name MUST be quoted: unquoted, the "4" makes `Source Serif 4` an
    # invalid CSS family and the wordmark silently falls back to a sans.
    return (f'<svg class="lockup" viewBox="0 0 {vb_w:.1f} {GLYPH_H}" width="{width_px:.0f}" '
            f'height="{height_px:.0f}" role="img" aria-label="scholium">{glyph_svg_parts()}'
            f'<text data-font="Source Serif 4" x="{text_x:.2f}" y="{baseline:.2f}" '
            f'font-family="\'Source Serif 4\'" font-weight="600" font-size="{size:.2f}" '
            f'fill="{INK}">scholium</text></svg>')


def draw_cuts() -> list[dict]:
    built = []
    for key, style, params, use in CUTS:
        family = f"Scholium Display {key}"
        out = OUT_FONTS / f"ScholiumDisplay-{key}-{style}.otf"
        info = typeface.build(typeface.Design(**params), family, style, out,
                              designer="Scholium", licence="Owned by Scholium")
        built.append({"key": key, "style": style, "params": params, "use": use,
                      "family": family, "path": out, "build": info})
    return built


def audit_all(cuts: list[dict]) -> dict:
    report = {"copy_checked": COPY, "cuts": {}, "current": {}}
    for c in cuts:
        report["cuts"][c["key"]] = {
            "build": c["build"],
            "audit": fonts.audit(c["path"]),
            "missing_glyphs": fonts.coverage(c["path"], COPY),
            "confusable_pairs": fonts.confusability(c["path"]),
        }
    for name in ["source-serif-4-latin", "inter-latin", "jetbrains-mono-latin"]:
        p = WEB_FONTS / f"{name}.woff2"
        report["current"][name] = {"audit": fonts.audit(p),
                                   "missing_glyphs": fonts.coverage(p, COPY)}
    return report


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def row(label: str, note: str, family: str, weight: int, font_path: pathlib.Path) -> str:
    """One panel. Every text element carries data-font, which render_png checks
    against the font Chromium actually used for it."""
    f = f"font-family:'{family}';font-weight:{weight}"
    d = f'data-font="{family}"'
    from fontTools.ttLib import TTFont
    have = set(TTFont(font_path).getBestCmap())
    # Set only characters the face has. A missing one would render in a fallback
    # font and the specimen would show a glyph the face does not own.
    charset = "<br>".join(esc("".join(c for c in s if ord(c) in have or c == " ")) for s in CHARSET)
    extra = "".join(c for c in EXTRA if ord(c) in have or c == " ")
    missing = sorted({c for c in COPY if ord(c) not in have and c != " "})
    gap = (f'<p class="miss">Not in this face: {esc(" ".join(missing))}</p>' if missing
           else '<p class="miss">Every character in the specimen copy is in this face.</p>')
    return f"""
<section class="cut">
  <header><b>{esc(label)}</b><span>{esc(note)}</span></header>
  <p {d} style="{f};font-size:76px;line-height:1.08;margin:0 0 18px">{esc(HEADLINE)}</p>
  <p {d} style="{f};font-size:38px;line-height:1.2;margin:0 0 28px;color:{INK2}">{esc(SECOND)}</p>
  <div class="pair">
    {lockup_svg(44)}
    <span {d} style="{f};font-size:30px">{esc(TAGLINE)}</span>
  </div>
  <div class="grid">
    <div>
      <p {d} style="{f};font-size:26px;line-height:1.35;margin:0 0 6px">{charset}</p>
      <p {d} style="{f};font-size:26px;margin:0 0 10px">{esc(extra)}</p>
      {gap}
    </div>
    <div>
      <p {d} style="{f};font-size:34px;margin:0 0 10px;letter-spacing:0.02em">{esc(ID)}</p>
      <p {d} style="{f};font-size:34px;margin:0 0 18px;letter-spacing:0.08em">{esc(CONFUSABLES)}</p>
      <p {d} style="{f};font-size:18px;margin:0 0 6px">18 px: {esc(STEPS)}</p>
      <p {d} style="{f};font-size:13px;margin:0">13 px: {esc(STEPS)} {esc(URL)}</p>
    </div>
  </div>
</section>"""


def specimen_html(cuts: list[dict]) -> str:
    faces = [render.font_face_css("Source Serif 4", WEB_FONTS / "source-serif-4-latin.woff2", "200 900"),
             render.font_face_css("Inter", WEB_FONTS / "inter-latin.woff2", "100 900")]
    faces += [render.font_face_css(c["family"], c["path"], "400") for c in cuts]
    rows = [row(f"{c['key']}  {c['style']}",
                f"stem {c['params']['stem']} · width {c['params']['width']:.2f} · "
                f"contrast {c['params']['contrast']:.2f} · for {c['use']}",
                c["family"], 400, c["path"]) for c in cuts]
    rows.append(row("Current  Source Serif 4, 600",
                    "today's wordmark and paper-title face, for comparison",
                    "Source Serif 4", 600, WEB_FONTS / "source-serif-4-latin.woff2"))
    return f"""<!doctype html><html><head><meta charset="utf-8">
<style>{''.join(faces)}
*{{box-sizing:border-box}}
body{{margin:0;background:{BG};color:{INK};font-family:Inter,sans-serif;padding:56px 64px;width:1600px}}
h1{{font:600 22px Inter;margin:0 0 6px}}
.intro{{font:400 15px/22px Inter;color:{INK2};margin:0 0 36px;max-width:1100px}}
.cut{{background:{SURFACE};border:1px solid {RULE};border-radius:10px;padding:32px 40px;margin:0 0 28px}}
.cut header{{display:flex;gap:16px;align-items:baseline;font:400 13px/18px Inter;color:{INK2};
  border-bottom:1px solid {RULE};padding-bottom:12px;margin-bottom:24px}}
.cut header b{{font:600 15px Inter;color:{ACCENT}}}
.pair{{display:flex;align-items:center;gap:28px;padding:18px 22px;background:{BG};
  border-radius:6px;margin:0 0 28px}}
.grid{{display:grid;grid-template-columns:1.1fr 1fr;gap:40px}}
.miss{{font:400 13px/18px Inter;color:{INK2};margin:0}}
</style></head><body>
<h1>Scholium display face: specimens A, B and C</h1>
<p class="intro">Each cut is drawn by the skill's typeface tool as one weight of a geometric sans,
for headlines only. Reading text, UI text and IDs stay in Source Serif 4, Inter and JetBrains Mono.
The bar under each headline pairs the cut with the current serif lockup, as a poster or social
post would. The last panel is today's serif, for comparison.</p>
{''.join(rows)}
</body></html>"""


def render_png(html: str, out: pathlib.Path) -> int:
    """Full-page PNG. Fails on any silent fallback, element by element.

    `document.fonts` only says a face loaded SOMEWHERE on the page. The first
    build of this sheet passed that check while its wordmark rendered in a sans,
    because Source Serif 4 had loaded for another panel. So ask Chromium which
    font it actually used for each element marked data-font.
    """
    from playwright.sync_api import sync_playwright
    failures, checked = [], 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        page.set_content(html, wait_until="load")
        page.evaluate("document.fonts.ready")
        cdp = page.context.new_cdp_session(page)
        cdp.send("DOM.enable")
        cdp.send("CSS.enable")
        root = cdp.send("DOM.getDocument", {"depth": -1})["root"]["nodeId"]
        for node in cdp.send("DOM.querySelectorAll", {"nodeId": root, "selector": "[data-font]"})["nodeIds"]:
            attrs = cdp.send("DOM.getAttributes", {"nodeId": node})["attributes"]
            want = dict(zip(attrs[::2], attrs[1::2]))["data-font"]
            used = cdp.send("CSS.getPlatformFontsForNode", {"nodeId": node})["fonts"]
            wrong = [f"{u['familyName']} ({u['glyphCount']} glyphs)" for u in used
                     if not u["familyName"].startswith(want)]
            checked += 1
            if wrong:
                failures.append(f"{want}: also rendered in {', '.join(wrong)}")
        page.screenshot(path=str(out), full_page=True)
        browser.close()
    if failures:
        raise SystemExit("FAIL: fallback fonts on the specimen:\n  " + "\n  ".join(failures))
    return checked


def main() -> int:
    cuts = draw_cuts()
    report = audit_all(cuts)
    html = specimen_html(cuts)
    (HERE / "specimen.html").write_text(html, encoding="utf-8")
    checked = render_png(html, HERE / "specimen.png")
    report["elements_font_checked"] = checked
    (HERE / "specimen-report.json").write_text(
        json.dumps(report, indent=2, default=str), encoding="utf-8")

    print(f"{checked} text elements rendered in their intended face, no fallback")
    for key, r in report["cuts"].items():
        b, emb = r["build"], r["audit"]["embedding"]
        miss = [m["char"] for m in r["missing_glyphs"]["missing"]]
        conf = [c["pair"] for c in r["confusable_pairs"] if c["confusable"]]
        print(f"{key}: {b['glyphs']} glyphs, {b['kern_pairs']} kern pairs, "
              f"fsType {emb['fsType']} ({emb['permission']}), missing {miss or 'none'}, "
              f"confusable {conf or 'none'}")
    for name, r in report["current"].items():
        miss = [m["char"] for m in r["missing_glyphs"]["missing"]]
        print(f"{name}: fsType {r['audit']['embedding']['fsType']}, missing {miss or 'none'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
