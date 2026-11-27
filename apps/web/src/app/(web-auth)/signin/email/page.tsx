import type { Metadata } from "next";

import { EmailLinkForm } from "../../../../features/web-auth/email-link-form";

export const metadata: Metadata = { title: "Confirm email sign-in" };

export default function EmailLinkPage() {
  return <EmailLinkForm />;
}
