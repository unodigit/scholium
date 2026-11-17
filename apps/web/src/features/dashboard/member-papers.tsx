"use client";

/**
 * The "Papers" card on a member's public profile (`/u/{did}`): the listed
 * papers whose byline names them, newest first.
 *
 * `GET /v1/papers` has no author filter, so {@link loadMemberPapers} reads the
 * newest listed papers and keeps the member's. When it stopped before the end
 * of the catalog the card says so, instead of presenting a partial list as the
 * whole. A failed read is a message and a retry inside the card — the rest of
 * the profile is unaffected.
 *
 * Loading, failure and the empty state are announced through one polite live
 * region (no `role`), so they are read once and do not compete with the
 * profile's other status messages.
 */

import { useEffect, useState } from "react";

import { formatDate, paperHref, parseInstant, type FeedItem } from "../feed/feed";

import { loadMemberPapers, type MemberPapers } from "./profile";

/** Loads a member's papers; replaceable in tests. */
export type LoadMemberPapers = (did: string) => Promise<MemberPapers>;

/** Props for {@link MemberPapersCard}. */
export interface MemberPapersCardProps {
  /** The member whose papers to list. */
  readonly did: string;
  /** Replace the read of the papers, for tests. */
  readonly loadPapers?: LoadMemberPapers;
}

type PapersState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly result: MemberPapers };

export function MemberPapersCard({ did, loadPapers = loadMemberPapers }: MemberPapersCardProps) {
  const [state, setState] = useState<PapersState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (did === "") {
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadPapers(did).then(
      (result) => {
        if (!cancelled) setState({ status: "ready", result });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [did, loadPapers, attempt]);

  return (
    <section className="pp-card" aria-labelledby="pp-papers-heading">
      <h2 className="pp-card-heading" id="pp-papers-heading">
        Papers
      </h2>
      <div aria-live="polite" aria-busy={state.status === "loading"}>
        {state.status === "loading" ? <p className="pp-muted">Loading papers…</p> : null}

        {state.status === "error" ? (
          <div className="pp-inline-notice">
            <p className="pp-muted">Couldn&rsquo;t load papers.</p>
            <button type="button" className="pp-button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : null}

        {state.status === "ready" && state.result.papers.length === 0 ? (
          <p className="pp-empty">No papers listed yet.</p>
        ) : null}

        {state.status === "ready" && state.result.papers.length > 0 ? (
          <ul className="pp-papers" role="list">
            {state.result.papers.map((paper) => (
              <PaperRow key={paper.paperCid || paper.shortId || paper.versionCid} paper={paper} />
            ))}
          </ul>
        ) : null}

        {state.status === "ready" && state.result.truncated ? (
          <p className="pp-muted pp-papers-note">
            Looked through the newest listed papers only; older ones may not appear here.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function PaperRow({ paper }: { readonly paper: FeedItem }) {
  const listed = parseInstant(paper.listedAt);
  return (
    <li className="pp-paper">
      <a className="pp-paper-title" href={paperHref(paper)}>
        {paper.title}
      </a>
      <p className="pp-paper-meta">
        {paper.categories.map((category) => (
          <span className="pp-chip pp-chip--mono" key={category}>
            {category}
          </span>
        ))}
        {paper.status ? <span className="pp-paper-status">{paper.status}</span> : null}
        {listed !== null && paper.listedAt !== null ? (
          <time dateTime={paper.listedAt}>{formatDate(listed)}</time>
        ) : null}
      </p>
    </li>
  );
}

export default MemberPapersCard;
