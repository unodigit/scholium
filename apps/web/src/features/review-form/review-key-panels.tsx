"use client";

/**
 * Carrying a review key between browsers: **Download review key** and
 * **Import review key**, each asking for a passphrase.
 *
 * The reveal of a sealed review needs the review key's seed and the content the
 * commitment covers, and both live in the browser that committed it. The file
 * these panels write and read carries them to another browser, so it is
 * encrypted with a passphrase the reviewer chooses (`passphrase-box.ts`:
 * PBKDF2-SHA256, then AES-GCM). Scholium never sees the passphrase and cannot
 * recover it: say so, and ask for it twice when it is chosen.
 *
 * Importing asks for the passphrase of the file chosen, then keeps the sealed
 * review and the key on this device the way a commit does, so the sealed card
 * can reveal it.
 */

import { useId, useRef, useState, type FormEvent } from "react";

import { Icon } from "../ui-kit/icons";
import { KeyFileError, type PassphraseBoxOptions } from "./passphrase-box";
import { paperKey } from "./my-reviews";
import {
  DOWNLOAD_REVIEW_KEY_LABEL,
  IMPORT_REVIEW_KEY_LABEL,
  decryptReviewKeyFile,
  encryptReviewKeyFile,
  loadReviewKey,
  saveReviewKey,
} from "./review-key";
import { saveSealedReview, type SealedReview } from "./sealed-review";

/** The shortest passphrase a new key file is encrypted with. */
export const MIN_PASSPHRASE_LENGTH = 8;

export const PASSPHRASE_LABEL = "Passphrase";
export const CONFIRM_PASSPHRASE_LABEL = "Confirm passphrase";
export const ENCRYPT_AND_DOWNLOAD_LABEL = "Encrypt and download";
export const DECRYPT_AND_IMPORT_LABEL = "Decrypt and import";
export const REVIEW_KEY_FILE_LABEL = "Review key file";

/** What is said beside the choice of a passphrase. */
export const PASSPHRASE_CHOICE_NOTE =
  "The file is encrypted with this passphrase. Scholium never sees it and cannot recover it: without it, the file cannot be opened.";

/** Hands a file's text to the browser to save; replaceable in tests. */
export type DownloadText = (filename: string, text: string) => void;

/** The seams a test replaces; the defaults are the browser's. */
export interface KeyFileSeams {
  /** Faster PBKDF2 (never below the minimum) or a stand-in random source. */
  readonly passphrase?: PassphraseBoxOptions;
  /** Where the encrypted file goes. */
  readonly download?: DownloadText;
}

