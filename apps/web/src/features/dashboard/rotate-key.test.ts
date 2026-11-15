import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { DeviceKeyError, PasskeyCancelledError, type SignedRecord } from "../web-auth";

import {
  KEY_ROTATION_RECORD_TYPE,
  ROTATION_REASON_MAX_LENGTH,
  RotationError,
  TERMINAL_ROTATION_CODES,
  describeRotationError,
  isRotationError,
  rotateKey,
  type RotateKeyInput,
  type RotationErrorCode,
  type RotationSeams,
} from "./rotate-key";

const OLD_KEY = "did:key:z6MkOldKeyOldKeyOldKeyOldKeyOldKeyOldKeyOldKey1";
const NEW_KEY = "did:key:z6MkNewKeyNewKeyNewKeyNewKeyNewKeyNewKeyNewKe2";
const NOW = Date.UTC(2026, 10, 14, 5, 33, 7, 412);

function signedRecord(body: Record<string, unknown>, prev: string | null): SignedRecord {
  return {
    v: 1,
    type: KEY_ROTATION_RECORD_TYPE,
    id: "bafy-rotation-record",
    author: OLD_KEY,
    created: "2026-11-14T05:33:07Z",
    prev,
    body,
    proofs: [],
    sig: "sig",
  };
}

