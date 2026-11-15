import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Welcome · Scholium",
  description: "Set up your Scholium account.",
};

/**
 * `/onboarding` — where a brand-new account lands after its first sign-in.
 *
 * Placeholder landing: it confirms the passkey exists and lets the user on
 * into the app. The onboarding steps (link ORCID, pick categories, set
 * recovery guardians) are built on top of this route by the next web-auth
 * feature.
 */
export default function OnboardingPage() {
  return (
    <section className="wa-card" aria-labelledby="onboarding-heading">
      <p className="wa-wordmark">scholium</p>
      <h1 id="onboarding-heading" className="wa-title">
        Welcome
      </h1>
      <p className="wa-lede">
        Your account is ready. Your passkey is created and your key stays on
        this device.
      </p>
      <Link className="wa-button" href="/">
        Continue to Scholium
      </Link>
    </section>
  );
}
