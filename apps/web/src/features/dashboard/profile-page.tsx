"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { tokenStore } from "../../lib/api";
import { formatDate, parseInstant } from "../feed/feed";
import { confidenceLabel, recommendationLabel } from "../paper-reviews/review";
import { initials } from "../ui-kit/initials";

import { CopyDid } from "./copy-did";
import { EndorseSection } from "./endorse-button";
import { MemberPapersCard, type LoadMemberPapers } from "./member-papers";
import {
  PROFILE_TITLE,
  describeProfileError,
  loadProfile as fetchProfile,
  orcidUrl,
  profileDisplayName,
  profileShortDid,
  signedReviewPaperHref,
  tierLabel,
  type ProfileData,
  type SignedReview,
} from "./profile";
import { viewerFromAccessToken, type EndorseResult } from "./endorse";
import "./profile-page.css";

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
  /** Replace the follow call behind the Follow toggle, for tests. */
  follow?: (subject: string) => Promise<void>;
  /** Replace the unfollow call behind the Follow toggle, for tests. */
  unfollow?: (subject: string) => Promise<void>;
  /** Replace the read of what the viewer already follows, for tests. */
  loadFollowing?: () => Promise<readonly string[]>;
  /** Pin the sign-in state. */
  signedIn?: boolean;
  /** Replace the read of the member's papers, for tests. */
  loadPapers?: LoadMemberPapers;
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
      {state.status !== "ready" ? <PlainHeader did={resolvedDid} /> : null}

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
        <ProfileView
          profile={state.profile}
          endorse={props.endorse}
          follow={props.follow}
          unfollow={props.unfollow}
          loadFollowing={props.loadFollowing}
          loadPapers={props.loadPapers}
          signedIn={props.signedIn}
          onEndorsed={refresh}
        />
      ) : null}
    </div>
  );
}

/** Aliases for callers that name the component after the subject. */
export const UserProfilePage = ProfilePage;
export const PublicProfilePage = ProfilePage;

/**
 * What the page shows before there is a profile to show (still loading, or
 * the read failed): the member's short DID, which is all that is known.
 */
function PlainHeader({ did }: { did: string }) {
  return (
    <header className="pp-hero">
      <h1 className={did === "" ? "pp-name" : "pp-name pp-name--pseudonym"}>
        {did === "" ? PROFILE_TITLE : profileShortDid(did)}
      </h1>
    </header>
  );
}

/**
 * The DID of the person looking at the page, from the token store and live
 * across sign-in and sign-out; `null` when signed out or when the token does
 * not name one. The first render matches the server's signed-out HTML.
 */
function useViewerDid(): string | null {
  const [did, setDid] = useState<string | null>(null);
  useEffect(() => {
    const read = (): void => setDid(viewerFromAccessToken(tokenStore.get()?.accessToken).did);
    read();
    return tokenStore.subscribe(read);
  }, []);
  return did;
}

/** Letters for the profile's avatar; a title is skipped, and `#` stands in for a pseudonym. */
function monogramOf(profile: ProfileData): string {
  return initials(profile.name ?? "") ?? "#";
}

