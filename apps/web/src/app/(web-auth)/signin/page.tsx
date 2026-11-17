import type { Metadata } from "next";

import { SignInForm } from "../../../features/web-auth/signin-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Scholium with your passkey.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/signin` — sign in with the device key.
 *
 * `?next=/some/path` says where a returning user goes afterwards; the form
 * sanitises it, and a brand-new account always goes to `/onboarding`.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { next } = await searchParams;
  return <SignInForm next={Array.isArray(next) ? next[0] : next} />;
}
