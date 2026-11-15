import type { Metadata } from "next";

import { SecurityPage } from "../../../../features/dashboard/security-page";

export const metadata: Metadata = {
  title: "Security · Scholium",
  description:
    "Your devices, recovery guardians (3 of 5), last key rotation and the option to rotate your signing key.",
};

/**
 * `/me/security` — the signed-in member's devices, recovery guardians and key.
 *
 * Like `/me`, it needs the account's bearer token and the device key, and both
 * exist only in the browser, so there is nothing to fetch on the server: the
 * page loads on the client and the API decides what to show.
 */
export default function MeSecurityRoutePage() {
  return <SecurityPage />;
}
