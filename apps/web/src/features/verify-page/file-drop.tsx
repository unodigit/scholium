"use client";

/**
 * Where the reader drops the file to check: a drag-and-drop target that is
 * also a plain file picker.
 *
 * Dragging is a convenience, never the only way in: "Choose a file" opens the
 * browser's picker and is reachable by keyboard, and the hidden
 * `<input type="file">` is what screen readers and tests address.
 *
 * One file is checked at a time. If several are dropped the first is checked
 * and the reader is told so, rather than the rest being dropped silently. A
 * dropped folder cannot be read as one file, so it is named, not turned into
 * an empty file.
 */

import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

import { formatBytes } from "../submit/limits";

export interface FileDropProps {
  /** The file now being checked, so the zone can say what it holds. */
  current: { name: string; size: number } | null;
  /** Id of the paragraph that says the file stays on the device. */
  privacyId: string;
  onFile: (file: File) => void;
}

/** The files in a drop, and the names of any folders dropped with them. */
function collectDrop(transfer: DataTransfer): { files: File[]; folders: string[] } {
  const folders = new Set<string>();
  for (const item of Array.from(transfer.items ?? [])) {
    // Must run inside the drop handler: the entries are invalid afterwards.
    const entry = item.kind === "file" ? item.webkitGetAsEntry?.() : null;
    if (entry?.isDirectory) folders.add(entry.name);
  }
  const files = Array.from(transfer.files ?? []).filter((file) => !folders.has(file.name));
  return { files, folders: [...folders] };
}

export function FileDrop({ current, privacyId, onFile }: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave also fire for every child element, so count them.
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const carriesFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };

  const choose = (files: File[], folders: string[]) => {
    const [first] = files;
    if (first === undefined) {
      setNotice(
        folders.length > 0
          ? `${folders[0]} is a folder. Scholium checks one file at a time: drop a file from inside it.`
          : null,
      );
      return;
    }
    setNotice(
      files.length > 1
        ? `You dropped ${files.length} files. Checking ${first.name}; drop the others one at a time.`
        : null,
    );
    onFile(first);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    const { files, folders } = collectDrop(event.dataTransfer);
    if (files.length > 0 || folders.length > 0) choose(files, folders);
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Clear the input so choosing the same file again still fires `change`.
    event.target.value = "";
    if (files.length > 0) choose(files, []);
  };

  return (
    <div
      className="vp-drop"
      data-dragging={dragging ? "true" : undefined}
      data-has-file={current !== null ? "true" : undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* A paragraph, not a heading: a file's name is not the page's structure. */}
      <p className="vp-drop__title">{current === null ? "Drop a file here" : current.name}</p>
      <p className="vp-drop__prompt">
        {current === null
          ? "A paper, a figure, a dataset: any file you want to check."
          : `${formatBytes(current.size)}. Drop another file to check it instead.`}
      </p>
      <p className="vp-drop__privacy" id={privacyId}>
        Your file stays on this device. Scholium reads it here and compares its
        fingerprint; nothing is uploaded.
      </p>
      <button
        type="button"
        className="vp-button"
        aria-describedby={privacyId}
        onClick={() => inputRef.current?.click()}
      >
        {current === null ? "Choose a file" : "Choose a different file"}
      </button>
      <input
        ref={inputRef}
        className="vp-drop__input"
        type="file"
        hidden
        aria-label="File to check"
        onChange={onPick}
      />
      {notice !== null ? (
        <p className="vp-drop__notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
