import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./paper-page-shell.css";

/**
 * Shell for the paper page (`/p/{id}` and `/p/{id}/v{n}`).
 *
 * `(paper-page)` is a route group: it adds this layout without adding a URL
 * segment. A paper is a public read, so the shell carries the global
 * navigation; the page itself, and its styles, come from `features/paper-page`.
 */
export default function PaperPageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="ppg-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
