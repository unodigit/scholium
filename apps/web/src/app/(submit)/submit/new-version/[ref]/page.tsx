import type { Metadata } from "next";

import { NewVersionPage } from "../../../../../features/submit";

export const metadata: Metadata = {
  title: "Submit a new version · Scholium",
  description:
    "Publish the next version of a paper: the details pre-filled from its latest version, a change note, and a signed paper.version that extends it.",
};

interface NewVersionRouteProps {
  /** `/submit/new-version/sch:xxxx-xxxx-xxxx`: the paper to extend (Next 15: a promise). */
  params: Promise<{ ref: string }>;
}

/**
 * `/submit/new-version/[ref]` — the New version form the paper page links an
 * author to (feature 163).
 *
 * `ref` is the paper's `sch:` short id (or a record cid — the same spellings
 * `GET /v1/papers/{id}` accepts), URL-encoded by `newVersionHref`. The route
 * only reads the URL; loading the paper, the passkey prompt and signing all
 * run in the author's browser, because the signing key never leaves the
 * device.
 */
export default async function NewVersionRoute({ params }: NewVersionRouteProps) {
  const { ref } = await params;
  return <NewVersionPage paper={ref} />;
}
