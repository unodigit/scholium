import type { Metadata } from "next";

import { OnboardingForm } from "../../../features/web-auth/onboarding-form";

export const metadata: Metadata = {
  title: "Welcome · Scholium",
  description:
    "Set up Scholium: your passkey, ORCID iD, categories to follow and recovery guardians.",
};

/**
 * `/onboarding` — where a brand-new account lands after its first sign-in.
 *
 * The four first-run steps (passkey created, link ORCID iD, pick categories
 * to follow, set recovery guardians) live in `OnboardingForm`; guardians are
 * required before the first submission, so the finish action stays gated
 * until that step is done.
 */
export default function OnboardingPage() {
  return <OnboardingForm />;
}
