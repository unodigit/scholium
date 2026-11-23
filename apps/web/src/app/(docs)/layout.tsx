import { GlobalNav, NavTabBarSpacer } from "../../components/nav";
import { DocsShell } from "../../features/docs/docs-shell";
import { chapters } from "../../features/docs/handbook";

/**
 * Shared shell for the handbook pages (`/docs`, `/docs/{chapter}`).
 *
 * `(docs)` is a route group: it adds this layout without adding a URL
 * segment, so the pages' own `page.tsx` files decide the routes. The
 * handbook is a public read, so the shell carries the global navigation;
 * auth screens (`(web-auth)`) stay bare.
 *
 * The chapter list is read here on the server — the handbook module reads
 * `docs/handbook/` from disk at build time, never in the browser — and is
 * handed to the shell as plain `{ title, href }` links, so no file-system
 * code reaches the client bundle.
 */
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const chapterLinks = chapters.map(({ title, href }) => ({ title, href }));

  return (
    <>
      <GlobalNav />
      <main className="ds-main">
        <DocsShell chapters={chapterLinks}>{children}</DocsShell>
      </main>
      {/* Keeps content clear of the fixed mobile tab bar (components/nav). */}
      <NavTabBarSpacer />
    </>
  );
}
