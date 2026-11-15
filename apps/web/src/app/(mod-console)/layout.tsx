import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./mod-console.css";

/**
 * Shared shell for the moderation console.
 *
 * `(mod-console)` is a route group: it adds this layout without adding a URL
 * segment, so the console lives at `/mod`. The shell carries the global
 * navigation; whether a visitor may see the queue is decided by the API (and
 * explained on the page), not by the layout.
 */
export default function ModConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="mc-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
