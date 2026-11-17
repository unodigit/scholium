import type { Metadata } from "next";

import { ModDetail } from "../../../../features/mod-console/mod-detail";

interface ModDetailPageProps {
  /** The flagged record's cid to decide on (Next 15: a promise). */
  params: Promise<{ cid: string }>;
}

export async function generateMetadata({
  params,
}: ModDetailPageProps): Promise<Metadata> {
  const { cid } = await params;
  return {
    title: "Moderation decision · Scholium",
    description: `Decide on the flagged record ${cid}: read what was reported, cite a policy clause and give a reason.`,
  };
}

/**
 * `/mod/{cid}` — the moderation detail view (tier 4, docs/design.md §5.7).
 *
 * The `{cid}` is whatever a flag named: a paper version, a discussion post,
 * an annotation or a review. The route reads only the URL. The record, its
 * flags and the policy clauses are fetched in the browser, because the
 * decision is signed with the moderator's device key there; the server HTML
 * is the shell and a loading line, matching the first paint the client will
 * hydrate.
 */
export default async function ModDetailPage({ params }: ModDetailPageProps) {
  const { cid } = await params;
  return <ModDetail versionCid={cid} />;
}
