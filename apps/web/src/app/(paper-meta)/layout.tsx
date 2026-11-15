import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./paper-meta.css";

/**
 * Shell for the standalone Versions and Files page (`/meta/…`).
 *
 * `(paper-meta)` is a route group: it adds this layout without adding a URL
 * segment. The tabs themselves, and their styles, come from
 * `features/paper-meta`; the paper page mounts the same components in its
 * margin panel. This page is the deep link: it gives the version timeline and
 * the file list room to be read on their own.
 */
export default function PaperMetaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="pmeta-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
