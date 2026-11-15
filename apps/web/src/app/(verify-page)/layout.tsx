import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./verify-page.css";

/**
 * Shell for the Verify a file page (`/verify`).
 *
 * `(verify-page)` is a route group: it adds this layout without adding a URL
 * segment, so the page lives at `/verify`. The page itself, and its styles,
 * come from `features/verify-page`. Verifying is public (no account), so the
 * shell carries the global navigation.
 */
export default function VerifyPageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="vps-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
