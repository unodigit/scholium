import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

/**
 * Shared shell for the submit pages (`/submit`, and later `/consent/[version]`).
 *
 * `(submit)` is a route group: it adds this layout without adding a URL
 * segment. The page content and its styles come from `features/submit`.
 */
export default function SubmitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <GlobalNav />
      <main className="sw-shell">{children}</main>
      <NavTabBarSpacer />
    </>
  );
}
