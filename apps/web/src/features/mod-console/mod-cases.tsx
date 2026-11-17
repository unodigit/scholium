"use client";

/**
 * Flags and appeals beneath the queue in `/mod` (docs/design.md §5.7).
 *
 * Both need the signed-in account — flags are moderator-only, and a vote is
 * cast with the account's bearer token — and the token lives in the browser.
 * So, like the queue, this renders a loading line on the server and reads the
 * session after mount: the first paint matches the server's HTML, and nothing
 * is requested for a visitor with no session (the queue above already tells
 * them to sign in).
 *
 * It is a sibling of {@link ModConsole}, not part of it, on purpose. The queue
 * answers `403` below tier 4, and that answer ends the queue's view. Appeals
 * must not end with it: a panel is drawn from tier 3 as well as tier 4, so a
 * reviewer who is not a moderator still has to reach their vote. Who may do
 * what is the API's call in every section.
 */

import { useEffect, useState } from "react";

import { tokenStore } from "../../lib/api";
import {
  AppealsSection,
  type LoadAppeals,
} from "./appeals-section";
import { FlagsSection, type LoadFlag, type LoadFlags } from "./flags-section";
import type { VoteCaster } from "./panel-vote";
import type { LoadFlagTarget } from "./record";
import type { LoadPersonName } from "./person";
import "./mod-console.css";

/** Props for {@link ModCases}. Everything is optional. */
export interface ModCasesProps {
  /**
   * Pin the sign-in state. When omitted it is read from the shared token
   * store on mount.
   */
  signedIn?: boolean;
  loadFlags?: LoadFlags;
  loadFlag?: LoadFlag;
  /** Reads what each flag is about (record type, paper title, excerpt). */
  loadTarget?: LoadFlagTarget;
  loadAppeals?: LoadAppeals;
  castVote?: VoteCaster;
  loadPerson?: LoadPersonName;
}

type Session = "unknown" | "in" | "out";

function pinnedSession(signedIn: boolean | undefined): Session {
  return signedIn === undefined ? "unknown" : signedIn ? "in" : "out";
}

/** The flags and appeals sections, once there is a session to ask with. */
export function ModCases({
  signedIn,
  loadFlags,
  loadFlag,
  loadTarget,
  loadAppeals,
  castVote,
  loadPerson,
}: ModCasesProps = {}) {
  const [session, setSession] = useState<Session>(() => pinnedSession(signedIn));

  useEffect(() => {
    // The token store is only readable in the browser, so the answer is read
    // here (after mount) rather than during render.
    setSession(
      signedIn === undefined
        ? tokenStore.isAuthenticated
          ? "in"
          : "out"
        : pinnedSession(signedIn),
    );
  }, [signedIn]);

  if (session === "out") {
    return null;
  }

  return (
    <div className="mc-cases">
      {session === "unknown" ? (
        <p className="mc-loading" role="status">
          Loading flags and appeals…
        </p>
      ) : (
        <>
          <FlagsSection
            loadFlags={loadFlags}
            loadFlag={loadFlag}
            loadTarget={loadTarget}
            loadPerson={loadPerson}
          />
          <AppealsSection loadAppeals={loadAppeals} castVote={castVote} loadPerson={loadPerson} />
        </>
      )}
    </div>
  );
}

export default ModCases;
