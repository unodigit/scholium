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
      </body>
    </html>
  );
}
