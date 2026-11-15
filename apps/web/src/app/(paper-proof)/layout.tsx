import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

import "./paper-proof.css";

/**
 * Shell for the standalone Proof page (`/proof/…`).
 *
 * `(paper-proof)` is a route group: it adds this layout without adding a URL
 * segment. The Proof tab itself, and its styles, come from
 * `features/paper-proof`; the paper page mounts the same component in its
 * margin panel. This page is the deep link: it gives the check room to be read
 * on its own, and is what a verifier shares ("check it yourself: …").
 */
export default function PaperProofLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="ppf-shell">{children}</main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
