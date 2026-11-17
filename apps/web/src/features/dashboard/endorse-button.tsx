"use client";

/**
 * The endorsements on a member's public profile (`/u/{did}`) — ID-5.
 *
 * ```text
 * Endorsements                                   ← what the person holds,
 *   cs.AI                                           shown to everyone
 *     Tunde Okafor · 17 Nov 2026
 *
 * Endorse                                        ← what the viewer may do
 * [ ✓ Endorsed in cs.AI ] [ Endorse in cs.MA ]   ← the viewer's categories
 * Category [ Choose a category ▾ ] [ Endorse ]   ← the same categories; tier 4 any
 * ```
 *
 * **What the person holds** is the public list from
 * `GET /v1/profiles/{did}/endorsements` (see `./endorse`): per category, who
 * endorsed (their public name, else their DID, linking to their profile) and
 * the date. It is shown to every reader, signed in or not, and to the person
 * themself.
 *
 * **What the viewer already did** comes from the same list, never from page
 * state: an endorsement the viewer gave is a row whose endorser is them, so it
 * is still there after a reload. Such a category shows `✓ Endorsed in cs.AI`
 * and is not offered again — not as a shortcut and not in the picker. The
 * actions wait for that list before they appear, so a used category is never
 * briefly clickable. If the list cannot be read the actions are offered as the
 * tier grants them and the API's `409` for a duplicate has the last word.
 *
 * What is offered comes from the API's rules, never a guess: only a viewer at
 * the API's endorser tier (or one whose tier the token does not name, whom the
 * API decides for) is offered anything, because the API refuses an
 * endorsement record from every lower tier (`ENDORSER_MIN_TIER` in
 * `apps/api/src/app/modules/endorsements/`). Such a viewer may endorse only in
 * the categories they are themself endorsed in (`GET /v1/me/endorsements`,
 * see `./endorse`), which are offered as quick actions and make up the whole
 * of the category picker; a tier-4 viewer may endorse in any category, so the
 * picker lists the whole taxonomy. A viewer with no category to endorse in
 * sees nothing: the action is hidden rather than offered and refused. The API
 * stays the gate for every record — a refusal is shown in its own words,
 * never swallowed.
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

import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { ApiError, tokenStore } from "../../lib/api";
import { CATEGORY_GROUPS } from "../submit/details";

import {
  SIGNED_OUT_VIEWER,
  categoriesEndorsedBy,
  describeEndorseError,
  endorseActionLabel,
  endorseChoices,
  endorseResearcher,
  endorsedActionLabel,
  endorseOffer,
  endorserLabel,
  formatEndorsementDate,
  groupEndorsementsByCategory,
  loadProfileEndorsements as loadHeldEndorsements,
  loadViewerEndorsements,
  viewerFromAccessToken,
  type EndorseOffer,
  type EndorseResult,
  type ProfileEndorsement,
  type ViewerEndorsement,
  type ViewerIdentity,
} from "./endorse";
import { profilePath } from "./profile";

import "./endorse-button.css";
import "./endorsement-list.css";

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
  /** Replace the read of the endorsements this profile's person holds, for tests. */
  readonly loadProfileEndorsements?: (did: string) => Promise<readonly ProfileEndorsement[]>;
  /** Replace the sign-and-post call, for tests. */
  readonly endorse?: (endorseeDid: string, category: string) => Promise<EndorseResult>;
  /**
   * The taxonomy the picker draws from; the submit wizard's by default. A
   * viewer who may not endorse in every category sees only the part of it
   * they are endorsed in.
   */
  readonly pickerCategories?: readonly { readonly label: string; readonly categories: readonly EndorseCategoryOption[] }[];
  /** Called once an endorsement is accepted, so the page can refresh the tier. */
  readonly onEndorsed?: () => void;
}

function sameViewer(left: ViewerIdentity, right: ViewerIdentity): boolean {
  return left.signedIn === right.signedIn && left.did === right.did && left.tier === right.tier;
}

/**
 * The endorsements one profile holds, and the Endorse actions offered to
 * whoever is looking at it.
 */
