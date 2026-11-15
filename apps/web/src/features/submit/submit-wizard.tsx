"use client";

/**
 * The `/submit` wizard shell: heading, progress rail and the current step.
 *
 * Only step 1 (Files) exists so far. The later steps (Details, Authors,
 * Checks, Sign) are separate features that plug in here; `FilesStep` already
 * reports the finished files through `onFilesChange` and `onContinue` for them
 * to pick up.
 */

import Link from "next/link";
import { useEffect, useState, type ReactElement } from "react";

import { useSignedIn } from "../../components/nav/session";
import { FilesStep, type FilesStepProps } from "./files-step";
import { WizardRail } from "./wizard-rail";
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

  return (
    <div className="sw-wizard">
      <header className="sw-header">
        <p className="sw-crumb">Submit</p>
        <h1 className="sw-title">Submit a paper</h1>
      </header>

      <WizardRail current="files" />

      {mounted && !isSignedIn ? (
        <p className="sw-notice" role="note">
          You are not signed in. <Link href="/signin?next=%2Fsubmit">Sign in</Link> first so your uploads are
          linked to you.
        </p>
      ) : null}

      <FilesStep managerDeps={managerDeps} />
    </div>
  );
}
