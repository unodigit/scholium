"use client";

/**
 * The Follow toggle for `/c/{category}`.
 *
 * ```text
 * cs.AI                         [ + Follow ]   Atom feed
 * ```
 *
 * One button with a constant accessible name and `aria-pressed`: `+ Follow`
 * when the reader does not follow the category, `✓ Following` when they do.
 * The mark is decorative and the visible word says what is true; the pressed
 * state is what assistive tech reads, and the word, fill and mark carry it for
 * everyone else, so it never rests on colour alone.
 *
 * It renders a sign-in link first and upgrades to the button on mount when the
 * token store holds a session. That keeps the server HTML and the first client
 * render identical, and leaves a working control when JavaScript is off (the
 * session lives in the browser, so there is nothing else a no-JS reader could
 * follow with).
 *
 * Whether the reader already follows the category comes from
 * `GET /v1/me/follows` (see `./follows`). While that is unknown, or if it
 * cannot be read, the button offers "Follow": following twice is the same
 * fact, so the worst case is a redundant `PUT`.
 */

import { useEffect, useRef, useState } from "react";

import { tokenStore } from "../../lib/api";

import { Card } from "./card";
import {
  describeFollow,
  describeFollowError,
  followCategory,
  followKind,
  followSigninHref,
  loadFollowedCategories,
  loadFollowedSubjects,
  unfollowCategory,
  type FollowedSubject,
} from "./follows";
import "./follow-toggle.css";

/** Props for {@link FollowToggle}. Only `category` is required. */
export interface FollowToggleProps {
  /**
   * The subject id: a category (`cs.AI`), a paper (`sch:…`) or a member
   * (`did:…`). The id names which page the control's sign-in link returns to.
   * (The name `category` is kept for the callers that predate papers and
   * people; the follows table stores all three the same way.)
   */
  readonly category: string;
  /**
   * What the subject is called on screen, for the accessible name. Defaults
   * to the category id, "this paper" or "this member" by the id's shape.
   */
  readonly label?: string;
  /** The reader's follow state when the caller already knows it. */
  readonly initialFollowing?: boolean;
  /**
   * Pin the sign-in state. When omitted it is read from the shared token
   * store on mount.
   */
  readonly signedIn?: boolean;
  /** Replace the read of the followed categories, for tests. */
  readonly loadFollowing?: () => Promise<readonly string[]>;
  /** Replace the follow call, for tests. */
  readonly follow?: (category: string) => Promise<void>;
  /** Replace the unfollow call, for tests. */
  readonly unfollow?: (category: string) => Promise<void>;
  /**
   * Where a signed-out reader goes. Defaults to the category page itself, so
   * sign-in returns them to the control they clicked.
   */
  readonly signinHref?: string;
}

