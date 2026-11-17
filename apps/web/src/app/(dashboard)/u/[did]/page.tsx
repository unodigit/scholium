import type { Metadata } from "next";
import { cache } from "react";

import { ProfilePage } from "../../../../features/dashboard/profile-page";
import {
  decodeProfileDid,
  describeProfileError,
  loadProfile,
  profileDisplayName,
  profileShortDid,
  type ProfileData,
} from "../../../../features/dashboard/profile";

/**
 * `/u/{did}` — a member's public profile.
 *
 * The profile is a public read and its DID comes from the URL, so there is
 * nothing useful to prerender; `force-dynamic` also keeps `next build` from
 * calling the API when it is not up at build time.
 */
export const dynamic = "force-dynamic";

interface ProfileRouteProps {
  /** `/u/{did}` (Next 15: params arrive as a promise). */
  params: Promise<{ did: string }>;
}

/**
 * One read of the profile per request, shared by the title and the page: Next
 * runs `generateMetadata` and the page separately, and both want the member's
 * name. A failed read is a message, not a throw — the page shows it, and the
 * title falls back to the short DID.
 */
const readProfile = cache(
  async (did: string): Promise<{ profile?: ProfileData; error?: string }> => {
    try {
      return { profile: await loadProfile(did) };
    } catch (error) {
      return { error: describeProfileError(error) };
    }
  },
);

/**
 * The tab is titled with who the page is about — "{name} · Scholium" once the
 * layout adds its suffix — or, for a member with no name (or an erased or
 * unreachable profile), their short pseudonymous DID.
 */
export async function generateMetadata({
  params,
}: ProfileRouteProps): Promise<Metadata> {
  const { did } = await params;
  const decodedDid = decodeProfileDid(did);
  const { profile } = await readProfile(decodedDid);
  const title = profile ? profileDisplayName(profile) : profileShortDid(decodedDid);
  return {
    title,
    description: `${title}'s public profile: affiliation, ORCID, trust tier, endorsements, papers and signed reviews.`,
  };
}

/**
 * `/u/{did}` — renders the profile for the DID in the URL.
 */
export default async function ProfileRoutePage({
  params,
}: ProfileRouteProps) {
  const { did } = await params;
  // The route segment is still percent-encoded; decode it once so the loader
  // encodes it again exactly once for `GET /v1/profiles/{did}`.
  const decodedDid = decodeProfileDid(did);

  const { profile: initialProfile, error: initialError } = await readProfile(decodedDid);

  return (
    <ProfilePage
      did={decodedDid}
      initialProfile={initialProfile}
      initialError={initialError}
    />
  );
}
