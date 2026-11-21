# Fonts for the social share cards

`brand-card.tsx` draws the share cards with Satori (`next/og`). Satori reads
TTF, OTF and WOFF, but **not WOFF2**, and it does not interpolate variable
axes. The web fonts in `public/fonts/` are variable WOFF2, so the cards use
these static WOFF instances of the same files instead. Nothing here is served
to browsers; the files are read from disk by the route handlers.

| File | Family | Instance | Used for |
| --- | --- | --- | --- |
| `source-serif-4-semibold.woff` | Source Serif 4 | `wght 600`, `opsz 36` | paper title |
| `inter-regular.woff` | Inter | `wght 400` | site card tagline |
| `inter-medium.woff` | Inter | `wght 500` | status word, authors |
| `jetbrains-mono-medium.woff` | JetBrains Mono | `wght 500` | the `sch:` id |

They carry the same Latin subset as `public/fonts/`. `drawableText` in
`brand-card.tsx` lists the code points all four have a glyph for; text outside
that set never reaches Satori, because `next/og` would otherwise fetch a font
for it from Google Fonts with the text in the URL.

## Regenerating

With [fontTools](https://github.com/fonttools/fonttools) and `brotli`:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

font = TTFont("public/fonts/source-serif-4-latin.woff2")
static = instancer.instantiateVariableFont(font, {"wght": 600, "opsz": 36})
static.flavor = "woff"
static.save("source-serif-4-semibold.woff")
```

Repeat per row above (`inter-latin.woff2` at 400 and 500, `jetbrains-mono-latin.woff2`
at 500). If you change the set of glyphs, update `DRAWABLE_RANGES` to match.

## Licence

Source Serif 4, Inter and JetBrains Mono are licensed under the SIL Open Font
License 1.1; the licence text is in [`OFL.txt`](./OFL.txt), a copy of
`public/fonts/OFL.txt`. See `public/fonts/README.md` for the copyright lines.
