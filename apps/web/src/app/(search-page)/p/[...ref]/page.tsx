import type { Metadata } from "next";

import {
  PaperPage,
  describePaperError,
  loadPaperPage,
  parsePaperRoute,
} from "../../../../features/search-page";

export const metadata: Metadata = {
  title: "Paper · Scholium",
  description:
    "A listed paper with its authors, status, version, categories and licence.",
};

/**
 * The paper depends on live API data and its id comes from the URL; there is
 * nothing useful to prerender, and `force-dynamic` keeps `next build` from
 * calling the API when it is not up at build time.
 */
export const dynamic = "force-dynamic";

interface PaperRouteProps {
  /** Next.js 15 hands route params to the page as a promise. */
  params: Promise<{ ref?: string[] }>;
}

/**
 * `/p/{sch: id}` and `/p/{sch: id}/v{n}` — the paper page a `sch:` id in the
 * search field opens (feature 184).
 *
 * The catch-all `ref` carries either one segment (the paper's short id) or two
 * (the id and `vN`). `parsePaperRoute` accepts a record cid as well, because a
 * search hit without a short id links to its paper cid.
 *
 * The page is rendered on the server, so a shared paper link shows the title
 * and the Authors section in the first HTML response and works without
 * JavaScript. A failed lookup becomes a plain message with a way back to
 * search rather than a thrown error.
 */
export default async function PaperRoutePage({ params }: PaperRouteProps) {
  const { ref } = await params;
  const address = parsePaperRoute(ref ?? []);

  if (address === null) {
    return (
      <PaperPage error="That is not a paper address. Open a paper from search." />
    );
  }

  try {
    const paper = await loadPaperPage(address);
    return <PaperPage paper={paper} />;
  } catch (error) {
    return <PaperPage error={describePaperError(error)} />;
  }
}
