import { parsePaperAddress } from "../../../../features/paper-page/paper-address";
import { loadPaper, loadProfile, type PaperClient } from "../../../../features/search-page/paper";
import {
  BRAND_CARD_CONTENT_TYPE,
  BRAND_CARD_SIZE,
  MAX_AUTHORS,
  PAPER_CARD_ALT,
  SITE_CARD,
  brandCardFor,
  renderBrandCard,
  type BrandCardProps,
} from "../../../../features/ui-kit/brand-card";
import { api, type ApiClient } from "../../../../lib/api";

/**
 * `/p/{id}/twitter-image` — the per-paper card for `twitter:image`.
 *
 * Twitter/X reads `twitter:image`, which Next only emits when this file
 * exists; without it the paper page falls back to the generic site card.
 * Delegates to the same card as `/p/{id}/opengraph-image` so the two cannot
 * drift, with the same unlisted/held/tombstone protection.
 */

export const alt = PAPER_CARD_ALT;
export const size = BRAND_CARD_SIZE;
export const contentType = BRAND_CARD_CONTENT_TYPE;

/** The id comes from the URL and the API from the network; nothing to prerender. */
export const dynamic = "force-dynamic";

interface PaperCardRouteProps {
  /** `/p/k3f9-q2xz-7mwd` (Next 15: params arrive as a promise). */
  params: Promise<{ id: string }>;
}

/** A crawler waits a few seconds at most; a slow node gets the site card, not a hung request. */
const LOAD_TIMEOUT_MS = 5000;

const PAPER_CARD_CACHE = "public, max-age=300, s-maxage=300";
const FALLBACK_CARD_CACHE = "public, max-age=60, s-maxage=60";

/** The API client without credentials: a card shows what everyone may see. */
function anonymousClient(signal: AbortSignal): PaperClient {
  return {
    get: <T = unknown,>(path: string, options: Parameters<ApiClient["get"]>[1] = {}) =>
      api.get<T>(path, {
        ...options,
        auth: false,
        retryOnUnauthorized: false,
        credentials: "omit",
        signal,
      }),
  };
}

/** Byline order by the position the version signed; unnumbered authors keep the order given, after numbered ones. */
function byBylinePosition(a: { position: number }, b: { position: number }): number {
  return (a.position || Number.MAX_SAFE_INTEGER) - (b.position || Number.MAX_SAFE_INTEGER);
}

/** The card for this paper, or the site card for any reason it cannot be a paper's. Never throws. */
async function cardFor(id: string): Promise<BrandCardProps> {
  const address = parsePaperAddress([id]);
  if (address === null) {
    return SITE_CARD;
  }
  try {
    const client = anonymousClient(AbortSignal.timeout(LOAD_TIMEOUT_MS));
    const paper = await loadPaper({ id: address.id, version: null }, client);
    const byline = [...paper.authors].sort(byBylinePosition);

    const names = await Promise.all(
      byline
        .slice(0, MAX_AUTHORS)
        .map((author) =>
          author.did === ""
            ? null
            : loadProfile(author.did, client).then(
                (profile) => profile.name,
                () => null,
              ),
        ),
    );

    return brandCardFor({
      title: paper.title,
      shortId: paper.shortId !== "" ? paper.shortId : address.id,
      status: paper.status,
      authors: byline.map((_, index) => ({ name: names[index] ?? null })),
    });
  } catch {
    return SITE_CARD;
  }
}

export default async function Image({ params }: PaperCardRouteProps) {
  const { id } = await params;
  const card = await cardFor(id);
  return renderBrandCard(card, {
    headers: {
      "cache-control": card.kind === "paper" ? PAPER_CARD_CACHE : FALLBACK_CARD_CACHE,
    },
  });
}
