"""Build every Scholium collateral piece from brand.json, then gate it.

    uv run --project ~/.claude/skills/generating-business-collateral --with brotli \
        python docs/brand/collateral/build.py [--only card,flyer,poster,banner,social,email]

Writes to docs/brand/collateral/out/ and never deletes anything there, so a
selective run cannot remove pieces it was not asked to touch.

The shape follows the generating-business-collateral skill: one facts file, one
link matrix, layouts as code, then three gates -- geometry before rendering
(here measured from the real browser layout, not guessed), the artefact after
rendering (decode the QR back out, fonts embedded, trim and bleed), and the set
(no two pieces share a tracking tag).

Rules this build enforces, beyond the skill's gates:
  * The display face never sets codes: no digits, URLs, IDs or e-mail-like text
    (a blind transcription test confused 0/O and I/l in it). Those go in Inter
    or JetBrains Mono. A violation stops the build.
  * Every text element is checked for silent font fallback, element by element.
  * The lockup keeps its clear space (half the mark height) on all sides.
  * Print files are DRAFT and no PDF/X file is written while the site's domain
    does not resolve; the same command writes them once it does.
"""
from __future__ import annotations

import argparse
import csv
import html as H
import json
import os
import pathlib
import re
import socket
import sys
import tempfile
import urllib.parse

SKILL = pathlib.Path(os.environ.get(
    "COLLATERAL_SKILL", "~/.claude/skills/generating-business-collateral")).expanduser()
sys.path.insert(0, str(SKILL / "scripts"))

import geometry as g  # noqa: E402
import layout as L  # noqa: E402
import links  # noqa: E402
import make_qr  # noqa: E402
import prepress  # noqa: E402
import render  # noqa: E402
import verify_digital  # noqa: E402
import verify_print  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
FACTS_PATH = HERE / "brand.json"
FACTS = json.loads(FACTS_PATH.read_text())
OUT = HERE / "out"
C = FACTS["colours"]
FONTS = FACTS["fonts"]
COPY = FACTS["copy"]
REGION = FACTS["business"]["region"]
CAMPAIGN = "beta"
PX_PER_MM = 96 / 25.4
DISPLAY = "Scholium Display"


def fpath(role: str) -> str:
    return str((HERE / FONTS[role]["file"]).resolve())


# ---------------------------------------------------------------------------
# Type
# ---------------------------------------------------------------------------

RENDER_FONTS = OUT / "_render-fonts"
_FACES: list = []


