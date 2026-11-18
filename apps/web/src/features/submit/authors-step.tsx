"use client";

/**
 * Step 3 of the submit wizard: Authors (docs/design.md §5.4).
 *
 * "Add co-authors by ORCID or email; assign CRediT roles; order — each
 * co-author gets a consent link; status chips: Waiting / Signed / Declined."
 *
 * - **Add** takes one box: a DID, an ORCID iD or an email, told apart by its
 *   shape, plus an optional name for the byline.
 * - **Roles.** Each author has the fourteen CRediT roles as toggles, at least
 *   one required (a co-author accepts a named role when they consent).
 * - **Order** is the byline. Move up and Move down are buttons, so reordering
 *   never depends on dragging; focus stays on the button that was pressed.
 * - **Consent tracker.** Everyone is *Waiting* until a version exists. Give the
 *   step the version (`consentsFor`) and it shows the node's real status:
 *   Waiting, Signed or Declined.
 * - **Continue** names the first thing missing, and stays closed when there is
 *   no step 4 to go to.
 *
 * The roster is controlled: `SubmitWizard` owns it, so moving between steps
 * keeps it.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";

import { initials } from "../ui-kit/initials";

import {
  CREDIT_ROLES,
  KIND_LABELS,
  addAuthor,
  applyLookup,
  authorLabel,
  authorsBlockers,
  canContinueAuthors,
  moveAuthor,
  parseIdentifier,
  removeAuthor,
  shortDid,
  toggleCreditRole,
  type AuthorLookup,
  type DraftAuthor,
  type ResolveAuthor,
} from "./authors";
import { ConsentTracker } from "./consent-tracker";
import { trackerFromDraft, trackerFromReport, type FetchConsents, type VersionRef } from "./consents";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, InfoIcon, PersonIcon, PlusIcon } from "./icons";
import { fetchProfileName as defaultFetchProfileName, withProfileNames, type FetchProfileName } from "./profile-names";
import { useConsents } from "./use-consents";
import { useProfileNames } from "./use-profile-names";
import "./submit.css";

export interface AuthorsStepProps {
  authors: readonly DraftAuthor[];
  onChange: (authors: DraftAuthor[]) => void;
  /** Go back to step 2, Details. */
  onBack?: () => void;
  /**
   * Go on to step 4. Without it Continue stays closed: there is no step 4 to
   * go to in this release.
   */
  onContinue?: (authors: readonly DraftAuthor[]) => void;
  /** The name of the step Continue leads to, for the button and its hint. */
  nextStepLabel?: string;
  /**
   * Finds the account behind an ORCID iD or an email. The API has none in this
   * release; without one, those co-authors stay "Not matched" until removed and
   * re-added by DID.
   */
  resolveAuthor?: ResolveAuthor;
  /**
   * The version whose consents to show. Without it no version exists yet, so
   * nobody has been asked and everyone is shown as waiting.
   */
  consentsFor?: VersionRef | null;
  /** Replaces the consent request (tests, and callers with their own client). */
  fetchConsents?: FetchConsents;
  /** How often to ask the node again while someone is waiting. */
  pollMs?: number;
  /** Replaces the public profile lookup that names co-authors, for tests. */
  fetchProfileName?: FetchProfileName;
}

const KIND_PHRASES = { did: "a DID", orcid: "an ORCID iD", email: "an email address" } as const;

const NOT_YET_ASKED =
  "Each co-author gets a consent link when you sign and submit. Until then everyone shows as waiting.";

function whatMatchMeans(author: DraftAuthor, canLookUp: boolean): string {
  if (author.isSubmitter) {
    return "No DID is known for you yet. Sign in on this device so it can be listed.";
  }
  const what = author.kind === "email" ? "email address" : "ORCID iD";
  return canLookUp
    ? `No Scholium account is linked to this ${what}. A co-author needs a DID to be listed: check again, or remove them and add them by DID.`
    : `This ${what} cannot be matched to an account yet. A co-author needs a DID to be listed: remove them and add them by DID.`;
}

