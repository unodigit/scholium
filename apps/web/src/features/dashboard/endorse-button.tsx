"use client";

/**
 * The Endorse actions on a member's public profile (`/u/{did}`) — ID-5.
 *
 * ```text
 * Endorse
 * [ Endorse in cs.AI ] [ Endorse in cs.MA ]      ← the viewer's categories
 * Category [ cs.AI ▾ ] [ Endorse ]               ← tier 3 may pick any
 * ```
 *
 * What is offered comes from the API, never a guess: the viewer's own active
 * endorsements name the categories they hold standing in
 * (`GET /v1/me/endorsements`), and a viewer at or above the API's endorser
 * tier may name any category at all (see `./endorse`). The API stays the gate
 * — a refusal is shown in its own words, never swallowed.
 *
 * Acting signs an `endorsement` record with this device's key (the passkey
 * prompt is the confirmation) and posts it; the ✓ state then replaces the
 * action and {@link EndorseSectionProps.onEndorsed} lets the page read the
 * profile back so the tier shown reflects the grant.
 *
 * Like the follow toggle, the first render matches the server's signed-out
 * HTML (nothing offered) and the store's answer is applied after mount, so
 * there is no hydration mismatch. The section stays hidden for a viewer with
 * nothing to endorse in, and never offers a viewer their own profile.
 */

import { useCallback, useEffect, useId, useState } from "react";

import { tokenStore } from "../../lib/api";
import { CATEGORY_GROUPS } from "../submit/details";

import {
  SIGNED_OUT_VIEWER,
  describeEndorseError,
  endorseActionLabel,
  endorseResearcher,
  endorsedActionLabel,
  endorseOffer,
  loadViewerEndorsements,
  viewerFromAccessToken,
  type EndorseResult,
  type ViewerEndorsement,
  type ViewerIdentity,
} from "./endorse";

import "./endorse-button.css";

/** What one picker category offers: its id and its plain-language name. */
export interface EndorseCategoryOption {
  readonly id: string;
  readonly name: string;
}

/** Props for {@link EndorseSection}. Only `did` is required. */
export interface EndorseSectionProps {
  /** The DID of the profile being viewed — the endorsement's endorsee. */
  readonly did: string;
  /**
   * Pin the viewer. When omitted it is read from the shared token store on
   * mount (and followed as the session changes).
   */
  readonly viewer?: ViewerIdentity;
  /** Replace the read of the viewer's endorsements, for tests. */
  readonly loadEndorsements?: () => Promise<readonly ViewerEndorsement[]>;
  /** Replace the sign-and-post call, for tests. */
  readonly endorse?: (endorseeDid: string, category: string) => Promise<EndorseResult>;
  /** The categories the picker offers; the submit wizard's taxonomy by default. */
  readonly pickerCategories?: readonly { readonly label: string; readonly categories: readonly EndorseCategoryOption[] }[];
  /** Called once an endorsement is accepted, so the page can refresh the tier. */
  readonly onEndorsed?: () => void;
}

function sameViewer(left: ViewerIdentity, right: ViewerIdentity): boolean {
  return left.signedIn === right.signedIn && left.did === right.did && left.tier === right.tier;
}

