import type { Metadata } from "next";

import { DocsIndex, docsHomeMetadata } from "../../../features/docs/docs-index";

/**
 * `/docs` — the docs home: what the handbook covers, a search field over the
 * chapter titles, sections and glossary, a "Start here" card per role and a
 * card per chapter.
 *
 * The page is built entirely from `docs/handbook/` at build time, so it is
 * prerendered: the request reads nothing and the first HTML response holds
 * every chapter card and link, even with JavaScript off. `force-static` keeps
 * it that way if a later change reaches for a request API.
 */
export const metadata: Metadata = docsHomeMetadata;

export const dynamic = "force-static";

export default function DocsHomePage() {
  return <DocsIndex />;
}
