import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./paper-ai.css";

/**
 * Shell for the standalone AI pre-review page (`/ai/…`).
 *
 * `(paper-ai)` is a route group: it adds this layout without adding a URL
 * segment. The tab itself, and its styles, come from
 * `features/paper-ai`; the paper page mounts the same component in its
 * margin panel. This page is the deep link: a report is one path segment away
 * from the paper it advises on, and shares the panel a reader already knows.
 */
export default function PaperAiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="pai-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
