"use client";

/**
 * The DID of the person building the submission: the `did:key` derived from
 * this device's signing key (`web-auth`). Reading it never prompts for the
 * passkey. With no key on the device it stays `null`, and the Authors step says
 * so instead of listing an author nobody can name.
 */

import { useEffect, useState } from "react";

import { deviceKey } from "../web-auth";

/** `override` wins when given (a `null` override means "no DID"); `undefined` reads the device key. */
export function useSubmitterDid(override?: string | null): string | null {
  const [detected, setDetected] = useState<string | null>(null);

  useEffect(() => {
    if (override !== undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        if (await deviceKey.exists()) {
          const did = await deviceKey.didKey();
          if (!cancelled) {
            setDetected(did);
          }
        }
      } catch {
        // No readable key (private browsing, blocked storage): same as no key.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [override]);

  return override === undefined ? detected : override;
}