function ProfileView({
  profile,
  endorse,
  follow,
  unfollow,
  loadFollowing,
  loadPapers,
  signedIn,
  onEndorsed,
}: {
  profile: ProfileData;
  /** Passed through to the Endorse actions, for tests. */
  endorse?: (endorseeDid: string, category: string) => Promise<EndorseResult>;
  /** Passed through to the Follow toggle, for tests. */
  follow?: (subject: string) => Promise<void>;
  unfollow?: (subject: string) => Promise<void>;
  loadFollowing?: () => Promise<readonly string[]>;
  /** Passed through to the Papers card, for tests. */
  loadPapers?: LoadMemberPapers;
  /** Pin the Follow toggle's sign-in state. */
  signedIn?: boolean;
  /** Called after an accepted endorsement, so the tier shown is refreshed. */
  onEndorsed?: () => void;
}) {
  const viewerDid = useViewerDid();
  // Following or endorsing oneself means nothing, so neither is offered.
  const isOwnProfile = viewerDid !== null && viewerDid === profile.did;

  return (
    <>
      <header className="pp-hero">
        <div className="pp-hero-main">
          <span className="pp-monogram" aria-hidden="true">
            {monogramOf(profile)}
          </span>
          <div className="pp-hero-text">
            <h1 className={profile.name === null ? "pp-name pp-name--pseudonym" : "pp-name"}>
              {profileDisplayName(profile)}
            </h1>
            {profile.affiliation ? <p className="pp-affiliation">{profile.affiliation}</p> : null}

            <ul className="pp-chips" role="list">
              {profile.orcid ? (
                <li>
                  <a className="pp-chip pp-chip--orcid" href={orcidUrl(profile.orcid)}>
                    <span aria-hidden="true">✓</span> ORCID{" "}
                    <span className="mono-id">{profile.orcid}</span>
                  </a>
                </li>
              ) : null}
              <li>
                <span className="pp-chip">{tierLabel(profile.tier)}</span>
              </li>
            </ul>

            <p className="pp-did">
              <span className="pp-did-label">DID</span>
              <code className="pp-did-value mono-id" title={profile.did}>
                {profileShortDid(profile.did)}
              </code>
              <CopyDid did={profile.did} />
            </p>

            {profile.erased ? (
              <p className="pp-note">This profile has been erased.</p>
            ) : null}
          </div>
        </div>
      </header>

      <div className="pp-grid">
        {/* ID-5: the endorsements this person holds, and — for a viewer who
            may — the actions to endorse them (see ./endorse-button). Both are
            hidden when there is nothing to show; the actions never appear on
            the viewer's own profile. */}
        <EndorseSection did={profile.did} endorse={endorse} onEndorsed={onEndorsed} />

        <MemberPapersCard did={profile.did} loadPapers={loadPapers} />

        <section className="pp-card" aria-labelledby="pp-reviews-heading">
          <h2 className="pp-card-heading" id="pp-reviews-heading">
            Signed reviews
          </h2>
          {profile.reviews.length > 0 ? (
            <ul className="pp-reviews" role="list">
              {profile.reviews.map((review) => (
                <ReviewRow review={review} key={review.review_cid} />
              ))}
            </ul>
          ) : (
            <p className="pp-empty">No signed reviews yet.</p>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * One signed review, in the same words as the paper's review card: the paper
 * and version it was written on, then the recommendation ("Major concerns")
 * and the confidence ("Confidence: Medium"). The review cid stays as the
 * record's identifier beneath them, not as the only thing naming the review.
 */
function ReviewRow({ review }: { review: SignedReview }) {
  const revealed = parseInstant(review.revealed_at);
  const paperHref = signedReviewPaperHref(review);
  const paperLabel = review.paper_title ?? review.paper_id;
  const confidence = confidenceLabel(review.confidence);
  return (
    <li className="pp-review">
      {paperLabel !== null ? (
        paperHref !== null ? (
          <a className="pp-paper-title" href={paperHref}>
            {paperLabel}
          </a>
        ) : (
          <p className="pp-review-paper">{paperLabel}</p>
        )
      ) : null}
      {review.recommendation !== null ? (
        <p className="pp-review-rec">{recommendationLabel(review.recommendation)}</p>
      ) : null}
      <p className="pp-review-meta">
        {review.version !== null ? <span>v{review.version}</span> : null}
        {confidence !== null ? <span>Confidence: {confidence}</span> : null}
        {revealed !== null && review.revealed_at !== null ? (
          <time dateTime={review.revealed_at}>{formatDate(revealed)}</time>
        ) : null}
      </p>
      <p className="pp-review-id mono-id" title={review.review_cid}>
        {review.review_cid}
      </p>
    </li>
  );
}
