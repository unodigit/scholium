import "./web-auth.css";

/**
 * Shared shell for the web-auth pages (`/signin`, `/onboarding`, …).
 *
 * `(web-auth)` is a route group: it adds this layout without adding a URL
 * segment, so the pages below it live at `/signin` and `/onboarding`.
 */
export default function WebAuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <main className="wa-shell">{children}</main>;
}
