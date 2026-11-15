/**
 * The persistent progress rail: `1 Files ─── 2 Details ─── … ─── 5 Sign`.
 *
 * A step is either done (✓ and "done"), current, or ahead. The state is always
 * a word as well as a marker, and the current step carries `aria-current="step"`.
 */

import type { ReactElement } from "react";

import { CheckIcon } from "./icons";
import { stepIndex, WIZARD_STEPS, type WizardStepId } from "./wizard-steps";

export function WizardRail({ current }: { current: WizardStepId }): ReactElement {
  const currentIndex = stepIndex(current);
  return (
    <nav className="sw-rail" aria-label="Submission progress">
      <ol className="sw-rail__list">
        {WIZARD_STEPS.map((step, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "ahead";
          return (
            <li
              key={step.id}
              className="sw-rail__step"
              data-state={state}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="sw-rail__marker" aria-hidden="true">
                {state === "done" ? <CheckIcon /> : index + 1}
              </span>
              <span className="sw-rail__label">{step.label}</span>
              {state === "done" ? <span className="sw-sr-only"> (done)</span> : null}
              {state === "ahead" ? <span className="sw-sr-only"> (not started)</span> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
