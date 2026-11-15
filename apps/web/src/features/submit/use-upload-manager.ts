"use client";

/**
 * Binds an {@link UploadManager} to a component.
 *
 * Besides subscribing to the manager's state, it handles three things that
 * belong to the *page* rather than to any one upload:
 *
 * - **Coming back online** restarts the uploads that stopped for want of a
 *   connection, so the author does not have to press Retry on each.
 * - **Leaving mid-upload** asks the browser to confirm. Bytes already sent are
 *   kept, so adding the same file again later resumes it.
 * - **Missing the drop zone** would make the browser navigate to the dropped
 *   file and throw the page (and every running upload) away, so file drags
 *   anywhere else on the page are ignored.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import { hasActiveUploads, UploadManager, type FileEntry, type ManagerDeps } from "./upload-manager";

function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function useUploadManager(deps?: ManagerDeps): { manager: UploadManager; entries: readonly FileEntry[] } {
  const [manager] = useState(() => new UploadManager(deps));
  const entries = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);

  useEffect(() => {
    const onOnline = (): void => manager.resumeAfterReconnect();
    const ignoreStrayDrop = (event: DragEvent): void => {
      if (dragHasFiles(event)) {
        event.preventDefault();
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("dragover", ignoreStrayDrop);
    window.addEventListener("drop", ignoreStrayDrop);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("dragover", ignoreStrayDrop);
      window.removeEventListener("drop", ignoreStrayDrop);
      manager.stopAll();
    };
  }, [manager]);

  const active = hasActiveUploads(entries);
  useEffect(() => {
    if (!active) {
      return;
    }
    const confirmLeave = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmLeave);
    return () => window.removeEventListener("beforeunload", confirmLeave);
  }, [active]);

  return { manager, entries };
}
