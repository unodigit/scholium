import type { Metadata } from "next";

import {
  PaperRefError,
  refFromSegments,
  type PaperRef,
} from "../../../../features/paper-proof/paper-ref";
import {
  ProofNotice,
  ProofTab,
} from "../../../../features/paper-proof/proof-tab";

interface ProofPageProps {
  /** `/proof/k3f9-q2xz-7mwd` or `/proof/k3f9-q2xz-7mwd/v2` (Next 15: a promise). */
  params: Promise<{ ref: string[] }>;
}

type Parsed = { ref: PaperRef } | { error: string };

function parse(segments: string[]): Parsed {
  try {
    return { ref: refFromSegments(segments) };
  } catch (error) {
    return {
      error: error instanceof PaperRefError ? error.message : "That is not a paper id.",
    };
  }
}

export async function generateMetadata({ params }: ProofPageProps): Promise<Metadata> {
  const parsed = parse((await params).ref);
  return {
    title: "ref" in parsed ? `Proof of ${parsed.ref.schId}` : "Proof",
    description:
      "Check in your browser that a Scholium paper is signed by all its authors, its history is intact and its files match.",
  };
}

/**
 * `/proof/{id}[/v{n}]` — the Proof tab on a page of its own.
 *
 * The URL mirrors the paper page's (`/p/{id}[/v{n}]`, docs/design.md §4), so a
 * paper's proof is one path segment away from the paper. The page only reads
 * the URL: the verification itself runs in the reader's browser (the tab is a
 * client component), which is the point of the page. The server never says a
 * paper is verified.
 */
export default async function ProofPage({ params }: ProofPageProps) {
  const parsed = parse((await params).ref);

  return (
    <>
      <header className="ppf-header">
        <p className="ppf-kicker mono-id">
          scholium / proof{"ref" in parsed ? ` / ${parsed.ref.schId}` : ""}
        </p>
        <h1 className="ppf-title">Proof</h1>
        <p className="ppf-lede">
          This check runs in your browser. It reads the signed records and
          checks the signatures, links and files itself, instead of trusting the
          node&rsquo;s word that the paper is genuine.
        </p>
      </header>

      {"ref" in parsed ? (
        <ProofTab schId={parsed.ref.schId} />
      ) : (
        <ProofNotice message={parsed.error} />
      )}
    </>
  );
}
