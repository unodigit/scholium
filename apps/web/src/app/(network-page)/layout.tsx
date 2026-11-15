import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./network-page.css";

/**
 * Shared shell for the public network transparency pages.
 *
 * `(network-page)` is a route group: it adds this layout without adding a URL
 * segment, so the page lives at `/network`. The page is public, so the shell
 * carries the global navigation; auth screens (`(web-auth)`) stay bare.
 */
export default function NetworkLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="np-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
