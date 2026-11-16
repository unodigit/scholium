import type { Metadata } from "next";

import { ProfilePage } from "../../../../features/dashboard/profile-page";
import {
  decodeProfileDid,
  describeProfileError,
  loadProfile,
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

export async function generateMetadata({
  params,
}: ProfileRouteProps): Promise<Metadata> {
  const { did } = await params;
  const decodedDid = decodeProfileDid(did);
  return {
    title: "Profile · Scholium",
    description: `A member's public profile: name, affiliation, ORCID, trust tier and signed reviews (${decodedDid}).`,
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

  let initialProfile: ProfileData | undefined;
  let initialError: string | undefined;

  try {
    initialProfile = await loadProfile(decodedDid);
  } catch (error) {
    initialError = describeProfileError(error);
  }

  return (
    <ProfilePage
      did={decodedDid}
      initialProfile={initialProfile}
      initialError={initialError}
    />
  );
}