def otf_to_ttf(src: str, dst: pathlib.Path) -> None:
    """CFF outlines -> TrueType (quadratic) outlines, max error 1 unit.

    Chromium's PDF backend embeds only TrueType-outline fonts as real fonts; a
    CFF OTF -- which is what the typeface tool writes -- comes out as an
    unnamed Type 3 font that rasterises unpredictably at the printer. (Recipe:
    fontTools' otf2ttf snippet.)
    """
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.ttLib import TTFont, newTable
    f = TTFont(src)
    order = f.getGlyphOrder()
    gs = f.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = order
    glyf.glyphs = {}
    for name in order:
        pen = TTGlyphPen(gs)
        gs[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
        glyf.glyphs[name] = pen.glyph()
    f["loca"] = newTable("loca")
    f["glyf"] = glyf
    del f["CFF "]
    glyf.compile(f)
    for name, gl in glyf.glyphs.items():
        if hasattr(gl, "xMin"):
            f["hmtx"][name] = (f["hmtx"][name][0], gl.xMin)
    maxp = newTable("maxp")
    maxp.tableVersion = 0x00010000
    for k in ("maxZones",):
        setattr(maxp, k, 1)
    for k in ("maxTwilightPoints", "maxStorage", "maxFunctionDefs", "maxInstructionDefs",
              "maxStackElements", "maxSizeOfInstructions", "maxComponentElements"):
        setattr(maxp, k, 0)
    f["maxp"] = maxp
    maxp.compile(f)
    post = f["post"]
    post.formatType = 2.0
    post.extraNames, post.mapping, post.glyphOrder = [], {}, order
    f.sfntVersion = "\000\001\000\000"
    f.save(dst)


def render_faces() -> list[tuple[str, pathlib.Path, int]]:
    """Static TrueType faces for the render path, written fresh each run.

    Variable fonts (Source Serif 4, Inter) also embed as Type 3, so each weight
    in use is pinned to a static instance. The shipped fonts are not touched.
    """
    if _FACES:
        return _FACES
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
    RENDER_FONTS.mkdir(parents=True, exist_ok=True)
    for role, w in (("display_light", 300), ("display", 400), ("display_bold", 700)):
        dst = RENDER_FONTS / (pathlib.Path(FONTS[role]["file"]).stem + ".ttf")
        otf_to_ttf(fpath(role), dst)
        _FACES.append((DISPLAY, dst, w))
    for role, fam, weights, opsz in (("serif", "Source Serif 4", (400, 600), {400: 20, 600: 32}),
                                     ("text", "Inter", (400, 500, 600), None)):
        for w in weights:
            dst = RENDER_FONTS / f"{fam.replace(' ', '')}-{w}.ttf"
            axes = {"wght": w, **({"opsz": opsz[w]} if opsz else {})}
            inst = instancer.instantiateVariableFont(TTFont(fpath(role)), axes)
            for nid, val in ((1, fam), (4, f"{fam} {w}"), (6, f"{fam.replace(' ', '')}-W{w}")):
                inst["name"].setName(val, nid, 3, 1, 0x409)
            inst.save(dst)
            _FACES.append((fam, dst, w))
    return _FACES


def fonts_css() -> str:
    """Every face inlined at its TRUE weight, from the static render faces.

    layout.brand_fonts_css guesses a single weight from the role name; asking a
    face declared at 400 for 600 makes Chromium synthesise a fake bold.
    font-synthesis:none makes any mismatch fail visibly instead.
    """
    css = [render.font_face_css(fam, p, weight=str(w)) for fam, p, w in render_faces()]
    return "".join(css) + "*{font-synthesis:none}"


def pdf_font_check(pdf: pathlib.Path, expect: list[str]) -> tuple[bool, str]:
    """No Type 3, no unnamed font, every expected face present BY NAME.

    verify_print's brand-face check passes on an empty font name (an empty
    string is a substring of everything), so this check does not rely on it.
    """
    import pymupdf
    names, bad = set(), []
    for pg in pymupdf.open(pdf):
        for f in pg.get_fonts(full=True):
            ftype, base = f[2], f[3]
            if ftype == "Type3" or not base:
                bad.append(f"{ftype} '{base}'")
            names.add(re.sub(r"^[A-Z]{6}\+", "", base))
    missing = [w for w in (e.replace(" ", "") for e in expect)
               if not any(n.replace("-", "").startswith(w) for n in names)]
    ok = not bad and not missing
    return ok, (f"embedded: {sorted(names)}" if ok else f"bad: {bad[:4]} missing: {missing}")


CODE_RE = re.compile(r"\d|://|\bsch:|@|\.[a-z]{2,}\b", re.I)


def guard_display(text: str) -> str:
    m = CODE_RE.search(text)
    if m:
        raise SystemExit(f"FAIL: the display face must not set codes, digits or URLs "
                         f"(0/O and I/l are ambiguous in it): {text!r} at {m.group()!r}")
    return text


def dcap(text: str, cap_mm: float, weight: int, colour: str, **css) -> str:
    """Display text at an exact cap height, guarded against codes."""
    role = {300: "display_light", 400: "display", 700: "display_bold"}[weight]
    span = L.cap(guard_display(text), cap_mm, fpath(role), DISPLAY, colour,
                 font_weight=str(weight), **css)
    return span.replace("<span ", f'<span data-font="{DISPLAY}" ', 1)


def dfit(text: str, column: float, weight: int, max_size: float) -> float:
    """Largest display font-size (same unit as column) that fits the column.

    Fitted to 97 % of the column: the browser applies kerning and rounding the
    font-file measurement does not, and set exactly to 100 % a line re-wrapped.
    """
    role = {300: "display_light", 400: "display", 700: "display_bold"}[weight]
    return g.fit_font_size_mm(text, fpath(role), column * 0.97, max_size)


def cap_for(size: float, weight: int) -> float:
    role = {300: "display_light", 400: "display", 700: "display_bold"}[weight]
    return size * L.cap_ratio_from_font(fpath(role))


def txt(text: str, family: str, size: str, colour: str, weight: int = 400,
        extra: str = "") -> str:
    return (f'<span data-font="{family}" style="font-family:\'{family}\';font-size:{size};'
            f'font-weight:{weight};color:{colour};{extra}">{H.escape(text)}</span>')


# ---------------------------------------------------------------------------
# Lockup (geometry copied from apps/web/src/features/ui-kit/brand-mark.tsx)
# ---------------------------------------------------------------------------

GLYPH_W, GLYPH_H = 52, 54
LINE_TOPS = [15, 20.6, 26.2, 31.8, 37.4]
THEMES = {
    "light": dict(accent=C["accent"], paper=C["paper"], note=C["margin_note"], ink=C["ink"]),
    "dark": dict(accent=C["dark_accent"], paper=C["dark_paper"], note=C["dark_margin_note"],
                 ink=C["dark_ink"]),
}
# The wordmark is OUTLINE ARTWORK (docs/design.md section 2), shared with the
# app: Scholium Display Bold, drawn by docs/brand/build_lockup.py.
WORDMARK = json.loads((HERE.parent / "scholium-wordmark.json").read_text())


def lockup(height: float, unit: str, theme: str = "light", box: str = "lockup") -> tuple[str, float]:
    """Mark + outlined lowercase wordmark (docs/design.md section 2). Returns (svg, width)."""
    t = THEMES[theme]
    vb_w = WORDMARK["view_box"][2]
    width = height * vb_w / GLYPH_H
    lines = "".join(
        f'<rect x="5.5" y="{y}" width="{13 if i == 4 else 25}" height="1.6" rx="0.8" fill="{t["paper"]}"/>'
        for i, y in enumerate(LINE_TOPS))
    svg = (f'<svg data-box="{box}" viewBox="0 0 {vb_w} {GLYPH_H}" '
           f'width="{width:.3f}{unit}" height="{height:.3f}{unit}" role="img" aria-label="Scholium" '
           f'style="display:block">'
           f'<rect width="36" height="40" y="7" fill="{t["accent"]}"/>{lines}'
           f'<rect x="39" y="7" width="9" height="40" fill="{t["note"]}"/>'
           f'<path d="M39 0h13v54H39v-4h9V4h-9z" fill="{t["accent"]}"/>'
           f'<path d="{WORDMARK["path"]}" fill="{t["ink"]}"/></svg>')
    return svg, width


TILE_SVG = (HERE / FACTS["logo"]["svg"]).read_text()


# ---------------------------------------------------------------------------
# Documents, measurement and the per-element font check
# ---------------------------------------------------------------------------

def print_doc(page: g.Page, body: str, guides: bool = False, multipage: bool = False) -> str:
    """One self-contained print document. multipage lets a two-sided piece flow
    onto a second page; page_css alone clips the body to one page height."""
    gd = ""
    if guides:
        t, s = page.trim_box, page.safe_box
        gd = (f"<div style='position:absolute;left:{t.x}mm;top:{t.y}mm;width:{t.w}mm;height:{t.h}mm;"
              f"outline:0.3mm dashed #e11;z-index:999'></div>"
              f"<div style='position:absolute;left:{s.x}mm;top:{s.y}mm;width:{s.w}mm;height:{s.h}mm;"
              f"outline:0.3mm dashed #09f;z-index:999'></div>")
    return ("<!doctype html><meta charset='utf-8'><style>"
            + render.page_css(page.page_w, page.page_h) + fonts_css() + L.brand_tokens(FACTS)
            + "body{position:relative;overflow:hidden}.a{position:absolute}"
            + "[data-font='Source Serif 4']{text-wrap:pretty}"       # no one-word last lines
            + ("html,body{height:auto!important}body{overflow:visible!important}" if multipage else "")
            + "</style><body>" + body + gd + "</body>")


def px_doc(w: int, h: int, body: str, bg: str) -> str:
    return ("<!doctype html><meta charset='utf-8'><style>" + fonts_css()
            + f"html,body{{margin:0;width:{w}px;height:{h}px;background:{bg};overflow:hidden;"
              f"position:relative}}.a{{position:absolute}}[data-font='Source Serif 4']{{text-wrap:pretty}}"
              f"</style><body>" + body + "</body>")


def inspect_layout(html: str, css_w: float, css_h: float, mm: bool) -> tuple[dict, list[str]]:
    """Measure every [data-box] and check every [data-font] in the real layout."""
    from playwright.sync_api import sync_playwright
    k = PX_PER_MM if mm else 1.0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": round(css_w * k), "height": round(css_h * k)})
        page.set_content(html, wait_until="load")
        page.evaluate("document.fonts.ready")
        raw = page.evaluate("""() => [...document.querySelectorAll('[data-box]')].map(e => {
            const r = e.getBoundingClientRect(); return [e.dataset.box, r.x, r.y, r.width, r.height]; })""")
        cdp = page.context.new_cdp_session(page)
        cdp.send("DOM.enable"); cdp.send("CSS.enable")
        root = cdp.send("DOM.getDocument", {"depth": -1})["root"]["nodeId"]
        fails = []
        for node in cdp.send("DOM.querySelectorAll", {"nodeId": root, "selector": "[data-font]"})["nodeIds"]:
            attrs = cdp.send("DOM.getAttributes", {"nodeId": node})["attributes"]
            want = dict(zip(attrs[::2], attrs[1::2]))["data-font"]
            for u in cdp.send("CSS.getPlatformFontsForNode", {"nodeId": node})["fonts"]:
                if not u["familyName"].replace(" ", "").lower().startswith(want.replace(" ", "").lower()):
                    fails.append(f"{want} text also set in {u['familyName']} ({u['glyphCount']} glyphs)")
        browser.close()
    # Chromium lays out in 1/64 px; round to 0.01 mm so a block placed exactly
    # on the safe edge does not read as 6.999 mm and fail.
    boxes = {n: g.Box(n, round(x / k, 2), round(y / k, 2), round(w / k, 2), round(h_ / k, 2))
             for n, x, y, w, h_ in raw}
    return boxes, fails


def clear_space_check(r: g.GateResult, boxes: dict, lock_h: float) -> None:
    """Nothing may sit within half the mark height of the lockup."""
    lk = boxes["lockup"]
    pad = lock_h / 2
    zone = g.Box("lockup+clear", lk.x - pad, lk.y - pad, lk.w + 2 * pad, lk.h + 2 * pad)
    hits = [b.name for n, b in boxes.items() if n != "lockup" and
            b.x < zone.x + zone.w and zone.x < b.x + b.w and b.y < zone.y + zone.h and zone.y < b.y + b.h]
    r.add("lockup clear space (half the mark height)", not hits,
          "clear" if not hits else f"intruded by {hits}")


# ---------------------------------------------------------------------------
# Links and codes
# ---------------------------------------------------------------------------

MATRIX = links.link_matrix(FACTS["links"]["home"], CAMPAIGN, {
    "business_card": "card", "dl_flyer": "flyer", "poster_a2": "poster", "pullup_banner": "banner"})
# E-mail gets utm_medium=email, the value analytics tools group e-mail traffic
# by; link_matrix would file it under "social".
MATRIX.update({a: links.tag(FACTS["links"]["home"], "email", "email", CAMPAIGN, a)
               for a in ("email_signature", "email_header")})


def qr(asset: str, usage: str, side: float, x: float, y: float) -> tuple[str, g.Box, float, make_qr.QRSymbol]:
    sym = make_qr.build(str(MATRIX[asset]), ecc=make_qr.choose_ecc(usage))
    side = max(side, sym.min_side_mm())
    # qr_block draws its white plaque 2 mm OUTSIDE the point it is given; offset
    # so (x, y) is the plaque's corner and the whole block is placed as one box.
    pad = 2.0
    html, box, mod = L.qr_block(sym, side, x + pad, y + pad, f"{asset}-qr", plaque_pad_mm=pad,
                                dark=C["ink"], light="#FFFFFF", eye_colour=C["accent"])
    return html.replace("<div", f'<div data-box="qr"', 1) if "data-box" not in html else html, box, mod, sym


# ---------------------------------------------------------------------------
# Print pieces. Coordinates are page millimetres (bleed included). Text blocks
# flow in flex columns between fixed anchors; the measured layout feeds gate 1,
# so overflow and collisions are caught with real text metrics.
# ---------------------------------------------------------------------------

PAPER = f"<div class='a' style='inset:0;background:{C['paper']}'></div>"   # the warm paper, to the bleed


def margin_panel(page: g.Page, x: float, colour: str) -> tuple[str, g.Box]:
    """The margin: a panel from x to the bleed edge, full height, over the paper.
    The notes and the code live here -- a scholium in the margin of the page."""
    b = g.Box("margin", x, 0, page.page_w - x, page.page_h)
    return (PAPER + f"<div class='a' style='left:{x}mm;top:0;width:{b.w}mm;height:{page.page_h}mm;"
            f"background:{colour}'></div>"), b


def column(x: float, y: float, w: float, h: float, blocks: list[str], justify="space-between",
           gap: float = 0) -> str:
    return (f"<div class='a' style='left:{x}mm;top:{y}mm;width:{w}mm;height:{h}mm;display:flex;"
            f"flex-direction:column;justify-content:{justify};gap:{gap}mm'>" + "".join(blocks) + "</div>")


def hero_block(lines: list[str], size_mm: float, weight: int, line_h: float,
               accent_every: int = 0) -> tuple[str, float]:
    cap = cap_for(size_mm, weight)
    spans = [dcap(t, cap, weight, C["accent"] if accent_every and i % accent_every == accent_every - 1
                  else C["ink"]) for i, t in enumerate(lines)]
    # Lines are set explicitly and must not wrap. width:max-content makes the
    # measured box the TEXT's width, so a line the browser sets wider than the
    # font-file fit becomes a gate-1 overflow instead of a silent re-wrap.
    return (f"<div data-box='hero' style='line-height:{line_h};white-space:nowrap;width:max-content'>"
            + "<br>".join(spans) + "</div>"), cap


def notes_block(items: list[str], size: str, rule: str, pad: str, gap: str) -> str:
    return "".join(
        f"<div data-box='note-{i}' style='border-top:{rule} solid {C['accent']};padding-top:{pad};"
        f"margin-bottom:{gap}'>" + txt(p, "Inter", size, C["ink"], 500,
                                       "line-height:1.3;display:block;text-wrap:balance")
        + "</div>" for i, p in enumerate(items))


def gate(page, boxes, fails, panel=None, caps=None, qr_mod=None, lock_h=None) -> g.GateResult:
    r = g.gate1(page, content=list(boxes.values()), background_edges=[panel] if panel else [],
                cap_heights_mm=caps or {}, qr_module_mm=qr_mod)
    if lock_h:
        clear_space_check(r, boxes, lock_h)
    r.add("no font fallback", not fails, "every element in its face" if not fails else "; ".join(fails[:3]))
    return r


def piece_card() -> dict:
    page = g.Page.for_piece("card", REGION)
    dist = g.VIEWING_DISTANCE_MM["card"]
    s = page.safe_box
    # FRONT: dark ground, the dark lockup centred, the tagline at the foot.
    lock_h = 11.0
    lk, lk_w = lockup(lock_h, "mm", "dark")
    tag_cap = 1.9
    front = (f"<div class='a' style='inset:0;background:{C['dark_paper']}'></div>"
             f"<div class='a' style='left:{(page.page_w - lk_w) / 2:.3f}mm;"
             f"top:{page.page_h / 2 - lock_h * 0.85:.3f}mm'>{lk}</div>"
             f"<div class='a' data-box='tagline' style='left:{s.x}mm;width:{s.w}mm;top:{s.y2 - 6}mm;"
             f"text-align:center'>{dcap(FACTS['business']['tagline'], tag_cap, 300, C['dark_ink2'])}</div>")
    # BACK: the page on the left, the margin on the right holding the code.
    panel_x = 52.0
    panel_html, panel = margin_panel(page, panel_x, C["margin_note"])
    _h, probe, _m, _s = qr("business_card", "card", 0, 0, 0)
    q_html, q_box, q_mod, sym = qr("business_card", "card", 0, s.x2 - probe.w, page.page_h / 2 - probe.h / 2)
    col = panel_x - 4 - s.x
    size = min(dfit(t, col, 400, 4.0) for t in COPY["hero_lines"])
    hero, hero_cap = hero_block(COPY["hero_lines"], size, 400, 1.38)
    foot = (f"<div><div style='border-top:0.25mm solid {C['rule']};margin-bottom:2.4mm'></div>"
            f"<div data-box='url'>" + txt("scholium.fyi", "Inter", "3.2mm", C["accent"], 600) + "</div></div>")
    back = panel_html + column(s.x, s.y + 2, col, s.h - 2, [hero, foot]) + q_html
    gates = []
    for side_name, body_ in (("front", front), ("back", back)):
        boxes, fails = inspect_layout(print_doc(page, body_), page.page_w, page.page_h, mm=True)
        if side_name == "front":
            gates.append(("front", gate(page, boxes, fails, caps={"tagline": (tag_cap, dist, g.ATTENTIVE)},
                                        lock_h=lock_h)))
        else:
            gates.append(("back", gate(page, boxes, fails, panel=panel,
                                       caps={"hero": (hero_cap, dist, g.ATTENTIVE)},
                                       qr_mod={"card_qr": q_mod})))
    sheet = (f"<div style='position:relative;width:{page.page_w}mm;height:{page.page_h}mm;overflow:hidden;"
             f"break-after:page'>{front}</div>"
             f"<div style='position:relative;width:{page.page_w}mm;height:{page.page_h}mm;overflow:hidden'>{back}</div>")
    return dict(name="01-business-card", page=page, body=sheet, multipage=True,
                proofs=[("front", front), ("back", back)], qr_side="back", gates=gates, dist=dist,
                payloads=[str(MATRIX["business_card"])], fonts=[DISPLAY, "Inter"],
                qr=(q_box.w, q_mod, sym.version, sym.ecc), proof_scale=4)


def piece_flyer() -> dict:
    page = g.Page.for_piece("flyer_dl", REGION)
    dist = g.VIEWING_DISTANCE_MM["flyer"]
    s = page.safe_box
    panel_x = page.page_w - page.bleed - 25
    panel_html, panel = margin_panel(page, panel_x, C["margin_note"])
    col = panel_x - 5 - s.x
    lock_h = 9.0
    lk, _ = lockup(lock_h, "mm", "light")
    size = min(dfit(t, col, 700, 9.0) for t in COPY["hero_lines"])
    hero, hero_cap = hero_block(COPY["hero_lines"], size, 700, 1.24)
    feats = "".join(
        f"<div data-box='feature-{k}' style='margin-top:{0 if i == 0 else 4.2}mm'>"
        + dcap(COPY[k]["head"], 2.4, 400, C["ink"], line_height="1.3", display="block", text_wrap="balance")
        + "<div style='height:1.3mm'></div>"
        + txt(COPY[k]["body"], "Source Serif 4", "2.9mm", C["ink2"], 400, "line-height:1.4;display:block")
        + "</div>" for i, k in enumerate(("provenance", "review", "record")))
    lede = (f"<div data-box='lede'>" + txt(COPY["lede"]["text"], "Source Serif 4", "3.45mm", C["ink"], 400,
                                          "line-height:1.45;display:block") + "</div>")
    _h, probe, _m, _s = qr("dl_flyer", "flyer", 30.0, 0, 0)
    q_html, q_box, q_mod, sym = qr("dl_flyer", "flyer", 30.0, s.x, s.y2 - probe.h)
    url = (f"<div class='a' data-box='url' style='left:{q_box.x + q_box.w + 3.5}mm;top:{q_box.y + q_box.h / 2 - 5}mm;"
           f"width:{panel_x - 5 - (q_box.x + q_box.w + 3.5)}mm'>"
           + txt("scholium.fyi", "Inter", "3.6mm", C["accent"], 600, "display:block")
           + txt(FACTS["business"]["tagline"], "Inter", "2.3mm", C["ink2"], 400, "display:block;margin-top:1mm;line-height:1.3")
           + "</div>")
    notes = notes_block(COPY["promises"]["items"], "2.45mm", "0.35mm", "1.5mm", "5mm")
    body = (panel_html
            + column(s.x, s.y, col, q_box.y - 7 - s.y, [f"<div>{lk}</div>", hero, lede, f"<div>{feats}</div>"])
            + column(panel_x + 3, s.y + 52, s.x2 - panel_x - 3, 100, [notes], justify="flex-start")
            + q_html + url)
    boxes, fails = inspect_layout(print_doc(page, body), page.page_w, page.page_h, mm=True)
    r = gate(page, boxes, fails, panel=panel, caps={"hero": (hero_cap, dist, g.ATTENTIVE)},
             qr_mod={"flyer_qr": q_mod}, lock_h=lock_h)
    return dict(name="02-dl-flyer", page=page, body=body, proofs=[("front", body)], gates=[("front", r)],
                dist=dist, payloads=[str(MATRIX["dl_flyer"])], fonts=[DISPLAY, "Source Serif 4", "Inter"],
                qr=(q_box.w, q_mod, sym.version, sym.ecc), proof_scale=2.5)


POSTER_LINES = ["The preprint,", "signed.", "The review,", "open.", "The record,", "kept."]


def piece_poster() -> dict:
    page = g.Page.for_piece("a2", REGION, safe=14)
    dist = g.VIEWING_DISTANCE_MM["poster"]
    s = page.safe_box
    panel_x = page.page_w - page.bleed - 110
    panel_html, panel = margin_panel(page, panel_x, C["margin_note"])
    col = panel_x - 16 - s.x
    lock_h = 26.0
    lk, _ = lockup(lock_h, "mm", "light")
    assert " ".join(POSTER_LINES) == COPY["hero"]["text"], "poster lines drifted from the hero copy"
    size = min(dfit(t, col, 700, 60.0) for t in POSTER_LINES)
    hero, hero_cap = hero_block(POSTER_LINES, size, 700, 1.08, accent_every=2)
    lede_mm = 12.6                                   # cap 0.67 x 12.6 = 8.44 mm >= 8.33: ATTENTIVE at 2.5 m
    lede = (f"<div data-box='lede'>" + txt(COPY["lede"]["text"], "Source Serif 4", f"{lede_mm}mm", C["ink"], 400,
                                          "line-height:1.38;display:block") + "</div>")
    feats = ("<div style='display:flex;gap:12mm'>" + "".join(
        f"<div data-box='feature-{k}' style='flex:1'>"
        + dcap(COPY[k]["head"], 5.0, 400, C["ink"], line_height="1.25", display="block", text_wrap="balance")
        + "<div style='height:4mm'></div>"
        + txt(COPY[k]["body"], "Source Serif 4", "6.2mm", C["ink2"], 400, "line-height:1.42;display:block")
        + "</div>" for k in ("provenance", "review", "record")) + "</div>")
    pw = s.x2 - (panel_x + 12)
    want = make_qr.build(str(MATRIX["poster_a2"]), ecc=make_qr.choose_ecc("poster")).side_for_distance_mm(800)
    _h, probe, _m, _s = qr("poster_a2", "poster", min(want, pw - 4), 0, 0)
    q_html, q_box, q_mod, sym = qr("poster_a2", "poster", min(want, pw - 4), s.x2 - probe.w, s.y2 - probe.h - 20)
    url = (f"<div class='a' data-box='url' style='left:{q_box.x}mm;top:{q_box.y + q_box.h + 5}mm'>"
           + txt("scholium.fyi", "Inter", "10mm", C["accent"], 600) + "</div>")
    notes = notes_block(COPY["promises"]["items"], "7mm", "0.8mm", "4mm", "12mm")
    body = (panel_html
            + column(s.x, s.y, col, s.h, [f"<div>{lk}</div>", hero, lede, feats])
            + column(panel_x + 12, s.y + 150, pw, q_box.y - 20 - (s.y + 150), [notes], justify="flex-start")
            + q_html + url)
    boxes, fails = inspect_layout(print_doc(page, body), page.page_w, page.page_h, mm=True)
    r = gate(page, boxes, fails, panel=panel,
             caps={"hero": (hero_cap, dist, g.GLANCE), "lede": (lede_mm * 0.67, dist, g.ATTENTIVE)},
             qr_mod={"poster_qr": q_mod}, lock_h=lock_h)
    return dict(name="03-poster-a2", page=page, body=body, proofs=[("front", body)], gates=[("front", r)],
                dist=dist, payloads=[str(MATRIX["poster_a2"])], fonts=[DISPLAY, "Source Serif 4", "Inter"],
                qr=(q_box.w, q_mod, sym.version, sym.ecc), proof_scale=0.6)


def piece_banner() -> dict:
    tw, th = g.TRIM_SIZES_MM[REGION]["banner_pullup"]
    page = g.Page(tw, th, bleed=0, safe=40)
    dist = g.VIEWING_DISTANCE_MM["banner"]
    s = page.safe_box
    panel_x = 640.0
    panel_html, panel = margin_panel(page, panel_x, C["margin_note"])
    col = panel_x - 30 - s.x
    lock_h = 80.0
    lk, _ = lockup(lock_h, "mm", "light")
    # Eye level (1450-1750 mm off the floor) holds three lines, so the headline
    # is fitted to the column, not stacked like the poster's.
    size = min(dfit(t, col, 700, 140.0) for t in COPY["hero_lines"])
    hero, hero_cap = hero_block(COPY["hero_lines"], size, 700, 1.16)
    lede_mm = 23.0                                   # cap 15.4 mm
    lede = (f"<div data-box='lede'>" + txt(COPY["lede"]["text"], "Source Serif 4", f"{lede_mm}mm", C["ink"], 400,
                                          "line-height:1.36;display:block") + "</div>")
    # The code sits at CHEST height: its centre 1100 mm off the floor.
    q_side = 180.0
    q_html, q_box, q_mod, sym = qr("pullup_banner", "banner", q_side, s.x, 2050 - 1100 - q_side / 2 - 2)
    url = (f"<div class='a' data-box='url' style='left:{q_box.x + q_box.w + 24}mm;top:{q_box.y + q_box.h / 2 - 20}mm'>"
           + txt("scholium.fyi", "Inter", "32mm", C["accent"], 600) + "</div>")
    # Below the code is where people stand close: the three features, body text
    # still at the 1:300 cap height for 2.5 m (12.6 mm x 0.67 = 8.44 mm).
    body_mm = 15.0
    feats = "".join(
        f"<div data-box='feature-{k}' style='margin-top:{0 if i == 0 else 34}mm'>"
        + dcap(COPY[k]["head"], 15.0, 400, C["ink"], line_height="1.2", display="block", text_wrap="balance")
        + "<div style='height:7mm'></div>"
        + txt(COPY[k]["body"], "Source Serif 4", f"{body_mm}mm", C["ink2"], 400, "line-height:1.4;display:block")
        + "</div>" for i, k in enumerate(("provenance", "review", "record")))
    notes = notes_block(COPY["promises"]["items"], "16mm", "1.4mm", "8mm", "34mm")
    tagline = (f"<div class='a' data-box='tagline' style='left:{s.x}mm;top:1690mm;width:{col}mm'>"
               + dcap(FACTS["business"]["tagline"], 21, 300, C["dark_ink"], line_height="1.35", display="block",
                      text_wrap="balance") + "</div>")
    feat_top = q_box.y + q_box.h + 60
    body = (panel_html
            + f"<div class='a' style='left:{s.x}mm;top:110mm'>{lk}</div>"
            + column(s.x, 300, col, q_box.y - 50 - 300, [hero, lede], justify="flex-start", gap=36)
            + q_html + url
            + column(s.x, feat_top, col, 1570 - feat_top, [feats], justify="flex-start")
            + column(panel_x + 30, 300, s.x2 - panel_x - 30, 900, [notes], justify="flex-start")
            + f"<div class='a' style='left:0;top:1600mm;width:{panel_x}mm;height:400mm;background:{C['dark_paper']}'></div>"
            + tagline)
    boxes, fails = inspect_layout(print_doc(page, body), page.page_w, page.page_h, mm=True)
    r = gate(page, boxes, fails, caps={"hero": (hero_cap, dist, g.GLANCE),
                                       "lede": (lede_mm * 0.67, dist, g.ATTENTIVE),
                                       **{f"feature-{k}": (body_mm * 0.67, dist, g.ATTENTIVE)
                                          for k in ("provenance", "review", "record")}},
             qr_mod={"banner_qr": q_mod}, lock_h=lock_h)
    top_f, bot_f = L.floor_height_mm(q_box.y, th), L.floor_height_mm(q_box.y + q_box.h, th)
    r.add("QR at chest height (1000-1200 mm off the floor)",
          L.CHEST_HEIGHT_MM[0] <= bot_f and top_f <= L.CHEST_HEIGHT_MM[1],
          f"top edge {top_f:.0f} mm, bottom edge {bot_f:.0f} mm off the floor")
    hb = boxes["hero"]
    r.add("headline at eye level (1450-1750 mm off the floor)",
          L.floor_height_mm(hb.y + hb.h, th) >= 1450 and L.floor_height_mm(hb.y, th) <= 1750,
          f"{L.floor_height_mm(hb.y, th):.0f} down to {L.floor_height_mm(hb.y + hb.h, th):.0f} mm off the floor")
    return dict(name="04-pullup-banner", page=page, body=body, proofs=[("front", body)], gates=[("front", r)],
                dist=dist, payloads=[str(MATRIX["pullup_banner"])], fonts=[DISPLAY, "Source Serif 4", "Inter"],
                qr=(q_box.w, q_mod, sym.version, sym.ecc), proof_scale=0.3)


# ---------------------------------------------------------------------------
# Digital pieces (CSS px == output px)
# ---------------------------------------------------------------------------

def dpx(text: str, font_px: float, weight: int, colour: str, **css) -> str:
    """Display text at a font size in px (via the cap-height helper)."""
    return dcap(text, cap_for(font_px, weight) / PX_PER_MM, weight, colour, **css)


def pxcol(x, y, w, h, blocks, justify="space-between") -> str:
    return (f"<div class='a' style='left:{x}px;top:{y}px;width:{w}px;height:{h}px;display:flex;"
            f"flex-direction:column;justify-content:{justify}'>" + "".join(blocks) + "</div>")


def strip(w, h, sw):
    return f"<div class='a' style='right:0;top:0;width:{sw}px;height:{h}px;background:{C['margin_note']}'></div>"


def url_px(size):
    return "<div>" + txt("scholium.fyi", "Inter", f"{size}px", C["accent"], 600) + "</div>"


def two_tone(first: str, second: str, size: float, weight: int) -> str:
    # One block per phrase: Chromium does not balance a block that holds a <br>.
    return (f"<div style='line-height:1.12'>"
            f"<div style='text-wrap:balance'>{dpx(first, size, weight, C['ink'])}</div>"
            f"<div style='text-wrap:balance'>{dpx(second, size, weight, C['accent'])}</div></div>")


def social_pieces() -> list[dict]:
    out = []
    tl = FACTS["business"]["tagline"]

    w = h = 1080                                       # 1:1 -- provenance
    lk, _ = lockup(60, "px")
    pv = COPY["provenance"]
    body = strip(w, h, 150) + pxcol(90, 90, 800, h - 180, [
        f"<div>{lk}</div>", two_tone("Signed by you.", "Checkable by anyone.", 100, 400),
        "<div>" + txt(pv["body"], "Source Serif 4", "38px", C["ink2"], 400, "line-height:1.45;display:block") + "</div>",
        url_px(34)])
    out.append(dict(name="10-social-square-1x1", w=w, h=h, html=px_doc(w, h, body, C["paper"]), story=False,
                    alt=f"Scholium. {pv['head']} {pv['body']} scholium.fyi"))

    w, h = 1080, 1350                                  # 4:5 -- open review
    rv = COPY["review"]
    body = strip(w, h, 150) + pxcol(90, 100, 800, h - 200, [
        f"<div>{lk}</div>", two_tone("Peer review,", "out in the open.", 104, 400),
        "<div>" + txt(rv["body"], "Source Serif 4", "40px", C["ink2"], 400, "line-height:1.45;display:block") + "</div>",
        url_px(36)])
    out.append(dict(name="11-social-portrait-4x5", w=w, h=h, html=px_doc(w, h, body, C["paper"]), story=False,
                    alt=f"Scholium. {rv['head']} {rv['body']} scholium.fyi"))

    w, h = 1080, 1920                                  # 9:16 -- inside the story safe band
    top, bottom = int(h * verify_digital.STORY_SAFE_TOP), int(h * verify_digital.STORY_SAFE_BOTTOM)
    lk2, _ = lockup(72, "px")
    hero = ("<div style='line-height:1.15'>" + "<br>".join(
        dpx(t, 92, 700, C["accent"] if i % 2 else C["ink"]) for i, t in enumerate(POSTER_LINES)) + "</div>")
    body = strip(w, h, 150) + pxcol(100, top + 30, 820, h - top - bottom - 60, [
        f"<div>{lk2}</div>", hero,
        "<div>" + txt(COPY["lede"]["text"], "Source Serif 4", "40px", C["ink2"], 400, "line-height:1.45;display:block") + "</div>",
        url_px(44)])
    out.append(dict(name="12-social-story-9x16", w=w, h=h, html=px_doc(w, h, body, C["paper"]), story=True,
                    alt=f"Scholium. {COPY['hero']['text']} {COPY['lede']['text']} scholium.fyi"))

    w, h = 1200, 630                                   # 1.91:1 -- link preview
    lk3, _ = lockup(64, "px")
    body = strip(w, h, 140) + pxcol(90, 80, 900, h - 160, [
        f"<div>{lk3}</div>", f"<div>{dpx(tl, 64, 400, C['ink'], line_height='1.15', display='block')}</div>",
        url_px(34)])
    out.append(dict(name="13-link-preview-1.91x1", w=w, h=h, html=px_doc(w, h, body, C["paper"]), story=False,
                    alt=f"Scholium: {tl}. scholium.fyi"))

    w = h = 800                                        # avatar: the delivered tile, unchanged
    t = 0.72 * w
    body = (f"<div class='a' style='left:{(w - t) / 2}px;top:{(h - t) / 2}px;width:{t}px;height:{t}px'>"
            # count=1: only the <svg> element's size. The tile's own <rect> also
            # says width="32" height="32"; resizing it too blows the tile up past
            # its viewBox and clips it.
            + TILE_SVG.replace('width="32" height="32"', f'width="{t:.0f}" height="{t:.0f}"', 1) + "</div>")
    out.append(dict(name="14-profile-avatar-1x1", w=w, h=h, html=px_doc(w, h, body, C["paper"]), story=False,
                    alt="Scholium logo: a blue tile with a page and a closing bracket"))

    # Cover: a 16:9 MASTER. Headers are 3:1, 4:1 and others, and they change, so
    # the content sits in the band any of them keeps (a 4:1 crop is y 300-780)
    # and right of centre, where profile avatars do not overlap it.
    w, h = 1920, 1080
    lk4, _ = lockup(150, "px")
    body = strip(w, h, 150) + pxcol(620, 320, 1120, 440, [
        f"<div>{lk4}</div>", f"<div>{dpx(tl, 78, 300, C['ink'], line_height='1.15', display='block')}</div>"])
    out.append(dict(name="15-profile-cover-16x9-master", w=w, h=h, html=px_doc(w, h, body, C["paper"]),
                    story=False, alt=f"Scholium: {tl}"))
    return out


def email_pieces() -> list[dict]:
    out = []
    tl = FACTS["business"]["tagline"]
    w, h = 1200, 300                                   # 600 x 150 at 2x
    lk, _ = lockup(104, "px")
    body = (strip(w, h, 80) + f"<div class='a' style='left:64px;top:98px'>{lk}</div>"
            f"<div class='a' style='left:640px;top:108px;width:470px'>"
            f"{dpx(tl, 42, 300, C['ink'], line_height='1.3', display='block', text_wrap='balance')}</div>")
    out.append(dict(name="20-email-header-2x", w=w, h=h, html=px_doc(w, h, body, C["paper"]),
                    story=False, email=True, alt=f"Scholium: {tl}"))
    w, h = 440, 120                                    # 220 x 60 at 2x, opaque so dark mode cannot invert it
    lk2, lk2_w = lockup(72, "px")
    out.append(dict(name="21-email-signature-lockup-2x", w=w, h=h,
                    html=px_doc(w, h, f"<div class='a' style='left:{(w - lk2_w) / 2}px;top:24px'>{lk2}</div>",
                                C["paper"]), story=False, email=True, alt="Scholium"))
    return out


def write_signature() -> pathlib.Path:
    """HTML e-mail signature: real text, the image only as decoration (clients block images)."""
    url = H.escape(str(MATRIX["email_signature"]), quote=True)
    tl = H.escape(FACTS["business"]["tagline"])
    sig = f"""<!-- Scholium e-mail signature. Paste into your mail client's HTML signature.
     Host 21-email-signature-lockup-2x.png and replace LOCKUP_URL with its address. -->
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="font-family:Inter,Arial,sans-serif;color:{C['ink']}">
  <tr><td style="padding:0 0 6px 0"><a href="{url}"><img src="LOCKUP_URL" width="220" height="60" alt="Scholium" style="display:block;border:0"></a></td></tr>
  <tr><td style="font-size:13px;line-height:18px;color:{C['ink2']}">{tl}</td></tr>
  <tr><td style="font-size:13px;line-height:18px"><a href="{url}" style="color:{C['accent']};text-decoration:none;font-weight:600">scholium.fyi</a></td></tr>
</table>
"""
    p = OUT / "email-signature.html"
    p.write_text(sig, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def domain_resolves(url: str) -> bool:
    host = urllib.parse.urlsplit(url).hostname
    try:
        socket.getaddrinfo(host, 443)
        return True
    except OSError:
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="card,flyer,poster,banner,social,email")
    only = set(ap.parse_args().only.split(","))
    OUT.mkdir(parents=True, exist_ok=True)
    live = domain_resolves(FACTS["links"]["home"])
    prefix = "" if live else "DRAFT-"
    host = urllib.parse.urlsplit(FACTS["links"]["home"]).hostname
    print(f"REGION {REGION} (from brand.json)   DOMAIN {host}: "
          f"{'resolves' if live else 'DOES NOT RESOLVE -- print files are DRAFT, no PDF/X written'}")

    problems = links.audit(MATRIX)
    print("GATE 3 (link matrix):", "PASS" if not problems else "FAIL")
    for pb in problems:
        print("   XX", pb)
    with open(OUT / "links.csv", "w", newline="") as fh:
        wr = csv.writer(fh)
        wr.writerow(["asset", "utm_source", "utm_medium", "utm_campaign", "utm_content", "url"])
        for a, lk in MATRIX.items():
            wr.writerow([a, lk.source, lk.medium, lk.campaign, lk.content, lk.url])
    all_ok = not problems

    builders = {"card": piece_card, "flyer": piece_flyer, "poster": piece_poster, "banner": piece_banner}
    printed = []
    for key, fn in builders.items():
        if key not in only:
            continue
        pc = fn()
        page = pc["page"]
        pdf = render.html_to_pdf(print_doc(page, pc["body"], multipage=pc.get("multipage", False)),
                                 OUT / f"{prefix}{pc['name']}.pdf", page.page_w, page.page_h,
                                 trim_mm=(page.trim_w, page.trim_h) if page.bleed else None,
                                 bleed_mm=page.bleed)
        # Human-review proofs: same layout, trim (red) and safe (blue) guides. Never the deliverable.
        sc = pc["proof_scale"]
        for side_name, side_body in pc["proofs"]:
            suffix = f"-{side_name}" if len(pc["proofs"]) > 1 else ""
            render.html_to_png(print_doc(page, side_body, guides=True),
                               OUT / "proofs" / f"{pc['name']}{suffix}.png",
                               int(page.page_w * PX_PER_MM * sc), int(page.page_h * PX_PER_MM * sc), scale=sc)
        side, mod, ver, ecc = pc["qr"]
        print(f"\n--- {pdf.name}   QR {side:.1f} mm, v{ver} ECC {ecc}, "
              f"{mod:.3f} mm/module (footprint / span, quiet zone included)")
        for side_name, r in pc["gates"]:
            print(f"    GATE 1 ({side_name}): " + r.report().replace("\n", "\n      "))
            all_ok &= r.passed
        # verify_print rasterises page 1 only, so a two-sided piece is verified
        # one page at a time, expecting the code only on the side that carries it.
        sides = [(None, pdf, pc["payloads"])]
        if pc.get("multipage"):
            from pypdf import PdfReader, PdfWriter
            reader = PdfReader(str(pdf))
            sides = []
            for i, (side_name, _b) in enumerate(pc["proofs"]):
                wr_ = PdfWriter()
                wr_.add_page(reader.pages[i])
                one = OUT / "_pages" / f"{pc['name']}-{side_name}.pdf"
                one.parent.mkdir(parents=True, exist_ok=True)
                with open(one, "wb") as fh:
                    wr_.write(fh)
                sides.append((side_name, one, pc["payloads"] if side_name == pc.get("qr_side") else None))
        for side_name, sp, payloads in sides:
            r2 = verify_print.verify(sp, expect_trim_mm=(page.trim_w, page.trim_h) if page.bleed else None,
                                     expect_bleed_mm=page.bleed if page.bleed else None,
                                     expect_payloads=payloads,
                                     # per side, only the face every side uses; the whole
                                     # document is held to all three by pdf_font_check below
                                     expect_fonts=[DISPLAY] if side_name else pc["fonts"],
                                     viewing_distance_mm=pc["dist"], allowed_facts=str(FACTS_PATH))
            print(f"    GATE 2 (artefact{', ' + side_name if side_name else ''}): {'PASS' if r2.passed else 'FAIL'}")
            for c in r2.checks:
                tag = "--" if c.get("advisory") else ("ok" if c["passed"] else "XX")
                print(f"      [{tag}] {c['check']}: {c['detail'][:110]}")
            all_ok &= r2.passed
        fok, fdetail = pdf_font_check(pdf, pc["fonts"])
        print(f"      [{'ok' if fok else 'XX'}] fonts real, named and brand faces present: {fdetail[:110]}")
        all_ok &= fok
        printed.append((pc, pdf))

    digital = []
    if "social" in only:
        digital += social_pieces()
    if "email" in only:
        digital += email_pieces()
        write_signature()
    alt_lines = []
    for d in digital:
        _boxes, fails = inspect_layout(d["html"], d["w"], d["h"], mm=False)
        png = render.html_to_png(d["html"], OUT / f"{d['name']}.png", d["w"], d["h"])
        r = verify_digital.verify(png, expect_px=(d["w"], d["h"]), story_safe_areas=d["story"])
        # The durable-ratio rule is for feed and platform images. E-mail images are
        # sized to the ~600 px message body instead (references/digital.md), so for
        # them that one check is reported as not applicable, never silently dropped.
        na = {"ratio is a durable one"} if d.get("email") else set()
        ok = all(c["passed"] for c in r.checks if c["check"] not in na) and not fails
        print(f"--- {png.name}  GATE 2 (digital): {'PASS' if ok else 'FAIL'}")
        for c in r.checks:
            tag = "--" if c["check"] in na else ("ok" if c["passed"] else "XX")
            note = "  (n/a: e-mail image, sized to the 600 px body)" if c["check"] in na else ""
            print(f"      [{tag}] {c['check']}: {c['detail'][:100]}{note}")
        print(f"      [{'ok' if not fails else 'XX'}] no font fallback: "
              f"{'every element in its face' if not fails else '; '.join(fails[:3])}")
        all_ok &= ok
        alt_lines.append(f"- `{png.name}`: {d['alt']}")
    if alt_lines:
        # Merge by file name: a selective run must not drop the entries of
        # pieces it was not asked to rebuild.
        alt_path = OUT / "alt-text.md"
        entries = {}
        if alt_path.exists():
            for ln in alt_path.read_text(encoding="utf-8").splitlines():
                m_ = re.match(r"- `([^`]+)`:", ln)
                if m_:
                    entries[m_.group(1)] = ln
        for ln in alt_lines:
            entries[re.match(r"- `([^`]+)`:", ln).group(1)] = ln
        alt_path.write_text("# Alt text\n\n" + "\n".join(entries[k] for k in sorted(entries)) + "\n",
                            encoding="utf-8")

    print("\nPREPRESS (PDF/X-4, output intent declared; no CMYK conversion -- the printer converts)")
    for pc, pdf in printed:
        cond = "LARGEFORMAT" if "banner" in pc["name"] else "FOGRA51"
        title = f"Scholium - {pc['name'][3:].replace('-', ' ')}"
        with tempfile.TemporaryDirectory() as tmp:
            dest = (OUT / "print-ready") if live else pathlib.Path(tmp)
            pr = prepress.make_print_ready(pdf, title, condition=cond, cmyk=False, out_dir=dest)
            pf = pr["preflight"]
            where = pathlib.Path(pr["output"]).name if live else "HELD (domain does not resolve)"
            print(f"   {pc['name']:<22} {cond:<12} preflight {'PASS' if pf['passed'] else 'FAIL'}   -> {where}")
            for c in pf["checks"]:
                if not c["passed"]:
                    print(f"      {'XX' if c['severity'] == 'error' else '--'} {c['check']}: {c['detail'][:90]}")
            all_ok &= pf["passed"]

    print("\n" + ("ALL GATES PASS" if all_ok else "GATES FAILED")
          + ("" if live else "   (print files are DRAFT until the domain resolves)"))
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
