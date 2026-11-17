import Image from "../opengraph-image";

/**
 * `/p/{id}/opengraph-image` — the paper card at its plain URL.
 *
 * Next serves `../opengraph-image.tsx` and advertises it in `og:image`, but
 * because that file sits inside the `(paper-page)` route group it gives the
 * URL a hash suffix (`/p/{id}/opengraph-image-e8kbga`). The plain URL would
 * then fall through to the sibling `[version]` page, which answers `200
 * text/html` for it. This handler claims the plain path (a static segment
 * outranks `[version]`) and serves the same card, so both addresses return
 * `image/png`.
 */

export const dynamic = "force-dynamic";

export function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return Image(context);
}
