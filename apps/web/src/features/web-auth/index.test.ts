// @vitest-environment node
import { describe, expect, it } from "vitest";

import * as webAuth from "./index";

describe("web-auth public surface", () => {
  it("exports the device-key API other features import", () => {
    for (const name of [
      "DeviceKeyManager",
      "createDeviceKeyManager",
      "deviceKey",
      "MemoryDeviceKeyStorage",
      "IndexedDbDeviceKeyStorage",
      "BrowserPasskeyProvider",
      "createBrowserPasskeyProvider",
      "didKeyFromEd25519PublicKey",
      "ed25519PublicKeyFromDidKey",
      "DeviceKeyError",
      "PasskeyCancelledError",
      "isEd25519Supported",
      "toBase64Url",
      "fromBase64Url",
      "signRecord",
      "SIGN_AND_SUBMIT_REASON",
      "RECORD_ENVELOPE_VERSION",
      "RecordSigningError",
      "isRecordSigningError",
      "signIn",
      "signInDestination",
      "safeRedirectPath",
      "SignInError",
      "describeSignInError",
      "ONBOARDING_PATH",
      "SIGNIN_PATH",
      "ONBOARDING_STEPS",
      "ONBOARDING_STORAGE_KEY",
      "GUARDIAN_COUNT",
      "OnboardingError",
      "GuardianSaveError",
      "startOrcidLink",
      "saveGuardians",
      "validateGuardians",
      "followCategories",
      "normalizeCategory",
      "loadPersistedOnboarding",
      "describeOnboardingError",
      "useOnboarding",
      "defaultOnboardingServices",
      "normalizeOrcid",
      "openRecoveryRequest",
      "fetchRecoveryStatus",
      "cancelRecoveryRequest",
      "approvalProgressText",
      "RECOVERY_STORAGE_KEY",
      "describeRecoveryError",
      "useRecover",
      "defaultRecoveryServices",
    ]) {
      expect(webAuth).toHaveProperty(name);
    }
  });

  it("builds the app-wide manager without touching browser globals on import", () => {
    expect(webAuth.deviceKey).toBeInstanceOf(webAuth.DeviceKeyManager);
    expect(webAuth.deviceKey.storageKind).toBe("indexeddb");
    expect(webAuth.deviceKey.summary()).toBeNull();
  });
});
