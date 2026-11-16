import type { Metadata } from "next";

import { OrcidReturn } from "../../../../features/web-auth/onboarding-form";

export const metadata: Metadata = {
  title: "Linking your ORCID iD · Scholium",
  description: "Finishing the link between your Scholium account and your ORCID iD.",
  // The address carries a one-time authorization code and a signed state until
  // the page has taken them out of it: keep the page out of search indexes and
  // never send that address on as a referrer.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `/onboarding/orcid` — the redirect URI the API gives ORCID.
 *
 * ORCID sends the browser here with `?code=…&state=…`. The page POSTs them to
 * `POST /v1/auth/orcid/complete` with the signed-in user's token, so the link is
 * made for the user who is actually at this browser — and only if they are the
 * one who started it. (ORCID used to redirect to an unauthenticated API
 * endpoint, which let anyone who completed the redirect link their iD to
 * whichever account had started the flow.)
 */
export default function OnboardingOrcidPage() {
  return <OrcidReturn />;
}
