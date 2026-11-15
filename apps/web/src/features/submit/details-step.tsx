"use client";

/**
 * Step 2 of the submit wizard: Details (docs/design.md §5.4).
 *
 * "Title, abstract (pre-filled from the file), categories, licence — licence
 * picker explains each option in one line and flags journal-compatibility."
 *
 * - **Title** and **abstract** are required; the character limits are stated
 *   before the author hits them.
 * - **Categories** are a fixed, grouped list, capped at three. Selection is
 *   carried by `aria-pressed` and a check icon, never by colour alone.
 * - **Licence** is a radio group, one card per option, each with a one-line
 *   explanation and a journal-compatibility flag. CC BY 4.0 is selected by
 *   default (PRD PUB-9).
 * - **Continue** explains what is missing instead of failing silently, and
 *   stays closed when there is no step 3 to go to yet.
 *
 * The form is controlled: `SubmitWizard` owns the draft, so moving back to
 * Files and forward again keeps what was typed.
 */

import { useEffect, useRef, type ReactElement } from "react";

import {
  ABSTRACT_MAX_LENGTH,
  CATEGORY_GROUPS,
  DEFAULT_LICENCE_ID,
  LICENCES,
  MAX_CATEGORIES,
  TITLE_MAX_LENGTH,
  canContinueDetails,
  detailsBlockers,
  toggleCategory,
  type DetailsValues,
} from "./details";
import { CheckIcon, InfoIcon } from "./icons";
import "./submit.css";

export interface DetailsStepProps {
  value: DetailsValues;
  onChange: (values: DetailsValues) => void;
  /** Go back to step 1, Files. */
  onBack?: () => void;
  /**
   * Go on to step 3. Without it Continue stays closed: there is no step 3 to
   * go to in this release.
   */
  onContinue?: (values: DetailsValues) => void;
  /** The name of the step Continue leads to, for the button and its hint. */
  nextStepLabel?: string;
}

