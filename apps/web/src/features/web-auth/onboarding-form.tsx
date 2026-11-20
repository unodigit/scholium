"use client";

/**
 * The `/onboarding` card: the five first-run steps as a checklist.
 *
 * create passkey → add your name → link ORCID → pick categories to follow →
 * set recovery guardians, in that order (`docs/design.md` §6, plus the profile
 * step that gives a member a name instead of a truncated DID). Each step shows
 * its state and its own controls:
 *
 * - **passkey** — done the moment a device key exists on this device;
 *   otherwise it links to `/signin`.
 * - **profile** — display name, optional affiliation and the email
 *   `PUT /v1/profiles/{did}` requires, saved through the same erasable-profile
 *   API the rest of the app reads names from.
 * - **ORCID** — "Link your ORCID iD" sends the whole browser to the authorize
 *   URL from `GET /v1/auth/orcid/start`; ORCID sends it back to
 *   `/onboarding/orcid` (see {@link OrcidReturn}), which finishes the link as
 *   the signed-in user. The step remembers the attempt.
 * - **categories** — chips to toggle (plus a free input), saved with
 *   `PUT /v1/me/follows/{category}`.
 * - **guardians** — five DID inputs saved with `PUT /v1/me/guardians`, with
 *   per-input problems from the same rules the API applies.
 *
 * The primary action stays locked until the guardians step is done — the API
 * refuses every submission with 403 until they are set — while a gentle
 * "skip for now" is always offered. Behaviour lives in `useOnboarding`; this
 * file is markup only.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  ONBOARDING_STEPS,
  PROFILE_AFFILIATION_MAX,
  PROFILE_EMAIL_MAX,
  PROFILE_NAME_MAX,
  loadPersistedOnboarding,
} from "./onboarding";
import { apiClient, browserTokenStorage, type ApiClient, type TokenStorage } from "../../lib/api";
import {
  CATEGORIES_ADD_ACTION,
  CATEGORIES_ADD_LABEL,
  CATEGORIES_SAVE_ACTION,
  CATEGORIES_SAVED_LOCALLY_SUFFIX,
  CATEGORIES_SAVING,
  CATEGORY_INVALID_MESSAGE,
  GUARDIANS_REQUIRED_NOTE,
  GUARDIANS_SAVED_NOTE,
  GUARDIANS_CHANGE_ON_SECURITY_ACTION,
  GUARDIANS_SAVE_ACTION,
  GUARDIANS_SAVING,
  GUARDIANS_SKIP_NOTE,
  ONBOARDING_FINISH_ACTION,
  ONBOARDING_LEDE,
  ONBOARDING_PASSKEY_CHECKING,
  ONBOARDING_PASSKEY_DONE,
  ONBOARDING_PASSKEY_MISSING,
  ONBOARDING_PASSKEY_SIGNIN_ACTION,
  ONBOARDING_SKIP_ACTION,
  ORCID_CONTINUE_ACTION,
  ORCID_LINKED_NOTE,
  ORCID_RETURN_BACK_ACTION,
  ORCID_RETURN_CONTINUE_ACTION,
  ORCID_RETURN_FAILED_TITLE,
  ORCID_RETURN_LINKED_TITLE,
  ORCID_RETURN_SIGNIN_ACTION,
  ORCID_RETURN_WORKING_NOTE,
  ORCID_RETURN_WORKING_TITLE,
  ORCID_RETRY_ACTION,
  ORCID_STARTING,
  ORCID_START_ACTION,
  ORCID_STARTED_NOTE,
  PROFILE_AFFILIATION_LABEL,
  PROFILE_EMAIL_HINT,
  PROFILE_EMAIL_LABEL,
  PROFILE_NAME_HINT,
  PROFILE_NAME_LABEL,
  PROFILE_SAVE_ACTION,
  PROFILE_SAVING,
  categoriesSavedMessage,
  onboardingProgressMessage,
  orcidReturnLinkedMessage,
  profileSavedMessage,
} from "./onboarding-messages";
import { useOnboarding, useOrcidReturn, type OnboardingServices } from "./use-onboarding";
import { shortDid } from "./verify-email";

/** Props for {@link OnboardingForm}. */
export interface OnboardingFormProps {
  /** Service override, for tests. */
  services?: OnboardingServices;
}

