import type { Metadata } from "next";

import {
  compareRouteMetadata,
  renderCompareRoute,
} from "../../../../../../features/paper-page";

/**
 * A comparison is read live: versions and their text change as authors publish
 * and as the node extracts text, and the id comes from the URL. `force-dynamic`
 * also keeps `next build` from calling the API when it is not up.
 */
export const dynamic = "force-dynamic";

interface CompareRouteProps {
  /**
   * `/p/k3f9-q2xz-7mwd/compare/1..2` (Next 15: params arrive as a promise).
   *
   * `compare` is a static segment, so `/p/{id}/v{n}` is unaffected. The range
   * arrives whole (`"1..2"`) and is checked in `features/paper-page`.
   */
  params: Promise<{ id: string; range: string }>;
}

export async function generateMetadata({
  params,
}: CompareRouteProps): Promise<Metadata> {
  const { id, range } = await params;
  return compareRouteMetadata([id, "compare", range]);
}

/**
 * `/p/{id}/compare/{from}..{to}` — the paragraph diff between two versions,
 * opened from the Versions tab. Everything it does lives in
 * `features/paper-page`.
 */
export default async function CompareRoutePage({ params }: CompareRouteProps) {
  const { id, range } = await params;
  return renderCompareRoute([id, "compare", range]);
}
