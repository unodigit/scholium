import type { Metadata } from "next";

import { SignInForm } from "../../../features/web-auth/signin-form";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Create a Scholium account with a passkey.",
};

export default function SignUpPage() {
  return <SignInForm signup />;
}
