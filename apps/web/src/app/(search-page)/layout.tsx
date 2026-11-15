import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./search-page.css";

/**
 * Shell for `/search`.
 *
 * `(search-page)` is a route group: it adds this layout without adding a URL
 * segment. Search is a public read, so the shell carries the global
 * navigation; the page content and its own styles come from
 * `features/search-page`.
 */
export default function SearchLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="sp-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
