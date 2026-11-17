import {
  BRAND_CARD_ALT,
  BRAND_CARD_CONTENT_TYPE,
  BRAND_CARD_SIZE,
  SITE_CARD,
  SITE_CARD_CACHE_CONTROL,
  renderBrandCard,
} from "../features/ui-kit/brand-card";

/**
 * `/opengraph-image` — the site's share card: the glyph and the lowercase
 * wordmark on paper, with the tagline (docs/design.md §2).
 *
 * Next serves it as `image/png` and adds the matching `og:image` tags to every
 * page that does not have a card of its own (`/p/{id}` has one). The card has
 * no inputs, so it is rendered once at build time.
 *
 * `src/app` inherits `jsx: "preserve"`, which vitest cannot transform, so this
 * file holds no JSX; the markup lives in `features/ui-kit/brand-card.tsx`.
 */

export const alt = BRAND_CARD_ALT;
export const size = BRAND_CARD_SIZE;
export const contentType = BRAND_CARD_CONTENT_TYPE;

export default function Image() {
  return renderBrandCard(SITE_CARD, { headers: { "cache-control": SITE_CARD_CACHE_CONTROL } });
}
