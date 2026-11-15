"use client";

/**
 * A drag-and-drop target that is also a plain file picker.
 *
 * Dragging is a convenience, never the only way in: the "Choose files" button
 * opens the browser's picker and is reachable by keyboard, and the zone's hidden
 * `<input type="file">` is what screen readers and tests address.
 *
 * Folders cannot be uploaded as folders, so a dropped directory is reported
 * back by name (via `onFiles`'s second argument) rather than being silently
 * turned into an empty file.
 */

import { useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from "react";

import { UploadFileIcon } from "./icons";

export interface DropZoneProps {
  /** Heading of the zone, e.g. "Paper". */
  title: string;
  /** What belongs here, e.g. "Drop a PDF or LaTeX source here". */
  prompt: string;
  /** The size limit, stated where the file is dropped. */
  limit: string;
  /** Accessible name of the hidden file input. */
  inputLabel: string;
  /** The picker's `accept` filter (a hint only: every file is validated after it is chosen). */
  accept?: string;
  onFiles: (files: File[], folders: string[]) => void;
}

/** The files in a drop, and the names of any folders dropped with them. */
function collectDrop(transfer: DataTransfer): { files: File[]; folders: string[] } {
  const folders = new Set<string>();
  for (const item of Array.from(transfer.items ?? [])) {
    // Must run inside the drop handler: the entries are invalid afterwards.
    const entry = item.kind === "file" ? item.webkitGetAsEntry?.() : null;
    if (entry?.isDirectory) {
      folders.add(entry.name);
    }
  }
  const files = Array.from(transfer.files ?? []).filter((file) => !folders.has(file.name));
  return { files, folders: [...folders] };
}

export function DropZone({ title, prompt, limit, inputLabel, accept, onFiles }: DropZoneProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave also fire for every child element, so count them.
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (carriesFiles(event)) {
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    }
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (carriesFiles(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const onDragLeave = (): void => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) {
      setDragging(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    const { files, folders } = collectDrop(event.dataTransfer);
    if (files.length > 0 || folders.length > 0) {
      onFiles(files, folders);
    }
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    // Clear the input so choosing the same file again still fires `change`.
    event.target.value = "";
    if (files.length > 0) {
      onFiles(files, []);
    }
  };

  return (
    <div
      className="sw-drop"
      data-dragging={dragging ? "true" : undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <UploadFileIcon />
      <h3 className="sw-drop__title">{title}</h3>
      <p className="sw-drop__prompt">{prompt}</p>
      <p className="sw-drop__limit">{limit}</p>
      <button type="button" className="sw-button" onClick={() => inputRef.current?.click()}>
        Choose files <span className="sw-sr-only">for {title.toLowerCase()}</span>
      </button>
      <input
        ref={inputRef}
        className="sw-drop__input"
        type="file"
        multiple
        hidden
        accept={accept}
        aria-label={inputLabel}
        onChange={onPick}
      />
    </div>
  );
}
