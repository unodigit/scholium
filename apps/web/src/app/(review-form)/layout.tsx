import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./review-form-shell.css";

/**
 * Shared shell for the review form.
 *
 * `(review-form)` is a route group: it adds this layout without adding a URL
 * segment, so the form lives at `/review/[id]`. The shell carries the global
 * navigation; whether a visitor may commit a review is decided by the API, not
 * by the layout.
 */
export default function ReviewFormLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="rfs-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
