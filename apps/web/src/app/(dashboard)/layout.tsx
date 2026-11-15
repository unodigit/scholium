import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./dashboard.css";

/**
 * Shell for the signed-in member's pages.
 *
 * `(dashboard)` is a route group: it adds this layout without adding a URL
 * segment, so the home screen lives at `/me`. The dashboard is private, but
 * it still carries the global navigation; a signed-out reader is asked to
 * sign in by the page itself rather than by the shell. Auth screens
 * (`(web-auth)`) stay bare on purpose.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="db-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
