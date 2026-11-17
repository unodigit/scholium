import {
  BRAND_CARD_ALT,
  BRAND_CARD_CONTENT_TYPE,
  BRAND_CARD_SIZE,
  SITE_CARD,
  SITE_CARD_CACHE_CONTROL,
  renderBrandCard,
} from "../features/ui-kit/brand-card";

/**
 * `/twitter-image` — the same card as `/opengraph-image`.
 *
 * Twitter/X reads `twitter:image`, which Next only emits when this file
 * exists; a 1200 × 630 card is what its large summary card wants too. The card
 * itself lives in `features/ui-kit/brand-card.tsx`, so the two cannot drift.
 *
 * The exports are written out rather than re-exported from
 * `./opengraph-image`: Next's metadata loader reads them from this file's own
 * source and warns about a file that only re-exports.
 */

export const alt = BRAND_CARD_ALT;
export const size = BRAND_CARD_SIZE;
export const contentType = BRAND_CARD_CONTENT_TYPE;

export default function Image() {
  return renderBrandCard(SITE_CARD, { headers: { "cache-control": SITE_CARD_CACHE_CONTROL } });
}
