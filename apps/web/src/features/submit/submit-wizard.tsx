"use client";

/**
 * The `/submit` wizard shell: heading, progress rail and the current step.
 *
 * Steps 1 (Files), 2 (Details) and 3 (Authors) are built. Files stays mounted
 * while the later steps are shown, so going back finds the same file list
 * rather than an empty zone. The wizard owns the Details draft and the author
 * roster for the same reason. The later steps (Checks, Sign) are separate
 * features that plug in here.
 */

import Link from "next/link";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { useSignedIn } from "../../components/nav/session";
import { initialAuthors, withSubmitterDid, type DraftAuthor, type ResolveAuthor } from "./authors";
import { AuthorsStep } from "./authors-step";
import { DetailsStep } from "./details-step";
import { emptyDetails, type DetailsValues } from "./details";
import { FilesStep, type FilesStepProps } from "./files-step";
import { useSubmitterDid } from "./use-submitter-did";
import { WizardRail } from "./wizard-rail";
import type { WizardStepId } from "./wizard-steps";
import "./submit.css";

export interface SubmitWizardProps {
  /** Passed to the Files step (tests replace the uploader with one that does not need a network). */
  managerDeps?: FilesStepProps["managerDeps"];
  /** Pin the sign-in state instead of reading it from the stored session. */
  signedIn?: boolean;
  /**
   * Pin the submitting author's DID instead of reading it from this device's
   * key. `null` means "no DID".
   */
  submitterDid?: string | null;
  /** Finds the account behind an ORCID iD or an email, for step 3. The API has no such lookup yet. */
  resolveAuthor?: ResolveAuthor;
}

export function SubmitWizard({
  managerDeps,
  signedIn,
  submitterDid,
  resolveAuthor,
}: SubmitWizardProps): ReactElement {
  const isSignedIn = useSignedIn(signedIn);
  // The stored session is only readable after mount. Wait for it before saying
  // "not signed in", so a signed-in author never sees the notice flash up.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [step, setStep] = useState<WizardStepId>("files");
  // The draft lives here, so stepping back to Files and forward again keeps it.
  const [details, setDetails] = useState<DetailsValues>(emptyDetails);
  const [authors, setAuthors] = useState<DraftAuthor[]>(() => initialAuthors());

  // The author building the submission is the first name on the byline. Their
  // DID comes from the device key, which is only readable after mount.
  const ownDid = useSubmitterDid(submitterDid);
  useEffect(() => {
    if (ownDid !== null) {
      setAuthors((current) => withSubmitterDid(current, ownDid));
    }
  }, [ownDid]);

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
        <DetailsStep
          value={details}
          onChange={setDetails}
          onBack={() => setStep("files")}
          onContinue={() => setStep("authors")}
        />
      ) : null}

      {step === "authors" ? (
        <AuthorsStep
          authors={authors}
          onChange={setAuthors}
          onBack={() => setStep("details")}
          resolveAuthor={resolveAuthor}
        />
      ) : null}
    </div>
  );
}
