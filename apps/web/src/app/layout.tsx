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
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
        {/* Under every page, including the ones that hold the session back:
            the links in it are public. */}
        <SiteFooter />
      </body>
    </html>
  );
}
