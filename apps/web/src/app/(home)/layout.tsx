import { HomeNav } from "../../features/home";

/**
 * Arms the homepage's animations. It runs while the browser is still parsing
 * `<body>`, before the content below it is painted, and sets `data-home-js` on
 * `<html>`; the hidden start states of the animations exist only under
 * `html[data-home-js]` (features/home/*.css). With scripts off, or for a
 * crawler, the attribute is never set and every word of the page is visible.
 */
const ARM_ANIMATIONS = 'document.documentElement.setAttribute("data-home-js","")';

/**
 * Shell for the homepage, `/`.
 *
 * `(home)` is a route group: it adds this layout without adding a URL segment.
 * The homepage is a presentation page with its own navigation bar, so unlike
 * every app screen it carries neither the global navigation nor the mobile tab
 * bar (docs/design.md §5.9). It sits inside the root layout's session provider
 * and above its site footer, which the page does not repeat.
 *
 * The script is the first child, so nothing renders before it has run.
 */
export default function HomeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: ARM_ANIMATIONS }} />
      <HomeNav />
      <main id="main">{children}</main>
    </>
  );
}
