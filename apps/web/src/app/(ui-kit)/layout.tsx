import "./ui-kit.css";

/**
 * Shared shell for the UI-kit gallery pages (`/ui-kit/…`).
 *
 * `(ui-kit)` is a route group: it adds this layout without adding a URL
 * segment. Each component's gallery page lives in its own folder under
 * `ui-kit/`, so a new component adds a page here and edits nothing shared.
 */
export default function UiKitLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="uk-shell">
      <nav className="uk-nav" aria-label="UI kit components">
        <a href="/ui-kit/status-chip">Status chip</a>
        <a href="/ui-kit/record-link">Record link</a>
        <a href="/ui-kit/empty-state">Empty state</a>
        <a href="/ui-kit/decision-banner">Decision banner</a>
        <a href="/ui-kit/id-pill">ID pill</a>
      </nav>
      {children}
    </main>
  );
}