/** The Endorse actions for one profile, offered to whoever is looking at it. */
export function EndorseSection({
  did,
  viewer: pinnedViewer,
  loadEndorsements = loadViewerEndorsements,
  endorse = endorseAndPost,
  pickerCategories = CATEGORY_GROUPS,
  onEndorsed,
}: EndorseSectionProps) {
  const [storedViewer, setStoredViewer] = useState<ViewerIdentity>(SIGNED_OUT_VIEWER);
  const [endorsements, setEndorsements] = useState<readonly ViewerEndorsement[] | null>(null);
  const [done, setDone] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const pickerId = useId();

  // The viewer from the shared token store, live across sign-in and sign-out.
  useEffect(() => {
    if (pinnedViewer !== undefined) return;
    const update = (): void => {
      const next = viewerFromAccessToken(tokenStore.get()?.accessToken);
      setStoredViewer((current) => (sameViewer(current, next) ? current : next));
    };
    update();
    return tokenStore.subscribe(update);
  }, [pinnedViewer]);

  const viewer = pinnedViewer ?? storedViewer;

  // The viewer's own endorsements name the categories they hold standing in.
  // A failed read hides no offered right that the tier alone grants: the
  // category list just stays empty and the tier-3 picker, if owed, remains.
  useEffect(() => {
    if (!viewer.signedIn) {
      setEndorsements(null);
      return;
    }
    let cancelled = false;
    loadEndorsements().then(
      (rows) => {
        if (!cancelled) setEndorsements(rows);
      },
      () => {
        if (!cancelled) setEndorsements([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [viewer.signedIn, loadEndorsements]);

  const offer = endorseOffer(viewer.tier, endorsements ?? []);

  const isSelf = viewer.did !== null && viewer.did === did;
  const hidden =
    !viewer.signedIn || isSelf || endorsements === null ||
    (offer.categories.length === 0 && !offer.anyCategory);

  const endorseIn = useCallback(
    async (category: string) => {
      if (pending !== null || done.includes(category) || did === "") {
        return;
      }
      setPending(category);
      setError(null);
      try {
        await endorse(did, category);
        setDone((current) =>
          current.includes(category) ? current : [...current, category],
        );
        setNotice(`${endorsedActionLabel(category)}. The tier on this profile is refreshed.`);
        onEndorsed?.();
      } catch (failure: unknown) {
        setError(describeEndorseError(failure));
      } finally {
        setPending(null);
      }
    },
    [did, done, endorse, onEndorsed, pending],
  );

  if (hidden) {
    return null;
  }

  // The category actions: one per offered category, plus any this visit has
  // endorsed (a picked category joins the list in its done state).
  const listed = [...new Set([...offer.categories, ...done])];

  return (
    <section className="endorse-section" aria-labelledby={`${pickerId}-heading`}>
      <h3 className="endorse-heading" id={`${pickerId}-heading`}>
        Endorse
      </h3>

      {listed.length > 0 ? (
        <ul className="endorse-actions">
          {listed.map((category) => {
            const isDone = done.includes(category);
            const busy = pending === category;
            return (
              <li key={category}>
                <button
                  type="button"
                  className="endorse-button"
                  aria-disabled={isDone || busy}
                  aria-busy={busy}
                  onClick={() => {
                    if (!isDone) void endorseIn(category);
                  }}
                >
                  {isDone ? endorsedActionLabel(category) : endorseActionLabel(category)}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {offer.anyCategory ? (
        <form
          className="endorse-picker"
          onSubmit={(event) => {
            // Native validation keeps an unchosen category from submitting.
            event.preventDefault();
            const chosen = new FormData(event.currentTarget).get("category");
            if (typeof chosen === "string" && chosen !== "") {
              void endorseIn(chosen);
            }
          }}
        >
          <label className="endorse-picker-label" htmlFor={`${pickerId}-category`}>
            Category
          </label>
          <select
            className="endorse-select"
            id={`${pickerId}-category`}
            name="category"
            required
            defaultValue=""
          >
            <option value="" disabled>
              Choose a category
            </option>
            {pickerCategories.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {`${category.name} (${category.id})`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            type="submit"
            className="endorse-button"
            aria-disabled={pending !== null}
            aria-busy={pending !== null}
          >
            Endorse
          </button>
        </form>
      ) : null}

      {error !== null ? (
        <p className="endorse-error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Always mounted so a screen reader announces the endorsement. */}
      <p className="endorse-sr" role="status">
        {notice}
      </p>
    </section>
  );
}

/** The default sign-and-post call, in the props' two-argument shape. */
async function endorseAndPost(
  endorseeDid: string,
  category: string,
): Promise<EndorseResult> {
  return endorseResearcher({ endorseeDid, category });
}

export default EndorseSection;
