import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./discussion.css";

/**
 * Shell for the standalone Discussion page (`/discussion/…`).
 *
 * `(paper-discussion)` is a route group: it adds this layout without adding a
 * URL segment. The tab itself, and its styles, come from
 * `features/paper-discussion`; the paper page mounts the same component in its
 * margin panel. This page is the deep link: it gives the threads room to be
 * read on their own.
 */
export default function PaperDiscussionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="pdisc-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
