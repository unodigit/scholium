import type { Metadata } from "next";

import {
  paperRouteMetadata,
  renderPaperRoute,
} from "../../../../../features/paper-page";

/** See `../page.tsx`: the page reads live data for an id taken from the URL. */
export const dynamic = "force-dynamic";

interface VersionRouteProps {
  /**
   * `/p/k3f9-q2xz-7mwd/v2` (Next 15: params arrive as a promise).
   *
   * Next.js cannot match the `v` of `v2` as part of a segment name, so the
   * whole `v2` arrives as `version` and is checked here: anything that is not
   * `v` and a positive whole number is reported as not a paper address.
   */
  params: Promise<{ id: string; version: string }>;
}

export async function generateMetadata({
  params,
}: VersionRouteProps): Promise<Metadata> {
  const { id, version } = await params;
  return paperRouteMetadata([id, version]);
}

/** `/p/{id}/v{n}` — the paper page for one version of the paper. */
export default async function PaperVersionRoutePage({
  params,
}: VersionRouteProps) {
  const { id, version } = await params;
  return renderPaperRoute([id, version]);
}
