import type { Metadata } from "next";

import { VerifyEmailForm } from "../../../features/web-auth/verify-email-form";

export const metadata: Metadata = {
  title: "Verify your email",
  description: "Confirm the email address saved on your Scholium account.",
  // The address carries a bearer token until the page has consumed it: keep
  // the page out of search indexes and never send the address on as a referrer.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `/verify-email` — where an emailed verification link lands.
 *
 * The API mails `<web origin>/verify-email?did=…&token=…`; this page takes the
 * one-time values out of the address bar and POSTs the token to
 * `POST /v1/profiles/{did}/verify-email` (the API route only accepts POST, so
 * pointing the email at the API could never work). The form shows the result,
 * explains an expired link and offers a resend.
 */
export default function VerifyEmailPage() {
  return <VerifyEmailForm />;
}