/** The `/onboarding` checklist. */
export function OnboardingForm({ services }: OnboardingFormProps = {}) {
  const router = useRouter();
  const onboarding = useOnboarding(services ? { services } : {});
  const client = services?.client ?? apiClient;
  const storage = services?.storage ?? browserTokenStorage;
  const [customCategory, setCustomCategory] = useState("");

  const doneById = new Map(onboarding.steps.map((step) => [step.id, step.done]));
  // `aria-current="step"` belongs to one element: the next step to do.
  const currentStepId = onboarding.steps.find((step) => !step.done)?.id;

  return (
    <section className="wa-card wa-onboarding" aria-labelledby="onboarding-heading">
      <p className="wa-wordmark">scholium</p>
      <h1 id="onboarding-heading" className="wa-title">
        Welcome
      </h1>
      <p className="wa-lede">{ONBOARDING_LEDE}</p>
      <p className="wa-count" role="status">
        {onboardingProgressMessage(onboarding.completedCount, onboarding.totalCount)}
      </p>

      <ol className="wa-steps">
        {ONBOARDING_STEPS.map((step) => {
          const done = doneById.get(step.id) === true;
          return (
            <li
              key={step.id}
              className={done ? "wa-step wa-step--done" : "wa-step"}
              aria-current={step.id === currentStepId ? "step" : undefined}
            >
              <div className="wa-step-head">
                <span className="wa-check" aria-hidden="true">
                  {done ? "✓" : "•"}
                </span>
                <h2 className="wa-step-title" id={`onboarding-step-${step.id}`}>
                  {step.title}
                </h2>
                {done ? (
                  <span className="wa-done-tag">Done</span>
                ) : null}
              </div>
              <p className="wa-step-summary">{step.summary}</p>

              <div className="wa-step-body">
                {step.id === "passkey" ? (
                  <PasskeyBody onboarding={onboarding} />
                ) : null}
                {step.id === "profile" ? <ProfileBody onboarding={onboarding} /> : null}
                {step.id === "orcid" ? <OrcidBody onboarding={onboarding} /> : null}
                {step.id === "categories" ? (
                  <CategoriesBody
                    onboarding={onboarding}
                    customCategory={customCategory}
                    onCustomCategoryChange={setCustomCategory}
                  />
                ) : null}
                {step.id === "guardians" ? (
                  <GuardiansBody onboarding={onboarding} client={client} storage={storage} />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {onboarding.error ? (
        <p className="wa-error" role="alert">
          <strong>Couldn&rsquo;t save that.</strong> {onboarding.error}
        </p>
      ) : null}

      <div className="wa-finish">
        <button
          type="button"
          className="wa-button"
          onClick={() => router.replace("/papers")}
          disabled={!onboarding.ready || !onboarding.canFinish}
          aria-describedby={onboarding.canFinish ? undefined : "onboarding-finish-note"}
        >
          {ONBOARDING_FINISH_ACTION}
        </button>
        {!onboarding.canFinish ? (
          <p className="wa-meta" id="onboarding-finish-note">
            {GUARDIANS_SKIP_NOTE}{" "}
            <Link className="wa-skip" href="/papers">
              {ONBOARDING_SKIP_ACTION}
            </Link>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Passkey step: it is done exactly when a device key exists here. */
function PasskeyBody({ onboarding }: { onboarding: ReturnType<typeof useOnboarding> }) {
  const note = !onboarding.ready
    ? ONBOARDING_PASSKEY_CHECKING
    : onboarding.passkeyReady
      ? ONBOARDING_PASSKEY_DONE
      : ONBOARDING_PASSKEY_MISSING;
  return (
    <>
      <p className="wa-note">{note}</p>
      {onboarding.ready && !onboarding.passkeyReady ? (
        <Link className="wa-link" href="/signin">
          {ONBOARDING_PASSKEY_SIGNIN_ACTION}
        </Link>
      ) : null}
    </>
  );
}

/**
 * Profile step: the display name readers see, an optional affiliation, and the
 * email the profile API requires (it sends a verification link there).
 *
 * A real `<form>` with labels and the browser's own `type`/`autocomplete`
 * hints, so autofill works and Enter submits; the hook validates before any
 * request and maps the API's 422 problems back onto these inputs.
 */
function ProfileBody({ onboarding }: { onboarding: ReturnType<typeof useOnboarding> }) {
  const { profile, setProfileField, saveProfileAction, did } = onboarding;
  const problemFor = (field: "name" | "affiliation" | "email") =>
    profile.problems.find((problem) => problem.field === field);
  const formProblem = profile.problems.find((problem) => problem.field === null);

  const nameProblem = problemFor("name");
  const affiliationProblem = problemFor("affiliation");
  const emailProblem = problemFor("email");

  return (
    <form
      aria-labelledby="onboarding-step-profile"
      onSubmit={(event) => {
        event.preventDefault();
        void saveProfileAction();
      }}
    >
      <div className="wa-field">
        <label className="wa-field-label" htmlFor="onboarding-profile-name">
          {PROFILE_NAME_LABEL}
        </label>
        <input
          id="onboarding-profile-name"
          className="wa-input"
          type="text"
          name="name"
          autoComplete="name"
          required
          maxLength={PROFILE_NAME_MAX}
          value={profile.name}
          onChange={(event) => setProfileField("name", event.target.value)}
          aria-invalid={nameProblem ? true : undefined}
          aria-describedby={nameProblem ? "onboarding-profile-name-problem" : undefined}
        />
        {nameProblem ? (
          <p className="wa-field-error" id="onboarding-profile-name-problem" role="alert">
            {nameProblem.message}
          </p>
        ) : null}
        <p className="wa-note">{PROFILE_NAME_HINT}</p>
      </div>

      <div className="wa-field">
        <label className="wa-field-label" htmlFor="onboarding-profile-affiliation">
          {PROFILE_AFFILIATION_LABEL}
        </label>
        <input
          id="onboarding-profile-affiliation"
          className="wa-input"
          type="text"
          name="affiliation"
          autoComplete="organization"
          maxLength={PROFILE_AFFILIATION_MAX}
          value={profile.affiliation}
          onChange={(event) => setProfileField("affiliation", event.target.value)}
          aria-invalid={affiliationProblem ? true : undefined}
          aria-describedby={
            affiliationProblem ? "onboarding-profile-affiliation-problem" : undefined
          }
        />
        {affiliationProblem ? (
          <p
            className="wa-field-error"
            id="onboarding-profile-affiliation-problem"
            role="alert"
          >
            {affiliationProblem.message}
          </p>
        ) : null}
      </div>

      <div className="wa-field">
        <label className="wa-field-label" htmlFor="onboarding-profile-email">
          {PROFILE_EMAIL_LABEL}
        </label>
        <input
          id="onboarding-profile-email"
          className="wa-input"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          required
          maxLength={PROFILE_EMAIL_MAX}
          value={profile.email}
          onChange={(event) => setProfileField("email", event.target.value)}
          aria-invalid={emailProblem ? true : undefined}
          aria-describedby={
            emailProblem
              ? "onboarding-profile-email-problem"
              : "onboarding-profile-email-hint"
          }
        />
        {emailProblem ? (
          <p className="wa-field-error" id="onboarding-profile-email-problem" role="alert">
            {emailProblem.message}
          </p>
        ) : (
          <p className="wa-note" id="onboarding-profile-email-hint">
            {PROFILE_EMAIL_HINT}
          </p>
        )}
      </div>

      {formProblem ? (
        <p className="wa-field-error" role="alert">
          {formProblem.message}
        </p>
      ) : null}

      <button
        type="submit"
        className="wa-button wa-button--small"
        disabled={profile.saving || !did}
      >
        {profile.saving ? PROFILE_SAVING : PROFILE_SAVE_ACTION}
      </button>
      {profile.saved ? (
        <p className="wa-note">{profileSavedMessage(profile.name || "your name")}</p>
      ) : null}
    </form>
  );
}

/** Link-ORCID step: send the browser to the authorize URL. */
function OrcidBody({ onboarding }: { onboarding: ReturnType<typeof useOnboarding> }) {
  const { orcid, linkOrcid } = onboarding;
  return (
    <>
      {orcid.linked ? (
        <p className="wa-note">{ORCID_LINKED_NOTE}</p>
      ) : orcid.error ? (
        <>
          <p className="wa-note wa-error" role="alert">
            {orcid.error}
          </p>
          <button
            type="button"
            className="wa-button wa-button--small"
            onClick={() => void linkOrcid()}
            disabled={orcid.starting}
          >
            {orcid.starting ? ORCID_STARTING : ORCID_RETRY_ACTION}
          </button>
        </>
      ) : orcid.started ? (
        <>
          <p className="wa-note">{ORCID_STARTED_NOTE}</p>
          <button
            type="button"
            className="wa-button wa-button--small"
            onClick={() => void linkOrcid()}
            disabled={orcid.starting}
          >
            {orcid.starting ? ORCID_STARTING : ORCID_CONTINUE_ACTION}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="wa-button wa-button--small"
          onClick={() => void linkOrcid()}
          disabled={orcid.starting}
        >
          {orcid.starting ? ORCID_STARTING : ORCID_START_ACTION}
        </button>
      )}
    </>
  );
}

/** Categories step: chips, a free input, and the save action. */
function CategoriesBody({
  onboarding,
  customCategory,
  onCustomCategoryChange,
}: {
  onboarding: ReturnType<typeof useOnboarding>;
  customCategory: string;
  onCustomCategoryChange: (value: string) => void;
}) {
  const { categories, toggleCategory, addCategory, saveCategories } = onboarding;
  return (
    <>
      <div className="wa-chip-row" role="group" aria-label="Categories to follow">
        {categories.choices.map((category) => (
          <button
            key={category}
            type="button"
            className="wa-chip"
            aria-pressed={categories.selected.includes(category)}
            onClick={() => toggleCategory(category)}
          >
            {category}
          </button>
        ))}
      </div>

      <div className="wa-add-row">
        <input
          className="wa-input"
          type="text"
          aria-label={CATEGORIES_ADD_LABEL}
          placeholder="e.g. math.CO"
          value={customCategory}
          onChange={(event) => onCustomCategoryChange(event.target.value)}
        />
        <button
          type="button"
          className="wa-button wa-button--small wa-button--quiet"
          onClick={() => {
            if (addCategory(customCategory)) {
              onCustomCategoryChange("");
            }
          }}
        >
          {CATEGORIES_ADD_ACTION}
        </button>
      </div>
      {categories.invalidMessage ? (
        <p className="wa-field-error" role="alert">
          {categories.invalidMessage}
        </p>
      ) : null}

      <button
        type="button"
        className="wa-button wa-button--small"
        onClick={() => void saveCategories()}
        disabled={categories.saving || categories.selected.length === 0}
      >
        {categories.saving ? CATEGORIES_SAVING : CATEGORIES_SAVE_ACTION}
      </button>
      {categories.saved ? (
        <p className="wa-note">
          {categoriesSavedMessage(categories.saved)}
          {categories.savedToAccount ? "" : CATEGORIES_SAVED_LOCALLY_SUFFIX}
        </p>
      ) : null}
    </>
  );
}

/** Read a public profile name out of a `GET /profiles/{did}` body, or `null`. */
function profileNameFrom(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.erased === true) {
    return null;
  }
  for (const key of ["name", "display_name", "displayName"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

/** Guardians step: five DID inputs and the save action. */
function GuardiansBody({
  onboarding,
  client,
  storage,
}: {
  onboarding: ReturnType<typeof useOnboarding>;
  client: Pick<ApiClient, "get">;
  storage: TokenStorage;
}) {
  const { guardians, setGuardianValue, saveGuardiansAction } = onboarding;
  const guardiansStepDone = onboarding.steps.some(
    (step) => step.id === "guardians" && step.done,
  );
  const isSaved = guardians.saved !== null || guardiansStepDone;

  // Saved guardians may live only in browser storage (after a reload) even when
  // the in-memory `guardians.saved` is null, so fall back to them there.
  let persistedGuardians: string[] = [];
  try {
    persistedGuardians = storage
      ? loadPersistedOnboarding(storage).guardians
      : [];
  } catch {
    persistedGuardians = [];
  }
  const savedList =
    guardians.saved !== null
      ? guardians.saved
      : isSaved && persistedGuardians.length > 0
        ? persistedGuardians
        : null;

  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (savedList === null || savedList.length === 0) {
      setNames((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
      return;
    }
    const list = savedList;
    const controller = new AbortController();
    let active = true;
    void Promise.all(
      list.map(async (did) => {
        try {
          const payload = await client.get<unknown>(
            `/profiles/${encodeURIComponent(did)}`,
            { auth: false, cache: "no-store", signal: controller.signal },
          );
          return [did, profileNameFrom(payload)] as const;
        } catch {
          return [did, null] as const;
        }
      }),
    ).then((results) => {
      if (!active || controller.signal.aborted) {
        return;
      }
      const next: Record<string, string> = {};
      for (const [did, name] of results) {
        if (name !== null && name !== "") {
          next[did] = name;
        }
      }
      setNames(next);
    });
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedList === null ? "" : savedList.join("\n"), client]);

  if (isSaved) {
    return (
      <>
        <p className="wa-note">{GUARDIANS_SAVED_NOTE}</p>
        {savedList !== null ? (
          <ul className="wa-guardian-list">
            {savedList.map((value, index) => {
              const label = names[value] ?? shortDid(value);
              const named = Boolean(names[value]);
              return (
                <li
                  key={`${value}-${index}`}
                  className={named ? "wa-note" : "wa-note wa-input--mono"}
                  title={value}
                  style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                >
                  {label}
                </li>
              );
            })}
          </ul>
        ) : null}
        <p className="wa-note">
          <Link className="wa-link" href="/me/security">
            {GUARDIANS_CHANGE_ON_SECURITY_ACTION}
          </Link>
        </p>
      </>
    );
  }

  const listProblem = guardians.problems.find((problem) => problem.index === null);
  return (
    <>
      {guardians.saved ? <p className="wa-note">{GUARDIANS_SAVED_NOTE}</p> : null}
      {guardians.values.map((value, index) => {
        const problem = guardians.problems.find((entry) => entry.index === index);
        const inputId = `onboarding-guardian-${index}`;
        return (
          <div className="wa-field" key={inputId}>
            <label className="wa-field-label" htmlFor={inputId}>
              Guardian {index + 1}
            </label>
            <input
              id={inputId}
              className="wa-input wa-input--mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="did:key:z6Mk…"
              value={value}
              onChange={(event) => setGuardianValue(index, event.target.value)}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${inputId}-problem` : undefined}
            />
            {problem ? (
              <p className="wa-field-error" id={`${inputId}-problem`}>
                {problem.message}
              </p>
            ) : null}
          </div>
        );
      })}
      {listProblem ? (
        <p className="wa-field-error" role="alert">
          {listProblem.message}
        </p>
      ) : null}
      <button
        type="button"
        className="wa-button wa-button--small"
        onClick={() => void saveGuardiansAction()}
        disabled={guardians.saving}
      >
        {guardians.saving ? GUARDIANS_SAVING : GUARDIANS_SAVE_ACTION}
      </button>
      <p className="wa-requirement">{GUARDIANS_REQUIRED_NOTE}</p>
    </>
  );
}

/**
 * `/onboarding/orcid` — where ORCID sends the browser after the user signs in.
 *
 * Finishes the link as the signed-in user (`useOrcidReturn`), then shows the
 * outcome: the success, or the API's own explanation of why nothing was
 * linked — for example that the sign-in was started by a different account.
 * Either way the way back to the checklist is one action away.
 *
 * Announcements: one polite `role="status"` region exists from the first
 * render and its text changes (a region that is merely inserted is announced
 * unreliably), and once the outcome is known focus moves to the heading so a
 * screen reader reads the result instead of staying on an empty page.
 */
export function OrcidReturn() {
  const { status, orcid, error, sessionExpired } = useOrcidReturn();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (status !== "completing") {
      headingRef.current?.focus();
    }
  }, [status]);

  const title =
    status === "linked"
      ? ORCID_RETURN_LINKED_TITLE
      : status === "failed"
        ? ORCID_RETURN_FAILED_TITLE
        : ORCID_RETURN_WORKING_TITLE;
  const message =
    status === "linked"
      ? orcidReturnLinkedMessage(orcid)
      : status === "failed"
        ? (error ?? "")
        : ORCID_RETURN_WORKING_NOTE;

  return (
    <section
      className="wa-card"
      aria-labelledby="orcid-return-heading"
      aria-busy={status === "completing"}
    >
      <p className="wa-wordmark">scholium</p>
      <h1 id="orcid-return-heading" className="wa-title" ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <p className={status === "failed" ? "wa-lede wa-error" : "wa-lede"} role="status">
        {message}
      </p>

      {status === "linked" ? (
        <Link className="wa-button" href="/onboarding">
          {ORCID_RETURN_CONTINUE_ACTION}
        </Link>
      ) : null}
      {status === "failed" ? (
        <>
          {sessionExpired ? (
            <Link className="wa-button" href="/signin">
              {ORCID_RETURN_SIGNIN_ACTION}
            </Link>
          ) : (
            <Link className="wa-button" href="/onboarding">
              {ORCID_RETURN_BACK_ACTION}
            </Link>
          )}
          {sessionExpired ? (
            <p className="wa-meta">
              <Link className="wa-link" href="/onboarding">
                {ORCID_RETURN_BACK_ACTION}
              </Link>
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export default OnboardingForm;
