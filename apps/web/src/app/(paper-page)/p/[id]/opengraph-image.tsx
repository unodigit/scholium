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
 * `/p/{id}/opengraph-image` — what a link to a paper unfurls to: title,
 * first three authors, `sch:` id, status and the small lockup
 * (`features/ui-kit/brand-card.tsx`). Also serves `/p/{id}/v{n}`, which
 * inherits its parent's card: the paper's newest listed version.
 *
 * **Only the public catalog is read, and anonymously.** `GET /v1/papers/{id}`
 * lists a version only once it is listed; in moderation, held, awaiting
 * consent or tombstoned it answers `404`. A `404`, a network failure, a
 * timeout, a body that is not a paper or text the card cannot draw all end the
 * same way: the site card, which names no paper. So an unlisted title can
 * never reach a link preview, whoever asks. The request carries no token even
 * if the server process held one.
 *
 * **Short caching.** `next/og` marks its output immutable for a year; a paper's
 * status, title and listing change, so the card lives five minutes (a minute
 * for the fallback, which a listing or a recovered API replaces soon).
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
        // The client's default is `include`; a card reads as nobody.
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

    // The card names three authors, so only their profiles are read: a paper
    // with two hundred authors is still three requests.
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
