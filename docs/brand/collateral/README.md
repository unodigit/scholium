# Scholium collateral

The print and digital marketing pieces, all generated from `brand.json` by `build.py`.

> **Status: DRAFT.** `scholium.fyi` has no DNS A record yet, so every QR code points at a URL
> that does not open. The print PDFs are named `DRAFT-…`, and no PDF/X file is written. When the
> domain resolves, run the build again: it writes `out/print-ready/*.pdf` (PDF/X-4) and drops the
> `DRAFT-` prefix. Preflight of those exports already passes.

## Pieces (`out/`)

| File | Size | Notes |
| --- | --- | --- |
| `DRAFT-01-business-card.pdf` | 90 × 55 mm, 3 mm bleed, 2 pages | Front: dark lockup and tagline. Back: hero lines, URL, QR in the margin. |
| `DRAFT-02-dl-flyer.pdf` | 99 × 210 mm (DL), 3 mm bleed | |
| `DRAFT-03-poster-a2.pdf` | 420 × 594 mm (A2), 3 mm bleed | Headline sized for 2.5 m. |
| `DRAFT-04-pullup-banner.pdf` | 850 × 2000 mm, no bleed | QR at chest height, headline at eye level (allows for the cassette). |
| `10-social-square-1x1.png` | 1080 × 1080 | |
| `11-social-portrait-4x5.png` | 1080 × 1350 | |
| `12-social-story-9x16.png` | 1080 × 1920 | Content inside the story safe band (top 14 %, bottom 20 %). |
| `13-link-preview-1.91x1.png` | 1200 × 630 | For posts that take a custom preview. The app serves its own Open Graph images. |
| `14-profile-avatar-1x1.png` | 800 × 800 | The delivered tile, unchanged, sized to survive a circular crop. |
| `15-profile-cover-16x9-master.png` | 1920 × 1080 | Crop to each platform's header ratio. The content sits in the band a 3:1 or 4:1 crop keeps, right of centre. |
| `20-email-header-2x.png` | 1200 × 300 | A 600 px newsletter header at 2× resolution. |
| `21-email-signature-lockup-2x.png` + `email-signature.html` | 440 × 120 | Signature in HTML text. Host the PNG and replace `LOCKUP_URL`. |

Also in `out/`:

- `proofs/` holds review images with the trim line (red) and the safe area (blue) marked. Never send these to a printer.
- `links.csv` lists every tagged link.
- `alt-text.md` has alt text for every image.

Pixel sizes are masters at durable ratios. Check each platform's current upload spec before posting.

## Links and QR codes

Each print piece's QR code carries its own tags: `utm_source` = card, flyer, poster or banner; `utm_medium=qr_print`; `utm_campaign=beta`. E-mail uses `utm_medium=email`. Scholium has no analytics, so for now visits show up only in server or Cloudflare logs.

QR sizes are computed from the **tagged** URL, which needs version 8 to 10 rather than version 3 for the bare URL. Each code is decoded back out of its PDF on every build.

Social posts are not tagged yet. Name the platforms and add a row per platform.

## Telling the printer

- **File format:** PDF/X-4 with an output intent of FOGRA51, or LARGEFORMAT for the banner. The files are RGB, and the printer converts them with the profile for their press. Ask the shop which print condition they run, and change it in `build.py` if they name another.
- **Background tint:** the warm paper colour `#FBFAF7` is printed as a light tint to the bleed. The alternative is a warm-white stock with no tint. Ask the printer which looks cleaner on their press.
- **Card:** the dark front wants a matt or soft-touch laminate, which resists scuffing and scans better than gloss.
- **Banner:** use blockout (opaque) media with a matt laminate. The cassette swallows the bottom 100 mm. Ask whether the supplier wants a flat tail.

## Rules the build enforces

- The display face (`docs/brand/type/`) never sets digits, URLs, IDs or e-mail addresses.
- The lockup is the delivered geometry and token colours, keeps clear space of half its height, and never goes smaller than 20 px.
- Every text element is checked for silent font fallback. No PDF may contain a Type 3 or unnamed font, because Chromium embeds CFF and variable fonts as Type 3. The build therefore renders from TrueType instances it generates in `out/_render-fonts/`.
- All copy is quoted from `docs/homepage/index.html`, and `brand.json` cites the source of each line.

## Rebuilding

```bash
uv run --project ~/.claude/skills/generating-business-collateral --with brotli \
    python docs/brand/collateral/build.py [--only card,flyer,poster,banner,social,email]
```

The build never deletes files, so a selective run leaves the other pieces alone. It needs the locally patched skill (see `docs/brand/type/README.md`) on Python 3.12.
