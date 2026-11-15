import type { Metadata } from "next";

import {
  paperRouteMetadata,
  renderPaperRoute,
} from "../../../../features/paper-page";

/**
 * A paper's reviews, status and files change independently of any deploy, and
 * its id comes from the URL; there is nothing useful to prerender.
 * `force-dynamic` also keeps `next build` from calling the API when it is not
 * up at build time.
 */
export const dynamic = "force-dynamic";

interface PaperRouteProps {
  /** `/p/k3f9-q2xz-7mwd` (Next 15: params arrive as a promise). */
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: PaperRouteProps): Promise<Metadata> {
  const { id } = await params;
  return paperRouteMetadata([id]);
}

/**
 * `/p/{id}` — the paper page, showing the paper's newest listed version.
 *
 * `/p/{id}/v{n}` (the sibling route) shows one version. Everything the page
 * does lives in `features/paper-page`.
 */
export default async function PaperRoutePage({ params }: PaperRouteProps) {
  const { id } = await params;
  return renderPaperRoute([id]);
}
