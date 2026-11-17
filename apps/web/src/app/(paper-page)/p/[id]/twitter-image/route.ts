import Image from "../twitter-image";

/**
 * `/p/{id}/twitter-image` — the per-paper Twitter card at its plain URL.
 *
 * Mirrors the opengraph-image plain-URL handler so a direct request (and the
 * URL Next advertises) returns image/png instead of falling through to the
 * sibling `[version]` page.
 */

export const dynamic = "force-dynamic";

export function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return Image(context);
}