/** Save `text` as a file named `filename`, through a link the browser follows. */
export const downloadTextFile: DownloadText = (filename, text) => {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

/** A file name for a paper's key file: no `:` or `/`, which some systems refuse. */
export function reviewKeyFilename(paperId: string): string {
  const safe = paperId.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return `scholium-review-key-${safe === "" ? "review" : safe}.json`;
}

function problemText(error: unknown, fallback: string): string {
  return error instanceof KeyFileError ? error.message : fallback;
}

function Problem({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="rf-error" role="alert">
      <Icon name="alert" className="rf-error-icon" />
      <span>{message}</span>
    </p>
  );
}

/**
 * **Download review key**: choose a passphrase, then get the encrypted file.
 *
 * Offered only where this browser holds the review key; one it does not hold
 * has nothing to write.
 */
export function DownloadReviewKey({
  sealed,
  seams = {},
}: {
  sealed: SealedReview;
  seams?: KeyFileSeams;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const close = (): void => {
    setOpen(false);
    setPassphrase("");
    setConfirmation("");
    setProblem(null);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setProblem(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    if (passphrase !== confirmation) {
      setProblem("The two passphrases are not the same.");
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const key = await loadReviewKey(sealed.paperId);
      if (key === null) {
        setProblem(
          "This browser no longer holds the review key, so there is nothing to export.",
        );
        return;
      }
      const text = await encryptReviewKeyFile(sealed, key, passphrase, seams.passphrase);
      (seams.download ?? downloadTextFile)(reviewKeyFilename(sealed.paperId), text);
      setSaved(true);
      close();
    } catch (thrown) {
      setProblem(problemText(thrown, "The review key file could not be written."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rf-review-key">
      {open ? (
        <form
          className="rf-key-panel"
          aria-label={DOWNLOAD_REVIEW_KEY_LABEL}
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <p className="rf-sealed-text">{PASSPHRASE_CHOICE_NOTE}</p>
          <div className="rf-field">
            <label className="rf-field-label" htmlFor={`${uid}-pass`}>
              {PASSPHRASE_LABEL}
            </label>
            <input
              id={`${uid}-pass`}
              className="rf-input"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.currentTarget.value)}
            />
          </div>
          <div className="rf-field">
            <label className="rf-field-label" htmlFor={`${uid}-confirm`}>
              {CONFIRM_PASSPHRASE_LABEL}
            </label>
            <input
              id={`${uid}-confirm`}
              className="rf-input"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.currentTarget.value)}
            />
          </div>
          {problem !== null ? <Problem id={`${uid}-problem`} message={problem} /> : null}
          <div className="rf-key-actions">
            <button
              type="submit"
              className="rf-button"
              disabled={busy}
              aria-busy={busy ? true : undefined}
            >
              {busy ? "Encrypting…" : ENCRYPT_AND_DOWNLOAD_LABEL}
            </button>
            <button type="button" className="rf-button rf-button--quiet" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="rf-button"
          onClick={() => {
            setSaved(false);
            setOpen(true);
          }}
        >
          {DOWNLOAD_REVIEW_KEY_LABEL}
        </button>
      )}
      {saved ? (
        <p className="rf-sealed-text" role="status">
          The review key file was saved. To use it in another browser you need the file and
          its passphrase.
        </p>
      ) : null}
    </div>
  );
}

/**
 * **Import review key**: choose a file, give its passphrase, and the sealed
 * review it carries is restored on this device.
 *
 * @param paperId The paper this page is about; a file for another paper is
 *   refused rather than opening another paper's review here.
 */
export function ImportReviewKey({
  paperId,
  onImported,
  seams = {},
}: {
  paperId?: string;
  onImported: (sealed: SealedReview) => void;
  seams?: KeyFileSeams;
}) {
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const cancel = (): void => {
    setFile(null);
    setPassphrase("");
    setProblem(null);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || file === null) return;
    setProblem(null);
    setBusy(true);
    try {
      const { sealed, key } = await decryptReviewKeyFile(
        await file.text(),
        passphrase,
        seams.passphrase,
      );
      if (
        paperId !== undefined &&
        paperKey(paperId) !== "" &&
        paperKey(sealed.paperId) !== paperKey(paperId)
      ) {
        setProblem("This review key file is for a different paper.");
        return;
      }
      saveSealedReview(sealed);
      await saveReviewKey(sealed.paperId, key);
      cancel();
      onImported(sealed);
    } catch (thrown) {
      setProblem(problemText(thrown, "That file could not be imported."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rf-review-key">
      <button
        type="button"
        className="rf-button"
        onClick={() => inputRef.current?.click()}
      >
        {IMPORT_REVIEW_KEY_LABEL}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        aria-label={REVIEW_KEY_FILE_LABEL}
        style={{ display: "none" }}
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          if (chosen !== undefined) {
            setFile(chosen);
            setPassphrase("");
            setProblem(null);
          }
          event.target.value = "";
        }}
      />
      {file !== null ? (
        <form
          className="rf-key-panel"
          aria-label={IMPORT_REVIEW_KEY_LABEL}
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <p className="rf-sealed-text">
            {file.name} is encrypted. Enter the passphrase you chose when you downloaded it.
          </p>
          <div className="rf-field">
            <label className="rf-field-label" htmlFor={`${uid}-pass`}>
              {PASSPHRASE_LABEL}
            </label>
            <input
              id={`${uid}-pass`}
              className="rf-input"
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(event) => setPassphrase(event.currentTarget.value)}
            />
          </div>
          {problem !== null ? <Problem id={`${uid}-problem`} message={problem} /> : null}
          <div className="rf-key-actions">
            <button
              type="submit"
              className="rf-button"
              disabled={busy}
              aria-busy={busy ? true : undefined}
            >
              {busy ? "Decrypting…" : DECRYPT_AND_IMPORT_LABEL}
            </button>
            <button type="button" className="rf-button rf-button--quiet" onClick={cancel}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
