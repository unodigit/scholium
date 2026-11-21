# Scholium Display

Scholium's own display face, for the **wordmark** and for **marketing headlines**. Drawn on 2026-11-21 with the
`generating-business-collateral` skill's typeface tool. Scholium owns the outlines outright
(no third-party font data, `fsType 0`).

| File | Weight | Use |
| --- | --- | --- |
| `fonts/ScholiumDisplay-Light.otf` | 300 | Close-read pieces: business card, social posts, e-mail |
| `fonts/ScholiumDisplay-Regular.otf` | 400 | General headlines, feature heads |
| `fonts/ScholiumDisplay-Bold.otf` | 700 | Distance pieces: poster, pull-up banner |

The cut settings are in `cuts.py`.

## What it is not

- **The wordmark is Bold, as outlines, never typed.** Since 2026-11-21, `scholium` in the lockup is Scholium Display Bold, drawn as outlines by `docs/brand/build_lockup.py` (`docs/design.md` §2). The face itself is not served to browsers or e-mail clients. `wordmark-comparison.png` is the side-by-side that preceded the decision.
- **Not a text or UI face.** It has one weight per cut, 89 glyphs and no accented letters. Reading text stays in Source Serif 4, UI text in Inter, and IDs and code in JetBrains Mono.
- **Not for codes.** A blind transcription test confused `0`/`O` and `I`/`l` in every cut. So no digits, URLs, IDs or e-mail addresses are ever set in it. `docs/brand/collateral/build.py` stops the build if one is.

## Files here

- `specimen.png` / `specimen.html` show the three cuts (A, B and C) beside Source Serif 4, set on real Scholium copy. All three were adopted as Light, Regular and Bold. `fonts/ScholiumDisplay-{A,B,C}-*.otf` are the files that sheet was made from.
- `specimen-report.json` is the audit: glyph coverage, embedding licence and similar-glyph pairs.
- `build_family.py` writes the three family OTFs. It sets weight classes and style links, and checks that the metrics agree.
- `build_specimens.py` regenerates the specimen. It fails if any text element falls back to another font, a check proven by reintroducing the original fallback bug.

## Rebuilding

```bash
uv run --project ~/.claude/skills/generating-business-collateral --with brotli python docs/brand/type/build_family.py
uv run --project ~/.claude/skills/generating-business-collateral --with brotli python docs/brand/type/build_specimens.py
```

These commands depend on the **locally patched** copy of the skill's `typeface.py`. The diff is `LOCAL-typeface-glyph-fixes.patch` in the skill folder. The upstream tool draws `g j y 3 6 9 ? &` broken, spaces `J ( ) f r c` and the round figures wrongly, and lacks `; " · # % →`.
