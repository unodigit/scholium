"use client";

/**
 * The `/onboarding` card: the four first-run steps as a checklist.
 *
 * create passkey → link ORCID → pick categories to follow → set recovery
 * guardians, in that order (`docs/design.md` §6). Each step shows its state
 * and its own controls:
 *
 * - **passkey** — done the moment a device key exists on this device;
 *   otherwise it links to `/signin`.
 * - **ORCID** — "Link your ORCID iD" sends the whole browser to the authorize
 *   URL from `GET /v1/auth/orcid/start`; coming back, the step remembers the
 *   attempt.
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

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ONBOARDING_STEPS } from "./onboarding";
import {
  CATEGORIES_ADD_ACTION,
  CATEGORIES_ADD_LABEL,
  CATEGORIES_SAVE_ACTION,
  CATEGORIES_SAVED_LOCALLY_SUFFIX,
  CATEGORIES_SAVING,
  CATEGORY_INVALID_MESSAGE,
  GUARDIANS_REQUIRED_NOTE,
  GUARDIANS_SAVED_NOTE,
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
  ORCID_STARTING,
  ORCID_START_ACTION,
  ORCID_STARTED_NOTE,
  categoriesSavedMessage,
  onboardingProgressMessage,
} from "./onboarding-messages";
import { useOnboarding } from "./use-onboarding";

/** The `/onboarding` checklist. */
export function OnboardingForm() {
  const router = useRouter();
  const onboarding = useOnboarding();
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
                <h2 className="wa-step-title">{step.title}</h2>
                {done ? (
                  <span className="wa-done-tag">Done</span>
                ) : null}
              </div>
              <p className="wa-step-summary">{step.summary}</p>

              <div className="wa-step-body">
                {step.id === "passkey" ? (
                  <PasskeyBody onboarding={onboarding} />
                ) : null}
                {step.id === "orcid" ? <OrcidBody onboarding={onboarding} /> : null}
                {step.id === "categories" ? (
                  <CategoriesBody
                    onboarding={onboarding}
                    customCategory={customCategory}
                    onCustomCategoryChange={setCustomCategory}
                  />
                ) : null}
                {step.id === "guardians" ? <GuardiansBody onboarding={onboarding} /> : null}
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
          onClick={() => router.replace("/")}
          disabled={!onboarding.ready || !onboarding.canFinish}
          aria-describedby={onboarding.canFinish ? undefined : "onboarding-finish-note"}
        >
          {ONBOARDING_FINISH_ACTION}
        </button>
        {!onboarding.canFinish ? (
          <p className="wa-meta" id="onboarding-finish-note">
            {GUARDIANS_SKIP_NOTE}{" "}
            <Link className="wa-skip" href="/">
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

/** Link-ORCID step: send the browser to the authorize URL. */
function OrcidBody({ onboarding }: { onboarding: ReturnType<typeof useOnboarding> }) {
  const { orcid, linkOrcid } = onboarding;
  return (
    <>
      {orcid.linked ? (
        <p className="wa-note">{ORCID_LINKED_NOTE}</p>
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

/** Guardians step: five DID inputs and the save action. */
function GuardiansBody({ onboarding }: { onboarding: ReturnType<typeof useOnboarding> }) {
  const { guardians, setGuardianValue, saveGuardiansAction } = onboarding;
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

export default OnboardingForm;
