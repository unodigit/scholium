/**
 * The five steps of the submit wizard (docs/design.md §5.4):
 *
 * ```text
 * 1 Files ─── 2 Details ─── 3 Authors ─── 4 Checks ─── 5 Sign
 * ```
 *
 * One list, so the progress rail and the steps themselves cannot disagree about
 * the order or the names.
 */

export const WIZARD_STEPS = [
  { id: "files", label: "Files" },
  { id: "details", label: "Details" },
  { id: "authors", label: "Authors" },
  { id: "checks", label: "Checks" },
  { id: "sign", label: "Sign" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

/** Zero-based position of a step in the wizard. */
export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEPS.findIndex((step) => step.id === id);
}

/** The step after `id`, or `null` after the last. */
export function nextStep(id: WizardStepId): (typeof WIZARD_STEPS)[number] | null {
  return WIZARD_STEPS[stepIndex(id) + 1] ?? null;
}
