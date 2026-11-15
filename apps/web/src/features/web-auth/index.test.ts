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
