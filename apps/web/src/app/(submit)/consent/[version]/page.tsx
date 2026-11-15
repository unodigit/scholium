import type { Metadata } from "next";

import { ConsentPage } from "../../../../features/submit";

export const metadata: Metadata = {
  title: "Review and sign · Scholium",
  description:
    "Review a version of a paper you are listed on as a co-author, then accept or decline authorship with a signed record.",
  // The link is a personal invitation, not a page to find through search.
  robots: { index: false, follow: false },
};

interface ConsentRouteProps {
  /** `/consent/bafyrei…`: the id of the `paper.version` record (Next 15: a promise). */
  params: Promise<{ version: string }>;
}

/**
 * `/consent/[version]` — a co-author reviews a version and signs a
 * `coauthor.consent` to accept or decline authorship.
 *
 * The link is the one the API sends each listed author when a version enters
 * `awaiting_consent` (`apps/api/.../notifications/consent.py`). The route only
 * reads the URL; everything else (loading the version, checking it is the
 * record the link names, asking for the passkey, signing and submitting) runs
 * in the author's browser, because the signing key never leaves the device.
 */
export default async function ConsentRoute({ params }: ConsentRouteProps) {
  const { version } = await params;
  return <ConsentPage version={version} />;
}
