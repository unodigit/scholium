"use client";

/**
 * The `/submit` wizard shell: heading, progress rail and the current step.
 *
 * Steps 1 (Files) and 2 (Details) are built. Files stays mounted while Details
 * is shown, so going back finds the same file list rather than an empty zone.
 * The later steps (Authors, Checks, Sign) are separate features that plug in
 * here.
 */

import Link from "next/link";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { useSignedIn } from "../../components/nav/session";
import { DetailsStep } from "./details-step";
import { emptyDetails, type DetailsValues } from "./details";
import { FilesStep, type FilesStepProps } from "./files-step";
import { WizardRail } from "./wizard-rail";
import type { WizardStepId } from "./wizard-steps";
import "./submit.css";

export interface SubmitWizardProps {
  /** Passed to the Files step (tests replace the uploader with one that does not need a network). */
  managerDeps?: FilesStepProps["managerDeps"];
  /** Pin the sign-in state instead of reading it from the stored session. */
  signedIn?: boolean;
}

export function SubmitWizard({ managerDeps, signedIn }: SubmitWizardProps): ReactElement {
  const isSignedIn = useSignedIn(signedIn);
  // The stored session is only readable after mount. Wait for it before saying
  // "not signed in", so a signed-in author never sees the notice flash up.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [step, setStep] = useState<WizardStepId>("files");
  // The draft lives here, so stepping back to Files and forward again keeps it.
  const [details, setDetails] = useState<DetailsValues>(emptyDetails);

  // Coming back from Details leaves focus on a button that no longer exists;
  // move it to the Files heading instead of dropping it on the document.
  const previousStep = useRef<WizardStepId>("files");
  useEffect(() => {
    if (previousStep.current === "details" && step === "files") {
      document.getElementById("sw-files-title")?.focus();
    }
    previousStep.current = step;
  }, [step]);

  return (
    <div className="sw-wizard">
      <header className="sw-header">
        <p className="sw-crumb">Submit</p>
        <h1 className="sw-title">Submit a paper</h1>
      </header>

      <WizardRail current={step} />

      {mounted && !isSignedIn ? (
        <p className="sw-notice" role="note">
          You are not signed in. <Link href="/signin?next=%2Fsubmit">Sign in</Link> first so your uploads are
          linked to you.
        </p>
      ) : null}

      <div hidden={step !== "files"}>
        <FilesStep managerDeps={managerDeps} onContinue={() => setStep("details")} />
      </div>

      {step === "details" ? (
        <DetailsStep value={details} onChange={setDetails} onBack={() => setStep("files")} />
      ) : null}
    </div>
  );
}
