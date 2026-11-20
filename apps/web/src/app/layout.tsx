import { SiteFooter } from "../components/footer";
import { SessionProvider } from "../lib/api/session-provider";

import "./globals.css";

export { metadata, viewport } from "./site-metadata";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // `suppressHydrationWarning` is for this element's own attributes only: the
    // homepage's layout script sets `data-home-js` on <html> before React
    // hydrates (docs/design.md section 5.9), which React's development build
    // would otherwise report as a mismatch on every load of `/`.
    <html lang="en" suppressHydrationWarning>
      <body>
        <SessionProvider>{children}</SessionProvider>
        {/* Under every page, including the ones that hold the session back:
            the links in it are public. */}
        <SiteFooter />
      </body>
    </html>
  );
}
