"use client";

/**
 * One file in the list: its name, role, size, status, the two progress bars
 * (fingerprint and upload) and the actions that make sense for its state.
 *
 * Every control names its file in its accessible name ("Pause paper.pdf"),
 * because a screen-reader user lands on a button out of context.
 */

import type { ReactElement } from "react";

import { ROLE_LABELS, rolesFor, type FileRole } from "./file-roles";
import { shortCid } from "./fingerprint";
import {
  fingerprintPercent,
  fingerprintText,
  STATUS_LABELS,
  STATUS_TONES,
  uploadPercent,
  uploadText,
} from "./file-view";
import { StatusIcon } from "./icons";
import { formatBytes } from "./limits";
import type { FileEntry } from "./upload-manager";

export interface FileRowProps {
  entry: FileEntry;
  onRole: (id: string, role: FileRole) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}

function Meter({
  label,
  name,
  value,
  children,
}: {
  label: string;
  name: string;
  value: number;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div className="sw-meter">
      <span className="sw-meter__label">{label}</span>
      <progress className="sw-meter__bar" max={100} value={value} aria-label={`${label} progress for ${name}`} />
      <span className="sw-meter__text">{children}</span>
    </div>
  );
}

export function FileRow({ entry, onRole, onPause, onResume, onRetry, onRemove }: FileRowProps): ReactElement {
  const { id, name, status } = entry;
  const rejected = status === "rejected";

  return (
    <li className="sw-file" data-status={status}>
      <div className="sw-file__head">
        <span className="sw-file__name">{name}</span>
        <span className="sw-chip" data-tone={STATUS_TONES[status]}>
          <StatusIcon status={status} />
          {STATUS_LABELS[status]}
        </span>
      </div>

      <div className="sw-file__facts">
        <span>{formatBytes(entry.size)}</span>
        {rejected ? null : (
          <label className="sw-file__role">
            <span className="sw-sr-only">Role of {name}</span>
            <select value={entry.role} onChange={(event) => onRole(id, event.target.value as FileRole)}>
              {rolesFor(entry.file).map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {rejected ? (
        <p className="sw-file__note">{entry.rejection}</p>
      ) : (
        <div className="sw-file__meters">
          <Meter label="Fingerprint" name={name} value={fingerprintPercent(entry)}>
            {entry.fingerprint.status === "done" && entry.fingerprint.cid ? (
              <>
                <code className="sw-file__cid" title={entry.fingerprint.cid}>
                  {shortCid(entry.fingerprint.cid)}
                </code>
                {status === "complete" ? " · matches the copy on the node" : null}
              </>
            ) : (
              fingerprintText(entry)
            )}
          </Meter>
          <Meter label="Upload" name={name} value={uploadPercent(entry)}>
            {uploadText(entry)}
          </Meter>
        </div>
      )}

      {entry.resumed && status !== "complete" && !rejected ? (
        <p className="sw-file__note">Continuing an earlier upload of this file.</p>
      ) : null}
      {entry.failure ? <p className="sw-file__note sw-file__note--error">{entry.failure.message}</p> : null}

      <div className="sw-file__actions">
        {status === "queued" || status === "uploading" || status === "reconnecting" ? (
          <button type="button" className="sw-button sw-button--quiet" onClick={() => onPause(id)}>
            Pause{" "}
            <span className="sw-sr-only">{name}</span>
          </button>
        ) : null}
        {status === "paused" ? (
          <button type="button" className="sw-button sw-button--quiet" onClick={() => onResume(id)}>
            Resume{" "}
            <span className="sw-sr-only">{name}</span>
          </button>
        ) : null}
        {status === "failed" && entry.failure?.retryable ? (
          <button type="button" className="sw-button sw-button--quiet" onClick={() => onRetry(id)}>
            Retry{" "}
            <span className="sw-sr-only">{name}</span>
          </button>
        ) : null}
        <button type="button" className="sw-button sw-button--quiet" onClick={() => onRemove(id)}>
          {rejected ? "Dismiss" : "Remove"}{" "}
          <span className="sw-sr-only">{name}</span>
        </button>
      </div>
    </li>
  );
}
