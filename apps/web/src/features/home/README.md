# features/home

The public homepage at `/` (docs/design.md §5.9; copy and layout from
`docs/homepage/index.html`).

- **Route.** `app/(home)/` owns `/`: `layout.tsx` (an inline script that sets
  `data-home-js` on `<html>` before first paint, then `HomeNav`, then `<main>`)
  and `page.tsx` (the metadata, one JSON-LD script and `HomePage`). No global
  navigation and no mobile tab bar. The page is forced static: it reads no
  request and calls no API.
- **Sections**, in the reference's order, assembled by `home-page.tsx`: Hero,
  FactsStrip, Statement, ProvenanceSection, OpenReviewSection,
  AiPrereviewSection, VerifyBand, RolesSection, HowItWorksSection,
  CompareSection, PrinciplesSection, NameSection, FaqSection, FinalCta.
  `index.ts` exports them all.
- **Machine-readable surfaces.** `structured-data.ts` builds the metadata
  (`homeMetadata`) and the JSON-LD `@graph` (`homeJsonLd`). Every URL comes from
  `resolveSiteUrl()`; `serializeJsonLd` escapes every `<`. The `FAQPage` is built
  from `faq.ts`, the same data the visible FAQ renders.
- **Shared.** `home.css` (and the per-section stylesheets), `icons.tsx`,
  `reveal.tsx` (one shared `IntersectionObserver`), `reveal-scan.tsx` (registers
  every reveal block with it, so no block stays hidden), `spring.ts`.

## Rules the code keeps

- Every word is in the server-rendered HTML. Hidden start states exist only under
  `html[data-home-js]`, so with scripts off nothing is hidden.
- No hex literal, no external request, no raster image, no animation library.
  Colour is a token from `styles/tokens.css`.
- `faq.ts` (the data) and `faq.tsx` (the section) share a basename. Next's
  bundler resolves a bare `./faq` to the `.tsx`, Vite to the `.ts`, so each is
  imported with its extension (`./faq.ts`, `./faq.tsx`).
- Interaction and structure are covered by `*.test.tsx` here and by the browser
  journeys in `tests/e2e/home.spec.ts`.
