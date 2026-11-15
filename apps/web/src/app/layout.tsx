import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scholium",
  description: "Decentralized preprint and peer-review network",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}