"use client";

/**
 * The `/submit` wizard shell: heading, progress rail and the current step.
 *
 * Steps 1 (Files), 2 (Details), 3 (Authors) and 4 (Checks) are built. Files
 * stays mounted while the later steps are shown, so going back finds the same
 * file list rather than an empty zone. The wizard owns the Details draft and
 * the author roster for the same reason. Step 5 (Sign) is a separate feature
 * that plugs in here.
 *
 * Whether the viewer may submit at all is read when the page opens (tier,
 * endorsements) and re-checked as categories are chosen, and explained in a
 * notice above the steps, before any upload. The node still decides when the
 * paper is signed; a check that cannot be read never blocks the wizard.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { useSignedIn } from "../../components/nav/session";
import { initialAuthors, withSubmitterDid, type DraftAuthor, type ResolveAuthor } from "./authors";
import { AuthorsStep } from "./authors-step";
import type { ChecksVersionRef, FetchChecks } from "./checks";
import { ChecksStep } from "./checks-step";
import { DetailsStep } from "./details-step";
import {
  describeBlocker,
  fetchEligibility as readEligibility,
  findBlockers,
  type EligibilityFacts,
  type FetchEligibility,
} from "./eligibility";
import { SignStep, type SignStepProps } from "./sign-step";
import { emptyDetails, type DetailsValues } from "./details";
import {
  createSubmitDraftStorage,
  type SubmitDraft,
  type SubmitDraftStorage,
} from "./submit-draft-storage";
import { FilesStep, type FilesStepProps } from "./files-step";
import type { SubmitFile } from "./upload-manager";
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
  /**
   * The version whose check results step 4 should show. A draft has no version
   * until it is signed, so this is `null`/absent while the author builds one;
   * pass it when the wizard resumes a signed version or from a status page.
   */
  checksFor?: ChecksVersionRef | null;
  /** Replaces the check request, for tests and callers with their own client. */
  fetchChecks?: FetchChecks;
  /** How often step 4 asks the node again while it is scanning. */
  checksPollMs?: number;
  /** Replaces the tier / endorsement lookup, for tests and callers with their own client. */
  fetchEligibility?: FetchEligibility;
  /** Injected signer, for tests and callers with their own client. */
  signRecord?: SignStepProps["signRecord"];
  /** Injected record submitter, for tests and callers with their own client. */
  submitRecord?: SignStepProps["submitRecord"];
  /** Replaces the consent report request, for tests and callers with their own client. */
  fetchConsents?: SignStepProps["fetchConsents"];
  /** Persistence for the wizard draft. Tests may inject a store or an IndexedDB factory. */
  draftStorage?: SubmitDraftStorage;
  storage?: SubmitDraftStorage;
  draftStorageFactory?: (options?: { factory?: IDBFactory }) => SubmitDraftStorage;
  indexedDbFactory?: IDBFactory;
  idbFactory?: IDBFactory;
  factory?: IDBFactory;
  draftDbFactory?: IDBFactory;
}

