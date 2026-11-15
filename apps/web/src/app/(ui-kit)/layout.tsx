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
  return <main className="uk-shell">{children}</main>;
}
