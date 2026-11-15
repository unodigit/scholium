import type { Metadata } from "next";

import { RecoverForm } from "../../../features/web-auth/recover-form";

export const metadata: Metadata = {
  title: "Recover your account · Scholium",
  description:
    "Lost your device? Identify your Scholium account by ORCID iD, follow your guardians' approvals and cancel during the 72-hour safety window.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/recover` — the lost-device flow from `docs/design.md` §6.
 *
 * `?request=rec_…` is the link sent to known contacts: it opens directly on
 * that request's progress, where a device holding the old passkey can cancel.
 * `?orcid=` prefills the identify form when a link carries the iD.
 */
export default async function RecoverPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { request, orcid } = await searchParams;
  return <RecoverForm requestId={first(request)} initialOrcid={first(orcid)} />;
}