export function SubmitWizard({
  managerDeps,
  signedIn,
  submitterDid,
  resolveAuthor,
  checksFor,
  fetchChecks,
  checksPollMs,
  fetchEligibility,
  signRecord,
  submitRecord,
  fetchConsents,
  draftStorage,
  storage,
  draftStorageFactory,
  indexedDbFactory,
  idbFactory,
  factory,
  draftDbFactory,
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
  // The finished files travel with the draft: step 4 names the files that will
  // be scanned before the version (and so its real check results) exists.
  const [files, setFiles] = useState<SubmitFile[]>([]);

  // The author building the submission is the first name on the byline. Their
  // DID comes from the device key, which is only readable after mount.
  const ownDid = useSubmitterDid(submitterDid);
  useEffect(() => {
    if (ownDid !== null) {
      setAuthors((current) => withSubmitterDid(current, ownDid));
    }
  }, [ownDid]);

  // What the node says the viewer may do. `null` until it has answered, and
  // again if it could not: then nothing is claimed and the node's answer at
  // signing stands.
  const [facts, setFacts] = useState<EligibilityFacts | null>(null);
  const fetchEligibilityRef = useRef(fetchEligibility);
  fetchEligibilityRef.current = fetchEligibility;
  useEffect(() => {
    if (!mounted || !isSignedIn) {
      setFacts(null);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const read = fetchEligibilityRef.current ?? ((did, signal) => readEligibility(did, undefined, signal));
        const result = await read(ownDid, controller.signal);
        if (!controller.signal.aborted) {
          setFacts(result);
        }
      } catch {
        if (!controller.signal.aborted) {
          setFacts(null);
        }
      }
    })();
    return () => controller.abort();
  }, [mounted, isSignedIn, ownDid]);
  const blockers = useMemo(
    () => (facts === null ? [] : findBlockers(facts, details.categories)),
    [facts, details.categories],
  );
  // The category mismatch is about the chips under the author's hand, so while
  // Details is open it is shown beside the picker (DetailsStep) instead of
  // above the wizard, where it is off-screen. On the later steps it returns to
  // the page-level status region, so it is still said before signing.
  const categoryBlocker = blockers.find((blocker) => blocker.kind === "categories") ?? null;
  const categoryWarning = categoryBlocker === null ? null : describeBlocker(categoryBlocker, { did: ownDid });
  const pageBlockers = blockers.filter(
    (blocker) => blocker.kind !== "categories" || step !== "details",
  );

  // Signing is the end of the wizard: the header says so instead of offering
  // the draft state of a paper that no longer is one.
  const [submitted, setSubmitted] = useState(false);
  // The weekly limit is the one rule that stops the paper existing at all: no
  // upload can make it start sooner, so the wizard waits rather than letting
  // the author fill five steps for a `429` at signing. The other blockers are
  // said above but still allow preparing a draft.
  const blockedByWeek = blockers.some((blocker) => blocker.kind === "weekly-limit");

  // Pick the persistence backend. Props win; otherwise IndexedDB when the
  // browser has it, with an in-memory fallback for tests and SSR.
  const resolvedFactory = draftDbFactory ?? indexedDbFactory ?? idbFactory ?? factory ?? undefined;
  const draftStore = useMemo<SubmitDraftStorage>(() => {
    if (draftStorage) {
      return draftStorage;
    }
    if (storage) {
      return storage;
    }
    if (draftStorageFactory) {
      return draftStorageFactory({ factory: resolvedFactory });
    }
    return createSubmitDraftStorage(resolvedFactory ? { factory: resolvedFactory } : {});
  }, [draftStorage, storage, draftStorageFactory, resolvedFactory]);

  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved">("idle");
  const draftLoadedRef = useRef(false);
  const skipDraftSaveRef = useRef(true);
  const firstDraftSaveRef = useRef(true);

  // Restore a saved draft when the author returns to /submit.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const saved = await draftStore.get();
        if (!active || !saved) {
          // nothing to restore
        } else {
          if (saved.step) {
            setStep(saved.step);
          }
          if (saved.details) {
            setDetails(saved.details);
          }
          if (Array.isArray(saved.authors) && saved.authors.length > 0) {
            setAuthors(saved.authors);
          }
          if (Array.isArray(saved.files)) {
            setFiles(saved.files);
          }
        }
      } catch {
        // Storage may be blocked; behave as if there were no draft.
      }
      if (active) {
        draftLoadedRef.current = true;
        skipDraftSaveRef.current = false;
      }
    })();
    return () => {
      active = false;
    };
  }, [draftStore]);

  // Save the draft on every change.
  useEffect(() => {
    if (!draftLoadedRef.current || skipDraftSaveRef.current) {
      return;
    }
    if (firstDraftSaveRef.current) {
      firstDraftSaveRef.current = false;
      return;
    }
    setDraftStatus("saving");
    const draft: SubmitDraft = { step, details, authors, files };
    let active = true;
    void draftStore
      .put(draft)
      .then(() => {
        if (active) {
          setDraftStatus("saved");
        }
      })
      .catch(() => {
        if (active) {
          setDraftStatus("idle");
        }
      });
    return () => {
      active = false;
    };
  }, [step, details, authors, files, draftStore]);

  // Coming back to Files leaves focus on a button that no longer exists; move
  // it to the Files heading instead of dropping it on the document.
  const previousStep = useRef<WizardStepId>("files");
  useEffect(() => {
    if (previousStep.current !== "files" && step === "files") {
      document.getElementById("sw-files-title")?.focus();
    }
    previousStep.current = step;
  }, [step]);

  return (
    <div className="sw-wizard">
      <header className="sw-header">
        <p className="sw-crumb">Submit</p>
        <h1 className="sw-title">{submitted ? "Submitted - version 1" : "Submit a paper"}</h1>
        {draftStatus === "saved" && !submitted ? (
          <p className="sw-draft-saved" role="status">
            Draft saved
          </p>
        ) : null}
      </header>

      <WizardRail current={step} />

      {mounted && !isSignedIn ? (
        <p className="sw-notice" role="note">
          You are not signed in. <Link href="/signin?next=%2Fsubmit">Sign in</Link> first so your uploads are
          linked to you.
        </p>
      ) : null}

      {/* Always in the page, so a blocker appearing or clearing is announced. */}
      <div className="sw-eligibility" role="status" aria-label="Submission eligibility">
        {pageBlockers.map((blocker) => {
          const message = describeBlocker(blocker, { did: ownDid });
          return (
            <div key={blocker.kind} className="sw-eligibility__item" data-blocker={blocker.kind}>
              <p className="sw-eligibility__title">{message.title}</p>
              <p className="sw-eligibility__body">{message.body}</p>
              {message.help !== null ? (
                <Link className="sw-eligibility__help" href={message.help.href}>
                  {message.help.label}
                </Link>
              ) : null}
            </div>
          );
        })}
      </div>

      {blockedByWeek ? (
        <p className="sw-notice" role="note">
          Nothing has been uploaded. Come back when the week is up, or open your existing paper from{" "}
          <Link href="/me">your dashboard</Link>.
        </p>
      ) : (
        <>
          <div hidden={step !== "files"}>
            <FilesStep
              managerDeps={managerDeps}
              onFilesChange={setFiles}
              onContinue={() => setStep("details")}
            />
          </div>

          {step === "details" ? (
            <DetailsStep
              value={details}
              onChange={setDetails}
              onBack={() => setStep("files")}
              onContinue={() => setStep("authors")}
              categoryWarning={categoryWarning}
            />
          ) : null}

          {step === "authors" ? (
            <AuthorsStep
              authors={authors}
              onChange={setAuthors}
              onBack={() => setStep("details")}
              onContinue={() => setStep("checks")}
              resolveAuthor={resolveAuthor}
            />
          ) : null}

          {step === "checks" ? (
            <ChecksStep
              checksFor={checksFor}
              fetchChecks={fetchChecks}
              pollMs={checksPollMs}
              files={files}
              onBack={() => setStep("authors")}
              onContinue={() => setStep("sign")}
              onFixFiles={() => setStep("files")}
              onFixDetails={() => setStep("details")}
            />
          ) : null}

          {step === "sign" ? (
            <SignStep
              files={files}
              details={details}
              authors={authors}
              submitterName={facts?.name ?? null}
              signRecord={signRecord}
              submitRecord={submitRecord}
              fetchConsents={fetchConsents}
              fetchChecks={fetchChecks}
              checksPollMs={checksPollMs}
              onBack={() => setStep("checks")}
              onSigned={() => setSubmitted(true)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