export function EndorseSection({
  did,
  viewer: pinnedViewer,
  loadEndorsements = loadViewerEndorsements,
  loadProfileEndorsements = loadHeldEndorsements,
  endorse = endorseAndPost,
  pickerCategories = CATEGORY_GROUPS,
  onEndorsed,
}: EndorseSectionProps) {
  const [storedViewer, setStoredViewer] = useState<ViewerIdentity>(SIGNED_OUT_VIEWER);
  const [endorsements, setEndorsements] = useState<readonly ViewerEndorsement[] | null>(null);
  // What this profile's person holds. `null` until read; a failed read is
  // `[]`, so the actions are not held back by a list that will not come.
  const [held, setHeld] = useState<readonly ProfileEndorsement[] | null>(null);
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

  // The endorsements the person holds are public, so they are read whoever
  // is looking — and they are where "already endorsed" comes from.
  useEffect(() => {
    if (did === "") return;
    let cancelled = false;
    setHeld(null);
    loadProfileEndorsements(did).then(
      (rows) => {
        if (!cancelled) setHeld(rows);
      },
      () => {
        if (!cancelled) setHeld([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [did, loadProfileEndorsements]);

  const offer = endorseOffer(viewer.tier, endorsements ?? []);

  // The categories the viewer has already endorsed this person in, from the
  // API's list — still there after a reload — plus any this visit just did.
  const endorsedBefore = useMemo(
    () => categoriesEndorsedBy(viewer.did, held ?? []),
    [viewer.did, held],
  );
  const used = useMemo(
    () => [...new Set([...endorsedBefore, ...done])].sort(),
    [endorsedBefore, done],
  );

  const isSelf = viewer.did !== null && viewer.did === did;
  const mayEndorse =
    viewer.signedIn && !isSelf && endorsements !== null && held !== null &&
    (offer.categories.length > 0 || offer.anyCategory);

  const endorseIn = useCallback(
    async (category: string) => {
      if (pending !== null || used.includes(category) || did === "") {
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
        // Read the list back so the new endorsement shows with its endorser
        // and date; a failed read keeps the list on screen.
        loadProfileEndorsements(did).then(setHeld, () => {});
      } catch (failure: unknown) {
        if (failure instanceof ApiError && failure.status === 409) {
          // The API says this endorsement already stands — reflect that.
          setDone((current) =>
            current.includes(category) ? current : [...current, category],
          );
        }
        setError(describeEndorseError(failure));
      } finally {
        setPending(null);
      }
    },
    [did, endorse, loadProfileEndorsements, onEndorsed, pending, used],
  );

  const groups = groupEndorsementsByCategory(held ?? []);

  if (!mayEndorse && groups.length === 0) {
    return null;
  }

  return (
    <>
      {groups.length > 0 ? <EndorsementList groups={groups} /> : null}
      {mayEndorse ? (
        <EndorseActions
          pickerId={pickerId}
          offer={offer}
          used={used}
          pending={pending}
          error={error}
          notice={notice}
          pickerCategories={pickerCategories}
          onEndorse={(category) => void endorseIn(category)}
        />
      ) : null}
    </>
  );
}

/** The public list: per category, who endorsed and when. */
function EndorsementList({
  groups,
}: {
  readonly groups: ReturnType<typeof groupEndorsementsByCategory>;
}) {
  return (
    <section className="endorse-section">
      <h3 className="endorse-heading">Endorsements</h3>
      {/* role="list": Safari drops list semantics once the markers are gone. */}
      <ul className="endorsement-groups" role="list">
        {groups.map((group) => (
          <li className="endorsement-group" key={group.category}>
            <h4 className="endorsement-category">{group.category}</h4>
            <ul className="endorsement-rows" role="list">
              {group.endorsements.map((row) => {
                const date = formatEndorsementDate(row.endorsedAt);
                return (
                  <li
                    className="endorsement-row"
                    key={row.recordCid || `${row.endorserDid}/${row.category}`}
                  >
                    <a className="endorsement-endorser" href={profilePath(row.endorserDid)}>
                      {endorserLabel(row)}
                    </a>
                    {date !== null && row.endorsedAt !== null ? (
                      <time className="endorsement-date" dateTime={row.endorsedAt}>
                        {date}
                      </time>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The actions: one per category the viewer may endorse in, and the picker. */
function EndorseActions({
  pickerId,
  offer,
  used,
  pending,
  error,
  notice,
  pickerCategories,
  onEndorse,
}: {
  readonly pickerId: string;
  readonly offer: EndorseOffer;
  /** Categories already endorsed: before this visit, or during it. */
  readonly used: readonly string[];
  readonly pending: string | null;
  readonly error: string | null;
  readonly notice: string;
  readonly pickerCategories: NonNullable<EndorseSectionProps["pickerCategories"]>;
  readonly onEndorse: (category: string) => void;
}) {
  // The category actions: one per offered category, plus any already
  // endorsed (a picked category joins the list in its done state).
  const listed = [...new Set([...offer.categories, ...used])].sort();

  // The picker offers only what the viewer may endorse in and has not yet
  // endorsed: their own categories, or the whole taxonomy for a tier-4 viewer.
  // A group left with nothing is dropped rather than shown empty.
  const choices = endorseChoices(offer, pickerCategories, used);

  return (
    <section className="endorse-section" aria-labelledby={`${pickerId}-heading`}>
      <h3 className="endorse-heading" id={`${pickerId}-heading`}>
        Endorse
      </h3>

      {listed.length > 0 ? (
        <ul className="endorse-actions">
          {listed.map((category) => {
            const isDone = used.includes(category);
            const busy = pending === category;
            return (
              <li key={category}>
                <button
                  type="button"
                  className="endorse-button"
                  aria-disabled={isDone || busy}
                  aria-busy={busy}
                  onClick={() => {
                    if (!isDone) onEndorse(category);
                  }}
                >
                  {isDone ? endorsedActionLabel(category) : endorseActionLabel(category)}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {choices.length > 0 ? (
        <form
          className="endorse-picker"
          onSubmit={(event) => {
            // Native validation keeps an unchosen category from submitting.
            event.preventDefault();
            const chosen = new FormData(event.currentTarget).get("category");
            if (typeof chosen === "string" && chosen !== "") {
              onEndorse(chosen);
            }
          }}
        >
          <label className="endorse-picker-label" htmlFor={`${pickerId}-category`}>
            Category
          </label>
          {/* Keyed on what is used: when an option is removed under it, a
              select quietly moves to the next enabled one, and a stray Enter
              would endorse in a category nobody chose. A fresh select starts
              again at the placeholder. */}
          <select
            key={used.join(",")}
            className="endorse-select"
            id={`${pickerId}-category`}
            name="category"
            required
            defaultValue=""
          >
            <option value="" disabled>
              Choose a category
            </option>
            {choices.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name === category.id
                      ? category.id
                      : `${category.name} (${category.id})`}
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
