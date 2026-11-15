"use client";

/**
 * Who is looking: the `did:key` of this device's signing key, and whether the
 * device has been asked yet.
 *
 * `useSubmitterDid` answers `null` both while it is still reading the key store
 * and when there is no key, which is fine for a form that fills in later. The
 * consent page has to say something different in each case ("checking" versus
 * "this device has no key"), so it needs the phase too. Reading the DID never
 * prompts for the passkey.
 */

import { useEffect, useState } from "react";

import { deviceKey } from "../web-auth";
import type { DeviceIdentity } from "./consent-version";

/** `override` wins when given (a `null` override means "no key"); `undefined` reads the device. */
export function useDeviceDid(override?: string | null): DeviceIdentity {
  const [detected, setDetected] = useState<DeviceIdentity>({ phase: "checking", did: null });

  useEffect(() => {
    if (override !== undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      let did: string | null = null;
      try {
        if (await deviceKey.exists()) {
          did = await deviceKey.didKey();
        }
      } catch {
        // No readable key (private browsing, blocked storage): same as no key.
      }
      if (!cancelled) {
        setDetected({ phase: "ready", did });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [override]);

  return override === undefined ? detected : { phase: "ready", did: override };
}
