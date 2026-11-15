import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./policies-page.css";

/**
 * Shared shell for the public policy pages.
 *
 * `(policies-page)` is a route group: it adds this layout without adding a URL
 * segment, so the page lives at `/policies`. Policies are public, so the shell
 * carries the global navigation; auth screens (`(web-auth)`) stay bare.
 */
export default function PoliciesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="pp-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
