"use client";

/**
 * The Follow toggle for `/c/{category}`.
 *
 * ```text
 * cs.AI                         [ + Follow ]   Atom feed
 * ```
 *
 * One button with a constant label and `aria-pressed`: `+ Follow` when the
 * reader does not follow the category, `✓ Follow` when they do. The mark is
 * decorative; the pressed state is what assistive tech reads, and the fill and
 * mark carry it for everyone else, so it never rests on colour alone.
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

import {
  describeFollowError,
  followCategory,
  followSigninHref,
  loadFollowedCategories,
  unfollowCategory,
} from "./follows";
import "./follow-toggle.css";

/** Props for {@link FollowToggle}. Only `category` is required. */
export interface FollowToggleProps {
  /** The category id from the route, e.g. `cs.AI`. */
  readonly category: string;
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
}

/** Follow or unfollow one category. */
export function FollowToggle({
  category,
  initialFollowing,
  signedIn,
  loadFollowing = loadFollowedCategories,
  follow = followCategory,
  unfollow = unfollowCategory,
}: FollowToggleProps) {
  const [sessionKnown, setSessionKnown] = useState(false);
  // `null` is "not known": loading, or the read failed.
  const [following, setFollowing] = useState<boolean | null>(initialFollowing ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the reader acts, so a slow read cannot overwrite what they chose.
  const acted = useRef(false);

  useEffect(() => {
    if (signedIn === undefined) {
      setSessionKnown(tokenStore.isAuthenticated);
    }
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
          href={followSigninHref(category)}
          aria-label={`Follow ${category}, sign in required`}
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
        aria-label={`Follow ${category}`}
        aria-pressed={pressed}
        aria-disabled={pending}
        aria-busy={pending}
        onClick={toggle}
      >
        <span aria-hidden="true">{pressed ? "✓" : "+"}</span> Follow
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
