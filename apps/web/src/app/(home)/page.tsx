import type { Metadata } from "next";

import {
  HomePage,
  homeJsonLd,
  homeMetadata,
  serializeJsonLd,
} from "../../features/home";

/**
 * The absolute title, the description, the canonical URL and the Open Graph
 * and Twitter cards (docs/design.md §5.9, "GEO surfaces").
 */
export const metadata: Metadata = homeMetadata();

/**
 * The homepage is prerendered: it reads no request, calls no API and fetches
 * nothing at build time, so there is nothing to render per visit. `force-static`
 * keeps it that way if a later change reaches for cookies or headers.
 */
export const dynamic = "force-static";

/**
 * `/` — the public front door: the homepage's sections and one JSON-LD
 * `@graph` describing the site, built from the same data as the visible FAQ.
 *
 * A legacy feed link (`/?tab=…`, `/?category=…`, `/?sort=…`) never reaches this
 * page: `next.config.js` redirects it permanently to `/papers`.
 */
export default function HomeRoutePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(homeJsonLd()) }}
      />
      <HomePage />
    </>
  );
}
