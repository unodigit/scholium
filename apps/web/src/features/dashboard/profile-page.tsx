"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { tokenStore } from "../../lib/api";

import { EndorseSection } from "./endorse-button";
import {
  PROFILE_TITLE,
  describeProfileError,
  loadProfile as fetchProfile,
  type ProfileData,
} from "./profile";
import type { EndorseResult } from "./endorse";
import "./dashboard-page.css";

/** Loads a profile for one DID; replaceable in tests. */
export type LoadProfile = (did: string) => Promise<ProfileData>;

/** Props for {@link ProfilePage}. Everything is optional. */
export interface ProfilePageProps {
  /** The DID whose profile this page shows. */
  did?: string;
  /** Profile already in hand (tests, or a server route that fetched it). */
  initialProfile?: ProfileData;
  initialData?: ProfileData;
  profile?: ProfileData;
  data?: ProfileData;
  /** Failure message from a server-side fetch; the client retries on mount. */
  initialError?: string;
  error?: string;
  /** Replace the loader, for tests or an alternate API client. */
  loadProfile?: LoadProfile;
  loader?: LoadProfile;
  /** Replace the sign-and-post call behind the Endorse action, for tests. */
  endorse?: (endorseeDid: string, category: string) => Promise<EndorseResult>;
  /** Pin the sign-in state. */
  signedIn?: boolean;
}

type ProfileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; profile: ProfileData };

function initialProfileOf(props: ProfilePageProps): ProfileData | undefined {
  return props.initialProfile ?? props.initialData ?? props.profile ?? props.data;
}

function initialErrorOf(props: ProfilePageProps): string | undefined {
  return props.initialError ?? props.error;
}

function didOf(props: ProfilePageProps, profile?: ProfileData): string {
  return props.did ?? profile?.did ?? "";
}

/** `/u/{did}`: a member's public profile. */
export function ProfilePage(props: ProfilePageProps = {}) {
  const initial = initialProfileOf(props);
  const [state, setState] = useState<ProfileState>(() =>
    initial ? { status: "ready", profile: initial } : initialErrorOf(props)
      ? { status: "error", message: initialErrorOf(props)! }
      : { status: "loading" },
  );
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  const did = didOf(props, initial);

  // The latest loaded profile, for reads that must not race a stale closure.
  const profileRef = useRef<ProfileData | null>(initial ?? null);
  if (state.status === "ready") {
    profileRef.current = state.profile;
  }

  /**
   * Read the profile back without the loading state: an accepted endorsement
   * grants a tier, and the facts above should show it. A failed read keeps
   * what is on screen — the endorsement stands on its signed record.
   */
  const refresh = useCallback(() => {
    const targetDid = didOf(props, profileRef.current ?? undefined) || "";
    if (targetDid === "") {
      return;
    }
    const load = props.loadProfile ?? props.loader ?? ((d: string) => fetchProfile(d));
    load(targetDid).then(
      (data) => setState({ status: "ready", profile: data }),
      () => {
        // Keep the current profile; the reader can still reload the page.
      },
    );
  }, [props]);

  useEffect(() => {
    const profile = initialProfileOf(props);
    if (profile && attempt === 0) {
      return;
    }
    const targetDid = didOf(props, profile);
    if (targetDid === "") {
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    const load = props.loadProfile ?? props.loader ?? ((d: string) => fetchProfile(d));
    load(targetDid).then(
      (data) => {
        if (!cancelled) setState({ status: "ready", profile: data });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", message: describeProfileError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, props, did]);

  const resolvedDid = did || (state.status === "ready" ? state.profile.did : "");

  return (
    <div className="pp-page">
      <ProfileHeader did={resolvedDid} />

      {state.status === "loading" ? (
        <p className="pp-loading" role="status">
          Loading profile…
        </p>
      ) : null}

      {state.status === "error" ? (
        <div className="pp-notice" role="alert">
          <h2 className="pp-notice-title">Couldn&rsquo;t load this profile</h2>
          <p className="pp-notice-text">{state.message}</p>
          <button type="button" className="pp-button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === "ready" ? (
        <ProfileView profile={state.profile} endorse={props.endorse} onEndorsed={refresh} />
      ) : null}
    </div>
  );
}

/** Aliases for callers that name the component after the subject. */
export const UserProfilePage = ProfilePage;
export const PublicProfilePage = ProfilePage;

function ProfileHeader({ did }: { did: string }) {
  return (
    <header className="pp-header">
      <p className="pp-kicker mono-id">scholium / u / {did}</p>
      <h1 className="pp-title">{PROFILE_TITLE}</h1>
      <p className="pp-lede">
        A member&rsquo;s public profile: name, affiliation, ORCID, trust tier
        and the reviews they chose to sign with their name.
      </p>
    </header>
  );
}

function ProfileView({
  profile,
  endorse,
  onEndorsed,
}: {
  profile: ProfileData;
  /** Passed through to the Endorse actions, for tests. */
  endorse?: (endorseeDid: string, category: string) => Promise<EndorseResult>;
  /** Called after an accepted endorsement, so the tier shown is refreshed. */
  onEndorsed?: () => void;
}) {
  return (
    <div className="pp-grid">
      <section className="pp-card" aria-labelledby="pp-identity-heading">
        <h2 className="pp-card-heading" id="pp-identity-heading">
          Identity
        </h2>
        <dl className="pp-facts">
          <div className="pp-fact">
            <dt className="meta">DID</dt>
            <dd className="pp-did mono-id">{profile.did}</dd>
          </div>
          <div className="pp-fact">
            <dt className="meta">Name</dt>
            <dd>{profile.name ?? "—"}</dd>
          </div>
          <div className="pp-fact">
            <dt className="meta">Affiliation</dt>
            <dd>{profile.affiliation ?? "—"}</dd>
          </div>
          <div className="pp-fact">
            <dt className="meta">ORCID</dt>
            <dd>{profile.orcid ?? "—"}</dd>
          </div>
          <div className="pp-fact">
            <dt className="meta">Tier</dt>
            <dd>{profile.tier}</dd>
          </div>
          {profile.erased ? (
            <div className="pp-fact">
              <dt className="meta">Status</dt>
              <dd>This profile has been erased.</dd>
            </div>
          ) : null}
        </dl>

        {/* ID-5: endorse this researcher, offered from the viewer's own
            standing (see ./endorse-button). Hidden for everyone else. */}
        <EndorseSection did={profile.did} endorse={endorse} onEndorsed={onEndorsed} />
      </section>

      <section className="pp-card" aria-labelledby="pp-reviews-heading">
        <h2 className="pp-card-heading" id="pp-reviews-heading">
          Signed reviews
        </h2>
        {profile.reviews.length > 0 ? (
          <ul className="pp-reviews">
            {profile.reviews.map((review) => (
              <li className="pp-review" key={review.review_cid}>
                <p className="pp-review-id mono-id">{review.review_cid}</p>
                {review.version_cid ? (
                  <p className="pp-review-version mono-id">{review.version_cid}</p>
                ) : null}
                {review.recommendation ? (
                  <p className="pp-review-rec">{review.recommendation}</p>
                ) : null}
                {review.confidence !== null ? (
                  <p className="pp-review-confidence">Confidence: {review.confidence}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="pp-empty">No signed reviews yet.</p>
        )}
      </section>
    </div>
  );
}
