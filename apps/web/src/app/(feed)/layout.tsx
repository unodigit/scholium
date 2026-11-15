import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./feed-shell.css";

/**
 * Shell for the home feed.
 *
 * `(feed)` is a route group: it adds this layout without adding a URL
 * segment, so the feed's `page.tsx` is the site root `/`. The feed is a
 * public read, so the shell carries the global navigation; the page content
 * and its own styles come from `features/feed`.
 */
export default function FeedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="fd-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
