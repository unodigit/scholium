"""Write the Scholium Display family: Light, Regular and Bold OTFs.

    uv run --project ~/.claude/skills/generating-business-collateral \
        python docs/brand/type/build_family.py

Draws each cut with the collateral skill's typeface tool (see cuts.py), then
fixes what the tool leaves generic so the three files behave as ONE family in a
font menu: weight class, style-linking bits and the typographic family names.
The tool writes usWeightClass 400 for every cut, so without this an app shows
three unrelated "Regular" fonts or merges them into one.

Then checks the family: the metrics a layout depends on must agree across the
three files (fonts.check_family), and every file must be embeddable (fsType 0).
"""
from __future__ import annotations

import os
import pathlib
import sys

SKILL = pathlib.Path(os.environ.get(
    "COLLATERAL_SKILL", "~/.claude/skills/generating-business-collateral")).expanduser()
sys.path.insert(0, str(SKILL / "scripts"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import fonts  # noqa: E402
import typeface  # noqa: E402
from cuts import CUTS  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "fonts"
FAMILY = "Scholium Display"


def family_files() -> dict[str, pathlib.Path]:
    return {style: OUT / f"ScholiumDisplay-{style}.otf" for _k, style, *_ in CUTS}


def build() -> dict[str, pathlib.Path]:
    from fontTools.ttLib import TTFont
    paths = {}
    for _key, style, params, weight, _use in CUTS:
        out = OUT / f"ScholiumDisplay-{style}.otf"
        typeface.build(typeface.Design(**params), FAMILY, style, out,
                       designer="Scholium", licence="Owned by Scholium. All outlines "
                       "drawn parametrically; no third-party font data.")
        f = TTFont(out)
        os2, head, name = f["OS/2"], f["head"], f["name"]
        os2.usWeightClass = weight
        bold = style == "Bold"
        # fsSelection: bit 5 BOLD, bit 6 REGULAR. macStyle bit 0 BOLD.
        os2.fsSelection = (os2.fsSelection & ~((1 << 5) | (1 << 6) | 1)) | \
            ((1 << 5) if bold else (1 << 6))
        head.macStyle = (head.macStyle & ~1) | (1 if bold else 0)
        # RIBBI linking: Regular and Bold share nameID 1; Light is its own
        # legacy family with style "Regular". IDs 16/17 carry the real names.
        legacy_family = FAMILY if style in ("Regular", "Bold") else f"{FAMILY} {style}"
        legacy_style = style if style in ("Regular", "Bold") else "Regular"
        for rec in list(name.names):
            if rec.nameID in (1, 2, 16, 17):
                name.removeNames(nameID=rec.nameID)
        for nid, val in ((1, legacy_family), (2, legacy_style), (16, FAMILY), (17, style)):
            name.setName(val, nid, 3, 1, 0x409)
            name.setName(val, nid, 1, 0, 0)
        f.save(out)
        paths[style] = out
    return paths


def main() -> int:
    paths = build()
    problems = fonts.check_family([str(p) for p in paths.values()])
    ok = not problems
    for style, p in paths.items():
        a = fonts.audit(p)
        emb = a["embedding"]
        print(f"{style:8} {p.name:30} {a['glyphs']} glyphs  cap {a['cap_height']}/"
              f"{a['units_per_em']}  fsType {emb['fsType']} ({emb['permission']})")
        ok &= emb["fsType"] == 0
    print("family metrics:", "agree" if not problems else problems)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