/** Follow or unfollow one category. */
export function FollowToggle({
  category,
  label,
  initialFollowing,
  signedIn,
  loadFollowing = loadFollowedCategories,
  follow = followCategory,
  unfollow = unfollowCategory,
  signinHref,
}: FollowToggleProps) {
  const subject = category.trim();
  const subjectLabel =
    label?.trim() ||
    (followKind(subject) === "paper"
      ? "this paper"
      : followKind(subject) === "person"
        ? "this member"
        : subject);
  const [sessionKnown, setSessionKnown] = useState(false);
  // `null` is "not known": loading, or the read failed.
  const [following, setFollowing] = useState<boolean | null>(initialFollowing ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the reader acts, so a slow read cannot overwrite what they chose.
  const acted = useRef(false);

  // The access token lives in memory only, so a page load starts signed out
  // until the session provider's refresh answers. Subscribe rather than read
  // once, so a reload upgrades to the button when the session arrives.
  useEffect(() => {
    if (signedIn !== undefined) {
      return;
    }
    const read = (): void => setSessionKnown(tokenStore.isAuthenticated);
    read();
    return tokenStore.subscribe(read);
  }, [signedIn]);
  const isSignedIn = signedIn ?? sessionKnown;

  useEffect(() => {
    if (!isSignedIn || initialFollowing !== undefined) {
      return;
    }
    let cancelled = false;
    loadFollowing().then(
      (categories) => {
        if (!cancelled && !acted.current) {
          setFollowing(categories.includes(category.trim()));
        }
      },
      () => {
        // Stay "unknown": the button still works, see the module comment.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [category, initialFollowing, isSignedIn, loadFollowing]);

  if (!isSignedIn) {
    return (
      <div className="db-follow">
        <a
          className="db-follow-button"
          href={signinHref ?? followSigninHref(category)}
          aria-label={`Follow ${subjectLabel}, sign in required`}
        >
          <span aria-hidden="true">+</span> Follow
        </a>
      </div>
    );
  }

  const pressed = following === true;

  const toggle = async () => {
    if (pending) {
      return;
    }
    const next = !pressed;
    acted.current = true;
    setPending(true);
    setError(null);
    try {
      await (next ? follow : unfollow)(category);
      setFollowing(next);
    } catch (failure) {
      setError(describeFollowError(failure, next));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="db-follow">
      {/* aria-disabled, not disabled: a disabled button drops keyboard focus. */}
      <button
        type="button"
        className="db-follow-button"
        aria-label={`Follow ${subjectLabel}`}
        aria-pressed={pressed}
        aria-disabled={pending}
        aria-busy={pending}
        onClick={toggle}
      >
        <span aria-hidden="true">{pressed ? "✓" : "+"}</span>{" "}
        {pressed ? "Following" : "Follow"}
      </button>
      {error !== null ? (
        <p className="db-follow-error meta" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default FollowToggle;

/** Props for {@link FollowedCategoriesCard}. Everything is optional. */
export interface FollowedCategoriesCardProps {
  /** Pin the sign-in state. When omitted it is read from the token store. */
  readonly signedIn?: boolean;
  /**
   * Replace the read of the follows, for tests. A bare id is accepted too:
   * the card links it by its shape (category, paper or person).
   */
  readonly loadFollows?: () => Promise<
    readonly FollowedSubject[] | readonly string[]
  >;
}

type FollowsState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly subjects: readonly FollowedSubject[] };

/**
 * The "Follows" card on `/me`.
 *
 * The category page's FollowToggle writes `PUT /v1/me/follows/{category}`;
 * this card reads the same set back from `GET /v1/me/follows`, so a follow a
 * reader makes from `/c/{category}` is visible on their dashboard (and stays
 * visible after a reload or on another device). Signed-out readers are left to
 * the dashboard's own sign-in notice, so the card renders nothing.
 */
export function FollowedCategoriesCard({
  signedIn,
  loadFollows = loadFollowedSubjects,
}: FollowedCategoriesCardProps = {}) {
  const [sessionKnown, setSessionKnown] = useState(false);
  const [state, setState] = useState<FollowsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // The token store is restored from the cookie after mount, so subscribe to
  // it rather than reading once; a reload then fills the card when it lands.
  useEffect(() => {
    if (signedIn !== undefined) {
      return;
    }
    const read = (): void => setSessionKnown(tokenStore.isAuthenticated);
    read();
    return tokenStore.subscribe(read);
  }, [signedIn]);

  const isSignedIn = signedIn ?? sessionKnown;

  useEffect(() => {
    if (!isSignedIn) {
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadFollows().then(
      (entries) => {
        if (!cancelled) {
          setState({
            status: "ready",
            subjects: entries.map((entry) =>
              typeof entry === "string" ? describeFollow(entry) : entry,
            ),
          });
        }
      },
      (failure: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              failure instanceof Error && failure.message.trim() !== ""
                ? failure.message
                : "The API could not return the categories you follow.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, isSignedIn, loadFollows]);

  if (!isSignedIn) {
    return null;
  }

  return (
    <div className="db-follows">
      <Card title="Follows" anchor="follows">
        {state.status === "error" ? (
          <>
            <p className="db-item-detail meta" role="alert">
              {state.message}
            </p>
            <button
              type="button"
              className="db-button"
              onClick={() => setAttempt((count) => count + 1)}
            >
              Try again
            </button>
          </>
        ) : state.status === "loading" ? (
          <p className="db-loading" role="status">
            Loading your follows…
          </p>
        ) : state.subjects.length === 0 ? (
          <p className="db-item-detail meta">
            You don’t follow any categories yet. Open a category page and choose
            Follow.
          </p>
        ) : (
          <ul className="db-list">
            {state.subjects.map((subject) => (
              <li className="db-item" key={subject.id} data-kind={subject.kind}>
                <a className="db-link" href={subject.href}>
                  {subject.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
