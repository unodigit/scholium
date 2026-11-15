import type { Metadata } from "next";

import { ModDetail } from "../../../../features/mod-console/mod-detail";

interface ModDetailPageProps {
  /** The version cid to decide on (Next 15: a promise). */
  params: Promise<{ cid: string }>;
}

export async function generateMetadata({
  params,
}: ModDetailPageProps): Promise<Metadata> {
  const { cid } = await params;
  return {
    title: "Moderation decision · Scholium",
    description: `Decide on the version ${cid}: read the paper, cite a policy clause and give the author a reason.`,
  };
}

/**
 * `/mod/{cid}` — the moderation detail view (tier 4, docs/design.md §5.7).
 *
 * The route reads only the URL. The paper and its policy clauses are fetched
 * in the browser, because the decision is signed with the moderator's device
 * key there; the server HTML is the shell and a loading line, matching the
 * first paint the client will hydrate.
 */
export default async function ModDetailPage({ params }: ModDetailPageProps) {
  const { cid } = await params;
  return <ModDetail versionCid={cid} />;
}
