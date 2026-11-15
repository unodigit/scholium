import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./paper-reviews.css";

/**
 * Shell for the standalone Reviews page (`/reviews/…`).
 *
 * `(paper-reviews)` is a route group: it adds this layout without adding a URL
 * segment. The tab itself, and its styles, come from
 * `features/paper-reviews`; the paper page mounts the same component in its
 * margin panel. This page is the deep link: it gives the reviews room to be
 * read on their own.
 */
export default function PaperReviewsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="prs-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