export function AuthorsStep({
  authors,
  onChange,
  onBack,
  onContinue,
  nextStepLabel = "Checks",
  resolveAuthor,
  consentsFor,
  fetchConsents,
  pollMs,
  fetchProfileName,
}: AuthorsStepProps): ReactElement {
  const [identifier, setIdentifier] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Lookups in flight. Not part of the draft: leave the step and they are just "not matched".
  const [looking, setLooking] = useState<ReadonlySet<string>>(new Set());

  const identifierRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<string | null>(null);

  // The latest roster, kept current by `commit` as well as by every render, so
  // two lookups that finish in the same tick cannot overwrite each other.
  const latest = useRef(authors);
  latest.current = authors;
  const commit = (next: DraftAuthor[]): void => {
    latest.current = next;
    onChange(next);
  };

  useEffect(() => {
    // Entering the step from Details should start at the first thing to do.
    identifierRef.current?.focus();
  }, []);

  // After a move the button that was pressed has been re-inserted; put focus back on it.
  useEffect(() => {
    const id = pendingFocus.current;
    if (id !== null) {
      pendingFocus.current = null;
      const target = document.getElementById(id) as HTMLButtonElement | null;
      (target && !target.disabled ? target : null)?.focus();
    }
  });

  const consents = useConsents(consentsFor, { fetcher: fetchConsents, intervalMs: pollMs });
  // Authors added by DID carry no name in the draft; their public profile names
  // them for display. The roster itself keeps exactly what the author entered,
  // because that is what the signed version lists.
  const unnamedDids = useMemo(
    () =>
      authors
        .filter((author) => author.name.trim() === "" && author.did !== null)
        .map((author) => author.did as string),
    [authors],
  );
  const profileNames = useProfileNames(unnamedDids, { fetcher: fetchProfileName });
  const namedAuthors = useMemo(
    () => withProfileNames(authors, profileNames),
    [authors, profileNames],
  );
  const entries = useMemo(
    () => (consents.report !== null ? trackerFromReport(consents.report, namedAuthors) : trackerFromDraft(namedAuthors)),
    [consents.report, namedAuthors],
  );
  const caption =
    consentsFor == null ? NOT_YET_ASKED : consents.phase === "loading" ? "Checking who has signed…" : undefined;

  const detected = identifier.trim() === "" ? null : parseIdentifier(identifier);
  const detectedHint = detected?.ok ? `Looks like ${KIND_PHRASES[detected.kind]}.` : null;

  const lookUp = async (key: string): Promise<void> => {
    const author = latest.current.find((candidate) => candidate.key === key);
    if (resolveAuthor === undefined || author === undefined || author.kind === "did" || author.identifier === null) {
      return;
    }
    setLooking((current) => new Set(current).add(key));
    let found: AuthorLookup | null = null;
    try {
      found = await resolveAuthor({ kind: author.kind, value: author.identifier });
    } catch {
      found = null; // A failed lookup is the same as no match: they can check again.
    }
    setLooking((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (!latest.current.some((candidate) => candidate.key === key)) {
      return; // Removed while we were looking: nothing to update or announce.
    }

    const result = applyLookup(latest.current, key, found);
    commit(result.authors);
    if (!result.ok) {
      setAnnouncement(result.message);
    } else {
      const after = result.authors.find((candidate) => candidate.key === key);
      setAnnouncement(
        after?.match === "matched"
          ? `Matched ${authorLabel(after)} to an account.`
          : `No account found for ${authorLabel(author)}.`,
      );
    }
  };

  const handleAdd = (event: FormEvent): void => {
    event.preventDefault();
    const result = addAuthor(latest.current, identifier, name);
    if (!result.ok) {
      setError(result.message);
      identifierRef.current?.focus();
      return;
    }
    setError(null);
    commit(result.authors);
    setIdentifier("");
    setName("");
    identifierRef.current?.focus();
    const added = result.added;
    const nameFetcher = fetchProfileName ?? defaultFetchProfileName;
    setAnnouncement(`Added ${authorLabel(added)}. Choose their CRediT roles below.`);
    // A co-author added by DID carries no name in the draft; ask their public
    // profile so the confirmation says who they are, with the DID as secondary.
    if (added.kind === "did" && added.name.trim() === "" && added.identifier !== null) {
      const did = added.identifier;
      void nameFetcher(did).then((profileName) => {
        if (profileName !== null && profileName.trim() !== "") {
          setAnnouncement(`Added ${profileName.trim()}. Choose their CRediT roles below.`);
        }
      });
    }
    if (resolveAuthor !== undefined && result.added.kind !== "did") {
      void lookUp(result.added.key);
    }
  };

  const handleRemove = (author: DraftAuthor): void => {
    commit(removeAuthor(latest.current, author.key));
    setAnnouncement(`Removed ${authorLabel(author)}.`);
    identifierRef.current?.focus();
  };

  const handleMove = (author: DraftAuthor, delta: -1 | 1): void => {
    const next = moveAuthor(latest.current, author.key, delta);
    commit(next);
    const position = next.findIndex((candidate) => candidate.key === author.key) + 1;
    setAnnouncement(`${authorLabel(author)} is now author ${position} of ${next.length}.`);
    // Keep focus on the button that was pressed; at the end of the list it is
    // disabled, so hand focus to the other one.
    const pressed = delta === -1 ? "up" : "down";
    const atEdge = delta === -1 ? position === 1 : position === next.length;
    pendingFocus.current = `sw-author-${author.key}-${atEdge ? (pressed === "up" ? "down" : "up") : pressed}`;
  };

  const blockers = authorsBlockers(namedAuthors);
  const stillLooking = authors.find((author) => looking.has(author.key));
  const complete = canContinueAuthors(authors) && stillLooking === undefined;
  const canContinue = complete && onContinue !== undefined;

  const hint =
    stillLooking !== undefined
      ? `Still looking for ${authorLabel(stillLooking)}'s account.`
      : !complete
        ? blockers[0]
        : onContinue === undefined
          ? `Step 4, ${nextStepLabel}, is not open in this release yet.`
          : null;

  return (
    <section className="sw-step" aria-labelledby="sw-authors-title">
      <h2 id="sw-authors-title" className="sw-step__title" tabIndex={-1}>
        Authors
      </h2>
      <p className="sw-step__lede">
        List everyone who should appear on the paper, in byline order. Each co-author gets a consent link and
        must sign before the paper can be listed.
      </p>

      <form className="sw-add" onSubmit={handleAdd} noValidate aria-labelledby="sw-authors-add-title">
        <h3 id="sw-authors-add-title" className="sw-add__title">
          Add a co-author
        </h3>
        <div className="sw-add__fields">
          <div className="sw-field sw-add__identifier">
            <label className="sw-field__label" htmlFor="sw-authors-identifier">
              DID, ORCID iD or email
            </label>
            <input
              id="sw-authors-identifier"
              ref={identifierRef}
              className="sw-input"
              type="text"
              value={identifier}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={error !== null}
              aria-describedby={`sw-authors-identifier-hint${error !== null ? " sw-authors-error" : ""}`}
              onChange={(event) => {
                setIdentifier(event.target.value);
                setError(null);
              }}
            />
          </div>
          <div className="sw-field sw-add__name">
            <label className="sw-field__label" htmlFor="sw-authors-name">
              Name (optional)
            </label>
            <input
              id="sw-authors-name"
              className="sw-input"
              type="text"
              value={name}
              autoComplete="off"
              maxLength={200}
              aria-describedby="sw-authors-name-hint"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button type="submit" className="sw-button sw-add__submit">
            <PlusIcon />
            Add co-author
          </button>
        </div>
        <p id="sw-authors-identifier-hint" className="sw-field__hint">
          {detectedHint ?? "A DID reads did:key:…, an ORCID iD 0000-0002-1825-0097."}
        </p>
        <p id="sw-authors-name-hint" className="sw-sr-only">
          How they appear in the byline.
        </p>
        {error !== null ? (
          <p id="sw-authors-error" className="sw-add__error" role="alert">
            <InfoIcon />
            {error}
          </p>
        ) : null}
      </form>

      <ol className="sw-authors" aria-label="Authors, in byline order">
        {namedAuthors.map((author, index) => (
          <AuthorCard
            key={author.key}
            author={author}
            index={index}
            count={authors.length}
            looking={looking.has(author.key)}
            canLookUp={resolveAuthor !== undefined}
            onMove={handleMove}
            onRemove={handleRemove}
            onToggleRole={(role) => commit(toggleCreditRole(latest.current, author.key, role))}
            onCheckAgain={() => void lookUp(author.key)}
          />
        ))}
      </ol>

      <ConsentTracker entries={entries} caption={caption} error={consents.error} />

      <div className="sw-actions">
        {onBack ? (
          <button type="button" className="sw-button sw-button--quiet" onClick={onBack}>
            Back to Details
          </button>
        ) : null}
        <button
          type="button"
          className="sw-button sw-button--primary"
          disabled={!canContinue}
          aria-describedby="sw-authors-continue-hint"
          onClick={() => onContinue?.(authors)}
        >
          Continue to {nextStepLabel}
        </button>
        <p id="sw-authors-continue-hint" className="sw-actions__hint">
          {hint}
        </p>
      </div>

      <p className="sw-sr-only" role="status" aria-label="Author list updates">
        {announcement}
      </p>
    </section>
  );
}

interface AuthorCardProps {
  author: DraftAuthor;
  index: number;
  count: number;
  looking: boolean;
  canLookUp: boolean;
  onMove: (author: DraftAuthor, delta: -1 | 1) => void;
  onRemove: (author: DraftAuthor) => void;
  onToggleRole: (role: string) => void;
  onCheckAgain: () => void;
}

function AuthorCard({
  author,
  index,
  count,
  looking,
  canLookUp,
  onMove,
  onRemove,
  onToggleRole,
  onCheckAgain,
}: AuthorCardProps): ReactElement {
  // Open while there is still a role to choose; after that the author decides.
  const [open, setOpen] = useState(author.creditRoles.length === 0);

  const label = authorLabel(author);
  const monogram = author.name.trim() === "" ? null : initials(author.name);
  const chosen = author.creditRoles;
  const idPrefix = `sw-author-${author.key}`;
  const detail =
    author.identifier === null
      ? null
      : author.kind === "did"
        ? `${KIND_LABELS.did} · ${shortDid(author.identifier)}`
        : `${KIND_LABELS[author.kind]} · ${author.identifier}`;
  // A name already stands in for the identifier; show it only when it adds something.
  const showDetail = detail !== null && (author.name.trim() !== "" || author.kind !== "did" || author.isSubmitter);
  const unmatched = author.match === "unmatched" && !looking;

  return (
    <li className="sw-author" data-match={looking ? "checking" : author.match}>
      <div className="sw-author__head">
        <span className="sw-author__position" aria-hidden="true">
          {index + 1}
        </span>
        <span className="sw-avatar" aria-hidden="true">
          {monogram ?? <PersonIcon />}
        </span>
        <span className="sw-author__who">
          <span className="sw-author__name">
            {label}
            {author.isSubmitter && label !== "You" ? <span className="sw-author__you"> (you)</span> : null}
          </span>
          {showDetail ? <span className="sw-author__detail">{detail}</span> : null}
        </span>

        {looking ? (
          <span className="sw-chip" data-tone="active">
            <InfoIcon />
            Looking for an account…
          </span>
        ) : unmatched ? (
          <span className="sw-chip" data-tone="pending">
            <InfoIcon />
            {author.isSubmitter ? "No DID yet" : "Not matched"}
          </span>
        ) : author.kind !== "did" ? (
          <span className="sw-chip" data-tone="verified">
            <CheckIcon />
            Matched to an account
          </span>
        ) : null}

        <span className="sw-author__controls">
          <button
            id={`${idPrefix}-up`}
            type="button"
            className="sw-icon-button"
            aria-label={`Move ${label} up`}
            disabled={index === 0}
            onClick={() => onMove(author, -1)}
          >
            <ArrowUpIcon />
          </button>
          <button
            id={`${idPrefix}-down`}
            type="button"
            className="sw-icon-button"
            aria-label={`Move ${label} down`}
            disabled={index === count - 1}
            onClick={() => onMove(author, 1)}
          >
            <ArrowDownIcon />
          </button>
          {author.isSubmitter ? null : (
            <button
              type="button"
              className="sw-button sw-button--quiet"
              aria-label={`Remove ${label}`}
              onClick={() => onRemove(author)}
            >
              Remove
            </button>
          )}
        </span>
      </div>

      {unmatched ? (
        <p className="sw-author__note">
          {whatMatchMeans(author, canLookUp)}
          {canLookUp && !author.isSubmitter ? (
            <>
              {" "}
              <button type="button" className="sw-link-button" onClick={onCheckAgain}>
                Check again<span className="sw-sr-only"> for {label}</span>
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      <details
        className="sw-roles"
        open={open}
        onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="sw-roles__summary">
          <span className="sw-roles__title">CRediT roles</span>
          <span className="sw-roles__chosen">
            {chosen.length === 0 ? "None chosen yet" : chosen.join(", ")}
          </span>
        </summary>
        <fieldset className="sw-fieldset sw-roles__set">
          <legend className="sw-sr-only">CRediT roles for {label}</legend>
          <div className="sw-chip-row">
            {CREDIT_ROLES.map((role) => {
              const selected = chosen.includes(role.id);
              return (
                <button
                  key={role.id}
                  type="button"
                  className="sw-chip sw-chip--choice"
                  aria-pressed={selected}
                  onClick={() => onToggleRole(role.id)}
                >
                  {selected ? <CheckIcon /> : null}
                  {role.id}
                  <span className="sw-sr-only"> — {role.summary}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      </details>
    </li>
  );
}
