import type { Metadata } from "next";

import { VerifyPage } from "../../../features/verify-page/verify-page";

export const metadata: Metadata = {
  title: "Verify a file",
  description:
    "Check in your browser that a file is exactly what the authors of a Scholium paper signed. The file never leaves your device.",
};

interface VerifyRoutePageProps {
  /** `/verify` or `/verify?id=sch:6sel-2dio-orm6/v2` (Next 15: a promise). */
  searchParams: Promise<{ id?: string | string[] }>;
}

/** Longest id taken from the URL: a real version id is under 30 characters. */
const MAX_ID_LENGTH = 200;

/**
 * `/verify` — compare a file you hold with what a version's authors signed.
 *
 * The page only reads the URL for a starting id, so a paper page can link to
 * `/verify?id=sch:…/v2`. Everything else runs in the reader's browser (the page
 * is a client component): the file is fingerprinted there, so it is never
 * uploaded, and the first HTML says nothing about any file.
 */
export default async function VerifyRoutePage({ searchParams }: VerifyRoutePageProps) {
  const { id } = await searchParams;
  const initialId = (Array.isArray(id) ? id[0] : id) ?? "";

  return (
    <>
      <header className="vps-header">
        <p className="vps-kicker mono-id">scholium / verify</p>
        <h1 className="vps-title">Verify a file</h1>
        <p className="vps-lede">
          Drop a file you downloaded and Scholium checks, in your browser, that
          it is exactly what the authors signed. The file never leaves your
          device.
        </p>
      </header>

      <VerifyPage initialId={initialId.slice(0, MAX_ID_LENGTH)} />
    </>
  );
}