/** Seams that record the order things happen in, so the order can be asserted. */
function harness(overrides: Partial<RotationSeams> & { install?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const install = vi.fn(async () => {
    calls.push("install");
    await overrides.install?.();
  });
  const seams: RotationSeams = {
    createReplacement: vi.fn(async () => {
      calls.push("createReplacement");
      return { did: NEW_KEY, install };
    }),
    sign: vi.fn(async (_type, body, prev) => {
      calls.push("sign");
      return signedRecord(body, prev);
    }),
    submit: vi.fn(async () => {
      calls.push("submit");
      return { id: "bafy-rotation-record" };
    }),
    readActiveKey: vi.fn(async () => {
      calls.push("readActiveKey");
      return OLD_KEY;
    }),
    now: () => NOW,
    ...overrides,
  };
  return { seams, calls, install };
}

function input(seams: Partial<RotationSeams>, extra: Partial<RotateKeyInput> = {}): RotateKeyInput {
  return {
    accountDid: OLD_KEY,
    activeKey: OLD_KEY,
    deviceDid: OLD_KEY,
    prev: null,
    seams,
    ...extra,
  };
}

async function failure(promise: Promise<unknown>): Promise<RotationError> {
  try {
    await promise;
  } catch (error) {
    if (isRotationError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the rotation to fail");
}

describe("rotateKey", () => {
  it("creates the key, signs with the current key, submits, and only then installs", async () => {
    const { seams, calls, install } = harness();

    const result = await rotateKey(input(seams));

    expect(calls).toEqual(["createReplacement", "sign", "submit", "install"]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ recordId: "bafy-rotation-record", newKey: NEW_KEY });
  });

  it("signs a key.rotation naming the old and new keys and the moment it takes effect", async () => {
    const { seams } = harness();

    await rotateKey(input(seams));

    expect(seams.sign).toHaveBeenCalledWith(
      "key.rotation",
      { oldKey: OLD_KEY, newKey: NEW_KEY, effectiveAt: "2026-11-14T05:33:07Z" },
      null,
    );
  });

  it("submits exactly the record that was signed", async () => {
    const { seams } = harness();

    await rotateKey(input(seams));

    const [record] = (seams.submit as ReturnType<typeof vi.fn>).mock.calls[0] as [SignedRecord];
    expect(record.type).toBe("key.rotation");
    expect(record.body).toMatchObject({ oldKey: OLD_KEY, newKey: NEW_KEY });
  });

  it("chains a later rotation to the previous one", async () => {
    const { seams } = harness();

    await rotateKey(input(seams, { prev: "bafy-previous-rotation" }));

    expect((seams.sign as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toBe(
      "bafy-previous-rotation",
    );
  });

  it("records the reason, trimmed, and omits it when blank", async () => {
    const withReason = harness();
    await rotateKey(input(withReason.seams, { reason: "  new laptop  " }));
    expect((withReason.seams.sign as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      reason: "new laptop",
    });

    const blank = harness();
    await rotateKey(input(blank.seams, { reason: "   " }));
    expect((blank.seams.sign as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).not.toHaveProperty(
      "reason",
    );
  });

  it("cuts an over-long reason to the limit", async () => {
    const { seams } = harness();

    await rotateKey(input(seams, { reason: "x".repeat(ROTATION_REASON_MAX_LENGTH + 50) }));

    const body = (seams.sign as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { reason: string };
    expect(body.reason).toHaveLength(ROTATION_REASON_MAX_LENGTH);
  });
});

describe("rotateKey refuses before doing anything", () => {
  it("does not start when this device does not hold the active key", async () => {
    const { seams, calls } = harness();

    const error = await failure(rotateKey(input(seams, { deviceDid: NEW_KEY })));

    expect(error.code).toBe("not-active-key");
    expect(calls).toEqual([]);
  });
});

describe("rotateKey leaves the account alone when something fails before the server accepts", () => {
  it("reports a dismissed passkey while creating the key; nothing is signed or installed", async () => {
    const { seams, calls } = harness({
      createReplacement: async () => {
        throw new PasskeyCancelledError();
      },
    });

    const error = await failure(rotateKey(input(seams)));

    expect(error.code).toBe("cancelled");
    expect(calls).toEqual([]);
  });

  it("passes through a refusal to create a key it could not keep", async () => {
    const { seams, calls } = harness({
      createReplacement: async () => {
        throw new RotationError("unsupported", "This browser cannot keep a new key.");
      },
    });

    const error = await failure(rotateKey(input(seams)));

    expect(error.code).toBe("unsupported");
    expect(calls).toEqual([]);
  });

  it("reports any other failure to create the key", async () => {
    const { seams } = harness({
      createReplacement: async () => {
        throw new DeviceKeyError("passkey-failed", "The passkey did not verify you");
      },
    });

    const error = await failure(rotateKey(input(seams)));

    expect(error.code).toBe("replacement-failed");
    expect(error.message).toContain("The passkey did not verify you");
  });

  it("reports a dismissed passkey while signing; nothing is submitted or installed", async () => {
    const { seams, calls } = harness({
      sign: async () => {
        throw new PasskeyCancelledError();
      },
    });

    const error = await failure(rotateKey(input(seams)));

    expect(error.code).toBe("cancelled");
    expect(calls).toEqual(["createReplacement"]);
  });

  it("reports a signing failure; nothing is submitted or installed", async () => {
    const { seams, calls } = harness({
      sign: async () => {
        throw new Error("verify-core could not load");
      },
    });

    const error = await failure(rotateKey(input(seams)));

    expect(error.code).toBe("signing-failed");
    expect(calls).toEqual(["createReplacement"]);
  });

  it("never installs the new key when the server refuses the rotation", async () => {
    const { seams, calls, install } = harness({
      submit: async () => {
        throw new ApiError(401, { detail: "The signature does not match your active key." });
      },
    });

    const error = await failure(rotateKey(input(seams)));

    expect(error.code).toBe("rejected");
    expect(error.message).toBe("The signature does not match your active key.");
    expect(install).not.toHaveBeenCalled();
    // A refusal is an answer: there is nothing ambiguous to look up.
    expect(calls).not.toContain("readActiveKey");
  });
});

describe("rotateKey when the server cannot be reached", () => {
  const unreachable = async () => {
    throw new NetworkError("/v1/records");
  };

  it("checks which key is active, and stops when the rotation was not recorded", async () => {
    const { seams, calls, install } = harness({
      submit: unreachable,
      readActiveKey: async () => OLD_KEY,
    });

    const error = await failure(rotateKey(input(seams)));

    expect(error.code).toBe("unreachable");
    expect(calls).toEqual(["createReplacement", "sign"]);
    expect(install).not.toHaveBeenCalled();
  });

  it("installs the key when the rotation turns out to have landed with only the reply lost", async () => {
    const { seams, install } = harness({
      submit: unreachable,
      readActiveKey: async () => NEW_KEY,
    });

    const result = await rotateKey(input(seams));

    expect(install).toHaveBeenCalledTimes(1);
    expect(result.newKey).toBe(NEW_KEY);
  });

  it("asks about the account, not the device", async () => {
    const readActiveKey = vi.fn(async () => OLD_KEY);
    const { seams } = harness({ submit: unreachable, readActiveKey });

    await failure(rotateKey(input(seams, { accountDid: "did:key:z6MkTheAccount" })));

    expect(readActiveKey).toHaveBeenCalledWith("did:key:z6MkTheAccount");
  });

  it("says the outcome is unknown when the lookup fails too, and does not install", async () => {
    const { seams, install } = harness({
      submit: unreachable,
      readActiveKey: async () => {
        throw new NetworkError("/v1/did/x");
      },
    });

    const error = await failure(rotateKey(input(seams)));

    expect(error.code).toBe("unknown-outcome");
    expect(install).not.toHaveBeenCalled();
  });

  it("treats any non-API failure of the submit the same way", async () => {
    const { seams } = harness({
      submit: async () => {
        throw new TypeError("Failed to fetch");
      },
      readActiveKey: async () => OLD_KEY,
    });

    expect((await failure(rotateKey(input(seams)))).code).toBe("unreachable");
  });
});

describe("rotateKey when the new key cannot be saved", () => {
  it("reports that the account rotated but this device lost the key", async () => {
    const { seams, calls } = harness({
      install: async () => {
        throw new Error("QuotaExceededError");
      },
    });

    const error = await failure(rotateKey(input(seams)));

    expect(error.code).toBe("install-failed");
    expect(calls).toEqual(["createReplacement", "sign", "submit", "install"]);
    expect((error.cause as Error).message).toBe("QuotaExceededError");
  });
});

describe("TERMINAL_ROTATION_CODES", () => {
  it("lists exactly the outcomes after which the account may already have rotated", () => {
    expect([...TERMINAL_ROTATION_CODES].sort()).toEqual(["install-failed", "unknown-outcome"]);
  });
});

describe("describeRotationError", () => {
  const codes: RotationErrorCode[] = [
    "not-active-key",
    "unsupported",
    "cancelled",
    "replacement-failed",
    "signing-failed",
    "rejected",
    "unreachable",
    "unknown-outcome",
    "install-failed",
  ];

  it("says what happened to the account for every code", () => {
    for (const code of codes) {
      const text = describeRotationError(new RotationError(code, "Detail from the failure."));
      expect(text.length).toBeGreaterThan(20);
      expect(text).toMatch(/[.!?]$/);
    }
  });

  it("promises the current key still works only where that is true", () => {
    const stillWorks = (code: RotationErrorCode) =>
      /your current key still works/.test(
        describeRotationError(new RotationError(code, "Detail.")),
      );

    for (const code of ["cancelled", "unsupported", "replacement-failed", "signing-failed", "rejected", "unreachable"] as const) {
      expect(stillWorks(code)).toBe(true);
    }
    for (const code of TERMINAL_ROTATION_CODES) {
      expect(stillWorks(code)).toBe(false);
    }
  });

  it("points a stranded member at recovery", () => {
    expect(describeRotationError(new RotationError("install-failed", "x"))).toMatch(
      /recover your account/,
    );
    expect(describeRotationError(new RotationError("unknown-outcome", "x"))).toMatch(
      /recover your account/,
    );
  });

  it("quotes the server's reason with one closing full stop", () => {
    expect(describeRotationError(new RotationError("rejected", "Key retired"))).toContain(
      "Key retired. Nothing changed",
    );
    expect(describeRotationError(new RotationError("rejected", "Key retired."))).toContain(
      "Key retired. Nothing changed",
    );
  });

  it("handles an error that is not a RotationError", () => {
    expect(describeRotationError(new Error("boom"))).toBe("The key was not rotated: boom.");
    expect(describeRotationError("???")).toBe("The key was not rotated: an unknown error.");
  });
});