export function DetailsStep({
  value,
  onChange,
  onBack,
  onContinue,
  nextStepLabel = "Authors",
}: DetailsStepProps): ReactElement {
  const titleRef = useRef<HTMLInputElement>(null);

  // Entering the step from Files should start at the first thing to fill in,
  // not leave focus on a button that has just disappeared.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const blockers = detailsBlockers(value);
  const complete = canContinueDetails(value);
  const canContinue = complete && onContinue !== undefined;
  const atCategoryLimit = value.categories.length >= MAX_CATEGORIES;

  const hint = !complete
    ? blockers[0]
    : onContinue === undefined
      ? `Step 3, ${nextStepLabel}, is not open in this release yet.`
      : null;

  const set = (patch: Partial<DetailsValues>): void => onChange({ ...value, ...patch });

  const selectedNames = value.categories.join(", ");
  const categorySummary =
    value.categories.length === 0
      ? "No categories chosen yet."
      : `${value.categories.length} of ${MAX_CATEGORIES} chosen: ${selectedNames}.` +
        (atCategoryLimit ? " Remove one to choose another." : "");

  return (
    <section className="sw-step" aria-labelledby="sw-details-title">
      <h2 id="sw-details-title" className="sw-step__title" tabIndex={-1}>
        Details
      </h2>
      <p className="sw-step__lede">
        Describe the paper. These details appear on its page and travel inside the signed record.
      </p>

      <div className="sw-field">
        <label className="sw-field__label" htmlFor="sw-details-title-input">
          Title
        </label>
        <input
          id="sw-details-title-input"
          ref={titleRef}
          className="sw-input"
          type="text"
          value={value.title}
          maxLength={TITLE_MAX_LENGTH}
          required
          aria-describedby="sw-details-title-hint"
          onChange={(event) => set({ title: event.target.value })}
        />
        <p id="sw-details-title-hint" className="sw-field__hint">
          As it should be cited. {value.title.length} of {TITLE_MAX_LENGTH} characters.
        </p>
      </div>

      <div className="sw-field">
        <label className="sw-field__label" htmlFor="sw-details-abstract">
          Abstract
        </label>
        <textarea
          id="sw-details-abstract"
          className="sw-input sw-textarea"
          rows={8}
          value={value.abstract}
          maxLength={ABSTRACT_MAX_LENGTH}
          required
          spellCheck
          aria-describedby="sw-details-abstract-hint"
          onChange={(event) => set({ abstract: event.target.value })}
        />
        <p id="sw-details-abstract-hint" className="sw-field__hint">
          A short summary a reader can scan. {value.abstract.length} of {ABSTRACT_MAX_LENGTH} characters.
        </p>
      </div>

      <fieldset className="sw-fieldset" aria-describedby="sw-details-categories-hint">
        <legend className="sw-field__label">Categories</legend>
        <p id="sw-details-categories-hint" className="sw-field__hint">
          Choose one to {MAX_CATEGORIES}. Readers browse by category and reviewers are matched by it.
        </p>

        <div className="sw-category-groups">
          {CATEGORY_GROUPS.map((group) => (
            <div
              key={group.id}
              className="sw-category-group"
              role="group"
              aria-labelledby={`sw-category-group-${group.id}`}
            >
              <h3 id={`sw-category-group-${group.id}`} className="sw-category-group__title">
                {group.label}
              </h3>
              <div className="sw-chip-row">
                {group.categories.map((category) => {
                  const selected = value.categories.includes(category.id);
                  const unavailable = atCategoryLimit && !selected;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      className="sw-chip sw-chip--choice"
                      aria-pressed={selected}
                      disabled={unavailable}
                      aria-describedby={unavailable ? "sw-details-categories-hint" : undefined}
                      onClick={() => set({ categories: toggleCategory(value.categories, category.id) })}
                    >
                      {selected ? <CheckIcon /> : null}
                      {category.id}
                      <span className="sw-sr-only"> — {category.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <p className="sw-summary" role="status">
          {categorySummary}
        </p>
      </fieldset>

      <fieldset className="sw-fieldset" aria-describedby="sw-details-licence-hint">
        <legend className="sw-field__label">Licence</legend>
        <p id="sw-details-licence-hint" className="sw-field__hint">
          Reuse rights are part of the signed record. Each option says what readers may do with the paper.
        </p>

        <div className="sw-licences">
          {LICENCES.map((licence) => {
            const selected = value.licence === licence.id;
            const accepted = licence.journal === "accepted";
            const nameId = `sw-licence-${licence.id}-name`;
            const flagId = `sw-licence-${licence.id}-flag`;
            const summaryId = `sw-licence-${licence.id}-summary`;
            return (
              // A label, so the whole card is a click target, not just the name.
              <label key={licence.id} className="sw-licence" data-selected={selected}>
                <input
                  id={`sw-licence-${licence.id}`}
                  className="sw-licence__input"
                  type="radio"
                  name="sw-details-licence"
                  value={licence.id}
                  checked={selected}
                  aria-labelledby={nameId}
                  aria-describedby={`${flagId} ${summaryId}`}
                  onChange={() => set({ licence: licence.id })}
                />
                <span className="sw-licence__text">
                  <span id={nameId} className="sw-licence__name">
                    {licence.label}
                    {licence.id === DEFAULT_LICENCE_ID ? (
                      <span className="sw-licence__default"> · Default</span>
                    ) : null}
                  </span>
                  <span id={summaryId} className="sw-licence__summary">
                    {licence.summary}
                  </span>
                </span>
                <span id={flagId} className="sw-chip sw-licence__flag" data-tone={accepted ? "verified" : "pending"}>
                  {accepted ? <CheckIcon /> : <InfoIcon />}
                  {accepted ? "Accepted by most journals" : "Check your journal"}
                </span>
              </label>
            );
          })}
        </div>

        <p className="sw-field__hint">
          Compatibility is guidance, not legal advice. Check the policy of the journal or funder you are
          submitting to.
        </p>
      </fieldset>

      <div className="sw-actions">
        {onBack ? (
          <button type="button" className="sw-button sw-button--quiet" onClick={onBack}>
            Back to Files
          </button>
        ) : null}
        <button
          type="button"
          className="sw-button sw-button--primary"
          disabled={!canContinue}
          aria-describedby="sw-details-continue-hint"
          onClick={() => onContinue?.(value)}
        >
          Continue to {nextStepLabel}
        </button>
        <p id="sw-details-continue-hint" className="sw-actions__hint">
          {hint}
        </p>
      </div>
    </section>
  );
}
