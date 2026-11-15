"use client";

/**
 * Whether the page is running JavaScript: `false` in the server's HTML and
 * while the browser hydrates it, `true` from then on.
 *
 * The Cite dialog and the Download menu use it to start as the plain links the
 * server sends (which work with no script, a failed script, or a crawler) and
 * to become a button and a menu once there is something to open them. It is
 * the same trick as the margin drawer's `enhanced` flag: because the first
 * client render matches the server's, hydration never sees a mismatch.
 */

import { useSyncExternalStore } from "react";

const subscribeNever = (): (() => void) => () => {};
const onClient = (): boolean => true;
const onServer = (): boolean => false;

export function useEnhanced(): boolean {
  return useSyncExternalStore(subscribeNever, onClient, onServer);
}
