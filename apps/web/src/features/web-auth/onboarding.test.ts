// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { MemoryTokenStorage, apiErrorFrom } from "../../lib/api";

import { isEd25519DidKey } from "./did-key";
import { fromBase64Url } from "./encoding";
import {
  GUARDIAN_COUNT,
  ONBOARDING_CATEGORY_CHOICES,
  ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY,
  GuardianSaveError,
  OnboardingError,
  ProfileSaveError,
  checkOrcidLink,
  completeOrcidLink,
  countCompletedSteps,
  emptyPersistedOnboarding,
  followCategories,
  followsEndpointUnavailable,
  guardianProblemsFromApiError,
  isGuardianSaveError,
  isOnboardingError,
  isProfileSaveError,
  loadPersistedOnboarding,
  loadProfile,
  normalizeCategory,
  onboardingStepCompletion,
  parseOrcidReturn,
  parseOrcidStart,
  profileProblemsFromApiError,
  profileShowsLinkedOrcid,
  saveGuardians,
  saveProfile,
  startOrcidLink,
  updatePersistedOnboarding,
  validateGuardians,
  validateProfile,
  type OnboardingClient,
  type OrcidCompleteClient,
} from "./onboarding";

// Canonical Ed25519 did:keys, generated the same way the API's tests
// generate theirs (nacl SigningKey → record-core's did_key helper).
const OWNER = "did:key:z6MkrQDrTkUp4gGH7aUiPNDDT2B2DzAssL2wib7awcqYzKqG";
const G1 = "did:key:z6MkmHq27QXR7YPRFhKZsCVfKBk5i855vPEuF7nfC7fALpih";
const G2 = "did:key:z6MkkCCsRVKCouTLfDzdH3irfi2mkRyQLxPHYhkcWYbFvhrm";
const G3 = "did:key:z6MkmHyqwywLHLJbfhudWDfonpRdQSzNzcRVjPDbHDijN5Yv";
const G4 = "did:key:z6MkkyvRXrgTtxx4V1xncehSAnT66FATqQtKXsKkEFrHQ26n";
const G5 = "did:key:z6MkfecoxWGf7w3UuW6NmoYSvUT9eERAgNUvKrDwTSgVHES7";
const G6 = "did:key:z6MkumbKX5ihxbcryNmmGzAWjjMfiMJzKRcdmyea8AKv6qS8";
const FIVE = [G1, G2, G3, G4, G5];

/** A client whose every call is a mock the test asserts on. */
function fakeClient(
  get: (path: string) => unknown = () => ({}),
  put: (path: string, body?: unknown) => unknown = () => ({}),
) {
  return {
    get: vi.fn(async (path: string) => get(path)),
    put: vi.fn(async (path: string, body?: unknown) => put(path, body)),
  } as unknown as OnboardingClient & {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };
}

describe("onboarding step model", () => {
  it("lists the steps in the order the design fixes", () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      "passkey",
      "profile",
      "orcid",
      "categories",
      "guardians",
    ]);
  });

  it("marks a step done only for what has actually happened", () => {
    expect(onboardingStepCompletion(emptyPersistedOnboarding(), true)).toEqual({
      passkey: true,
      profile: false,
      orcid: false,
      categories: false,
      guardians: false,
    });

    const persisted = {
      ...emptyPersistedOnboarding(),
      profileSavedAt: "2026-11-14T23:59:00Z",
      orcidLinkedAt: "2026-11-15T00:00:00Z",
      categories: ["cs.AI"],
      guardiansSavedAt: "2026-11-15T00:01:00Z",
      guardians: FIVE,
    };
    expect(onboardingStepCompletion(persisted, true)).toEqual({
      passkey: true,
      profile: true,
      orcid: true,
      categories: true,
      guardians: true,
    });
    expect(countCompletedSteps(onboardingStepCompletion(persisted, true))).toBe(5);
  });

  it("an ORCID round-trip that never confirmed does not complete the step", () => {
    const persisted = { ...emptyPersistedOnboarding(), orcidStartedAt: "2026-11-15T00:00:00Z" };
    expect(onboardingStepCompletion(persisted, true).orcid).toBe(false);
  });
});

describe("persisted onboarding progress", () => {
  it("round-trips through storage", () => {
    const storage = new MemoryTokenStorage();
    expect(loadPersistedOnboarding(storage)).toEqual(emptyPersistedOnboarding());

    const next = updatePersistedOnboarding(storage, {
      orcidStartedAt: "2026-11-15T00:00:00Z",
      categories: ["cs.AI", "cs.LG"],
      guardiansSavedAt: "2026-11-15T00:01:00Z",
      guardians: FIVE,
    });
    expect(loadPersistedOnboarding(storage)).toEqual(next);
    expect(next.categories).toEqual(["cs.AI", "cs.LG"]);
  });

  it("remembers why a link attempt failed so the checklist can explain it", () => {
    const storage = new MemoryTokenStorage();

    updatePersistedOnboarding(storage, {
      orcidStartedAt: "2026-11-15T00:00:00Z",
      orcidError: "This ORCID iD is already linked to an active DID.",
    });

    expect(loadPersistedOnboarding(storage).orcidError).toBe(
      "This ORCID iD is already linked to an active DID.",
    );
  });

  it("reads junk as nothing done", () => {
    const storage = new MemoryTokenStorage();
    storage.setItem(ONBOARDING_STORAGE_KEY, "{not json");
    expect(loadPersistedOnboarding(storage)).toEqual(emptyPersistedOnboarding());

    storage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ categories: "nope", orcidLinkedAt: 7, orcidError: 3 }),
    );
    const loaded = loadPersistedOnboarding(storage);
    expect(loaded.categories).toEqual([]);
    expect(loaded.orcidLinkedAt).toBeNull();
    expect(loaded.orcidError).toBeNull();
  });
});

describe("link ORCID", () => {
  const START_BODY = {
    authorize_url: "https://sandbox.orcid.org/oauth/authorize?client_id=x",
    authorization_url: "https://sandbox.orcid.org/oauth/authorize?client_id=x",
    url: "https://sandbox.orcid.org/oauth/authorize?client_id=x",
    auth_url: "https://sandbox.orcid.org/oauth/authorize?client_id=x",
    state: "eyJhbGciOiJIUzI1NiJ9.sig",
  };

  it("parses the authorize URL and state", () => {
    expect(parseOrcidStart(START_BODY)).toEqual({
      authorizeUrl: "https://sandbox.orcid.org/oauth/authorize?client_id=x",
      state: "eyJhbGciOiJIUzI1NiJ9.sig",
    });
  });

  it("accepts the URL under any of the endpoint's spellings", () => {
    expect(parseOrcidStart({ url: "https://orcid.example/authorize" }).authorizeUrl).toBe(
      "https://orcid.example/authorize",
    );
    expect(parseOrcidStart({ auth_url: "https://orcid.example/authorize" }).authorizeUrl).toBe(
      "https://orcid.example/authorize",
    );
  });

  it("refuses bodies without a usable http(s) URL", () => {
    expect(() => parseOrcidStart({})).toThrow(OnboardingError);
    expect(() => parseOrcidStart({ authorize_url: "javascript:alert(1)" })).toThrow(
      OnboardingError,
    );
    expect(() => parseOrcidStart({ authorize_url: "not a url" })).toThrow(OnboardingError);
    expect(() => parseOrcidStart("https://orcid.example/authorize")).toThrow(OnboardingError);
    try {
      parseOrcidStart({});
      expect.unreachable("parseOrcidStart should have thrown");
    } catch (error) {
      expect(isOnboardingError(error)).toBe(true);
      expect((error as OnboardingError).code).toBe("invalid-response");
    }
  });

  it("asks the API where to send the browser", async () => {
    const client = fakeClient(() => START_BODY);
    await expect(startOrcidLink(client)).resolves.toEqual({
      authorizeUrl: START_BODY.authorize_url,
      state: START_BODY.state,
    });
    expect(client.get).toHaveBeenCalledWith("/auth/orcid/start");
  });

  it("sees a linked iD in a profile under any spelling", () => {
    expect(profileShowsLinkedOrcid({ orcid: "0000-0002-1825-0097" })).toBe(true);
    expect(profileShowsLinkedOrcid({ orcid_id: "0000-0002-1825-0097" })).toBe(true);
    expect(profileShowsLinkedOrcid({ orcidId: "0000-0002-1825-0097" })).toBe(true);
    expect(profileShowsLinkedOrcid({ orcid: "" })).toBe(false);
    expect(profileShowsLinkedOrcid({ orcid: null })).toBe(false);
    expect(profileShowsLinkedOrcid({ name: "Mei" })).toBe(false);
    expect(profileShowsLinkedOrcid(null)).toBe(false);
  });

  it("treats a profile probe that fails as 'cannot tell'", async () => {
    const client = {
      get: vi.fn(async () => {
        throw apiErrorFrom(404, { detail: "Not Found" });
      }),
      put: vi.fn(async () => undefined),
    } as unknown as OnboardingClient;
    await expect(checkOrcidLink(client, OWNER)).resolves.toBe(false);
    expect(client.get).toHaveBeenCalledWith(`/profiles/${encodeURIComponent(OWNER)}`);
  });
});

describe("finish linking ORCID (the page ORCID redirects back to)", () => {
  const CREDENTIAL = {
    type: ["VerifiableCredential", "OrcidOwnershipCredential"],
    credentialSubject: { id: OWNER, orcid: "0000-0002-1825-0097" },
  };

  function postClient(handler: () => unknown = () => CREDENTIAL): OrcidCompleteClient {
    return { post: vi.fn(async () => handler()) } as unknown as OrcidCompleteClient;
  }

  it("reads the code and state ORCID put on the redirect", () => {
    expect(parseOrcidReturn("?code=abc123&state=eyJ.s.ig")).toEqual({
      kind: "ready",
      code: "abc123",
      state: "eyJ.s.ig",
    });
    // A bare query string (no leading ?) is read the same way.
    expect(parseOrcidReturn("code=abc123&state=s")).toMatchObject({ kind: "ready" });
  });

  it("reports the user cancelling at ORCID without calling anything", () => {
    expect(
      parseOrcidReturn("?error=access_denied&error_description=User+denied+access&state=s"),
    ).toEqual({ kind: "denied", error: "access_denied", description: "User denied access" });
  });

  it.each(["", "?", "?code=abc", "?state=s", "?code=&state=s", "?code=abc&state="])(
    "treats %j as an incomplete return",
    (search) => {
      expect(parseOrcidReturn(search)).toEqual({ kind: "missing" });
    },
  );

  it("POSTs the code and state to the authenticated complete endpoint", async () => {
    const client = postClient();

    await expect(completeOrcidLink(client, { code: "c", state: "s" })).resolves.toEqual({
      orcid: "0000-0002-1825-0097",
    });

    // The shared client attaches the signed-in user's bearer token; the body
    // carries only what ORCID returned -- never a DID the caller could choose.
    expect(client.post).toHaveBeenCalledWith("/auth/orcid/complete", { code: "c", state: "s" });
  });

  it("does not mind a response without the iD in it", async () => {
    await expect(
      completeOrcidLink(postClient(() => ({})), { code: "c", state: "s" }),
    ).resolves.toEqual({ orcid: null });
  });

  it("lets the API's problem through untouched (403 mismatch, 401, 409, ...)", async () => {
    const mismatch = apiErrorFrom(403, {
      type: "urn:scholium:problem:orcid-state-principal-mismatch",
      detail: "This ORCID sign-in was started by a different account.",
    });
    const client = postClient(() => {
      throw mismatch;
    });

    await expect(completeOrcidLink(client, { code: "c", state: "s" })).rejects.toBe(mismatch);
  });
});

describe("pick categories to follow", () => {
  it("normalises typed-in categories", () => {
    expect(normalizeCategory("cs.AI")).toBe("cs.AI");
    expect(normalizeCategory("  math.CO ")).toBe("math.CO");
    expect(normalizeCategory("physics.soc-ph")).toBe("physics.soc-ph");
    expect(normalizeCategory("cs.ai")).toBe("cs.ai");
    expect(normalizeCategory("Categories")).toBeNull();
    expect(normalizeCategory("cs")).toBeNull();
    expect(normalizeCategory("cs.AI/../../admin")).toBeNull();
    expect(normalizeCategory("cs.AI papers")).toBeNull();
    expect(normalizeCategory("")).toBeNull();
  });

  it("offers preset choices that are all valid", () => {
    for (const choice of ONBOARDING_CATEGORY_CHOICES) {
      expect(normalizeCategory(choice)).toBe(choice);
    }
  });

  it("follows every pick on the account", async () => {
    const client = fakeClient();
    const result = await followCategories(client, ["cs.AI", " cs.LG ", "cs.AI"]);
    expect(result).toEqual({ categories: ["cs.AI", "cs.LG"], savedToAccount: true });
    expect(client.put.mock.calls.map(([path]) => path)).toEqual([
      "/me/follows/cs.AI",
      "/me/follows/cs.LG",
    ]);
  });

  it("keeps the picks on this device when following is not there yet", async () => {
    const client = fakeClient(undefined, () => {
      throw apiErrorFrom(404, { detail: "Not Found" });
    });
    const result = await followCategories(client, ["cs.AI", "cs.LG"]);
    expect(result.savedToAccount).toBe(false);
    expect(result.categories).toEqual(["cs.AI", "cs.LG"]);
    // The first "not available" answer stops the sync; the missing endpoint
    // is not hammered once per pick.
    expect(client.put).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty or invalid pick without calling the API", async () => {
    const client = fakeClient();
    await expect(followCategories(client, [])).rejects.toMatchObject({
      code: "invalid-category",
    });
    await expect(followCategories(client, ["not a category"])).rejects.toBeInstanceOf(
      OnboardingError,
    );
    expect(client.put).not.toHaveBeenCalled();
  });

  it("surfaces a real failure from following", async () => {
    const client = fakeClient(undefined, () => {
      throw apiErrorFrom(401, { detail: "Not authenticated" });
    });
    await expect(followCategories(client, ["cs.AI"])).rejects.toMatchObject({ status: 401 });
  });

  it("recognises exactly the 'not available' statuses", () => {
    for (const status of [404, 405, 501]) {
      expect(followsEndpointUnavailable(apiErrorFrom(status, {}))).toBe(true);
    }
    for (const status of [400, 401, 409, 422, 500, 503]) {
      expect(followsEndpointUnavailable(apiErrorFrom(status, {}))).toBe(false);
    }
    expect(followsEndpointUnavailable(new Error("offline"))).toBe(false);
  });
});

describe("set recovery guardians", () => {
  it("accepts the canonical DIDs the rest of the project uses", () => {
    for (const did of [OWNER, ...FIVE]) {
      expect(isEd25519DidKey(did)).toBe(true);
    }
  });

  it("requires exactly five", () => {
    expect(validateGuardians(OWNER, [])).toEqual([
      { index: null, message: `Enter exactly ${GUARDIAN_COUNT} guardian DIDs — you have 0.` },
    ]);
    expect(validateGuardians(OWNER, FIVE.slice(0, 4))[0].index).toBeNull();
  });

  it("reports every faulty input, not just the first", () => {
    const problems = validateGuardians(OWNER, ["", "did:key:not-a-key", G1, OWNER, G1]);
    expect(problems.map((problem) => problem.index)).toEqual([0, 1, 3, 4]);
    expect(problems[1].message).toContain("did:key:z6Mk");
    expect(problems[2]).toMatchObject({ index: 3 });
  });

  it("trims before checking", () => {
    expect(validateGuardians(OWNER, FIVE.map((did) => `  ${did}  `))).toEqual([]);
  });

  it("accepts a valid list", () => {
    expect(validateGuardians(OWNER, FIVE)).toEqual([]);
    expect(validateGuardians(null, FIVE)).toEqual([]);
  });

  it("saves the list and returns it as the server saved it", async () => {
    const client = fakeClient(undefined, () => ({ guardians: FIVE }));
    await expect(saveGuardians(client, OWNER, FIVE)).resolves.toEqual(FIVE);
    expect(client.put).toHaveBeenCalledWith("/me/guardians", { guardians: FIVE });
  });

  it("falls back to the sent list when the reply is bare", async () => {
    const client = fakeClient(undefined, () => undefined);
    await expect(saveGuardians(client, OWNER, FIVE)).resolves.toEqual(FIVE);
  });

  it("sends no signature on the first save, which the token alone may make", async () => {
    const client = fakeClient(undefined, () => ({ guardians: FIVE }));
    await saveGuardians(client, OWNER, FIVE);
    expect(client.put).toHaveBeenCalledWith("/me/guardians", { guardians: FIVE });
    const body = client.put.mock.calls[0][1] as Record<string, unknown>;
    expect("signature" in body).toBe(false);
  });

  it("signs a replacement over the preimage the API verifies", async () => {
    // A real Ed25519 key stands in for the device key behind the passkey.
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const signedWith: Uint8Array[] = [];
    const signer = {
      async signWithPasskey(data: Uint8Array) {
        signedWith.push(data);
        const message = new Uint8Array(data);
        return new Uint8Array(
          await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message.buffer),
        );
      },
    };
    const replaced = [G6, G2, G3, G4, G5];
    const client = fakeClient(undefined, () => ({ guardians: replaced }));

    await expect(saveGuardians(client, OWNER, replaced, { signer })).resolves.toEqual(replaced);

    // Exactly the canonical preimage the API accepts: compact, key-sorted JSON
    // binding the account DID and the ordered guardian list.
    const preimage = new TextEncoder().encode(
      `{"did":"${OWNER}","guardians":${JSON.stringify(replaced)}}`,
    );
    expect(signedWith).toEqual([preimage]);

    const body = client.put.mock.calls[0][1] as { guardians: string[]; signature?: string };
    expect(body.guardians).toEqual(replaced);
    expect(typeof body.signature).toBe("string");
    await expect(
      crypto.subtle.verify(
        { name: "Ed25519" },
        pair.publicKey,
        fromBase64Url(body.signature ?? ""),
        preimage.buffer as ArrayBuffer,
      ),
    ).resolves.toBe(true);
  });

  it("saves nothing when the passkey prompt is dismissed", async () => {
    const dismissed = new Error("The passkey prompt was dismissed.");
    const client = fakeClient();
    const signer = {
      async signWithPasskey(): Promise<Uint8Array> {
        throw dismissed;
      },
    };

    await expect(saveGuardians(client, OWNER, FIVE, { signer })).rejects.toBe(dismissed);
    expect(client.put).not.toHaveBeenCalled();
  });

  it("does not sign for a DID it does not know", async () => {
    const client = fakeClient();
    const signer = { signWithPasskey: vi.fn(async () => new Uint8Array(64)) };

    await expect(saveGuardians(client, null, FIVE, { signer })).rejects.toBeInstanceOf(
      GuardianSaveError,
    );
    expect(signer.signWithPasskey).not.toHaveBeenCalled();
    expect(client.put).not.toHaveBeenCalled();
  });

  it("never sends a list the browser itself rejects", async () => {
    const client = fakeClient();
    const values = [G1, G1, G2, G3, G4];
    await expect(saveGuardians(client, OWNER, values)).rejects.toBeInstanceOf(GuardianSaveError);
    const error = await saveGuardians(client, OWNER, values).catch((failure) => failure);
    expect(isGuardianSaveError(error)).toBe(true);
    expect(error.problems.map((problem: { index: number | null }) => problem.index)).toEqual([1]);
    expect(client.put).not.toHaveBeenCalled();
  });

  it("maps the API's 422 problem details back onto the inputs", () => {
    const error = apiErrorFrom(
      422,
      {
        type: "urn:scholium:problem:invalid-guardians",
        title: "Unprocessable Content",
        detail: "The guardian list is not valid.",
        errors: [
          { loc: ["body", "guardians", 0], msg: "Guardian 0 is not a canonical did:key.", type: "invalid_did" },
          { loc: ["body", "guardians"], msg: "Exactly 5 guardians are required, got 4.", type: "guardian_count" },
        ],
      },
    );
    const problems = guardianProblemsFromApiError(error);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toEqual({
      index: 0,
      message: "Guardian 0 is not a canonical did:key.",
    });
    expect(problems[1].index).toBeNull();
  });

  it("finds the input index in dotted field paths too", () => {
    const error = apiErrorFrom(422, {
      detail: "The guardian list is not valid.",
      errors: [{ field: "body.guardians.3", message: "Guardian 3 repeats guardian 1." }],
    });
    expect(guardianProblemsFromApiError(error)).toEqual([
      { index: 3, message: "Guardian 3 repeats guardian 1." },
    ]);
  });

  it("a 422 without field errors becomes one list-level problem", () => {
    const error = apiErrorFrom(422, { detail: "The guardian list is not valid." });
    expect(guardianProblemsFromApiError(error)).toEqual([
      { index: null, message: "The guardian list is not valid." },
    ]);
  });

  it("turns the API's 422 into a GuardianSaveError and rethrows anything else", async () => {
    const rejected = apiErrorFrom(422, {
      detail: "The guardian list is not valid.",
      errors: [{ loc: ["body", "guardians", 2], msg: "Guardian 2 is your own DID." }],
    });
    const client = fakeClient(undefined, () => {
      throw rejected;
    });
    await expect(saveGuardians(client, OWNER, FIVE)).rejects.toBeInstanceOf(GuardianSaveError);

    const offline = apiErrorFrom(503, { detail: "unavailable" });
    const down = fakeClient(undefined, () => {
      throw offline;
    });
    await expect(saveGuardians(down, OWNER, FIVE)).rejects.toBe(offline);
  });
});

// ---------------------------------------------------------------------------
// Add your name (the erasable profile)
// ---------------------------------------------------------------------------

describe("add your name", () => {
  const PROFILE = {
    name: "Ada Lovelace",
    affiliation: "Analytical Engine Co.",
    email: "ada@example.org",
  };

  it("reads the owner's profile and says whether it already names them", async () => {
    const client = fakeClient(() => PROFILE);

    const loaded = await loadProfile(client, OWNER);

    expect(client.get).toHaveBeenCalledWith(`/profiles/${encodeURIComponent(OWNER)}`);
    expect(loaded).toMatchObject({ ...PROFILE, hasName: true });
  });

  it("treats a nameless or unreadable profile as nothing known", async () => {
    const nameless = await loadProfile(fakeClient(() => ({ name: "  ", affiliation: null })), OWNER);
    expect(nameless?.hasName).toBe(false);
    expect(nameless?.name).toBe("");

    const failing = fakeClient(() => {
      throw apiErrorFrom(404, { detail: "Not Found" });
    });
    await expect(loadProfile(failing, OWNER)).resolves.toBeNull();
  });

  it("requires a name and a usable email, and allows an empty affiliation", () => {
    expect(validateProfile({ name: "", affiliation: "", email: "" })).toEqual([
      { field: "name", message: expect.stringContaining("name") },
      { field: "email", message: expect.stringContaining("email") },
    ]);
    expect(validateProfile({ name: "Ada", affiliation: "", email: "not-an-email" })).toEqual([
      { field: "email", message: expect.any(String) },
    ]);
    expect(
      validateProfile({ name: "Ada", affiliation: "", email: "ada@example.org" }),
    ).toEqual([]);
  });

  it("saves the trimmed profile through PUT /v1/profiles/{did}", async () => {
    const client = fakeClient(undefined, () => ({ ...PROFILE, name: "Ada Lovelace" }));

    const saved = await saveProfile(client, OWNER, {
      name: "  Ada Lovelace ",
      affiliation: " Analytical Engine Co. ",
      email: " ada@example.org ",
    });

    expect(client.put).toHaveBeenCalledWith(`/profiles/${encodeURIComponent(OWNER)}`, PROFILE);
    expect(saved).toEqual(PROFILE);
  });

  it("refuses to send a profile the API would reject", async () => {
    const client = fakeClient();

    await expect(
      saveProfile(client, OWNER, { name: " ", affiliation: "", email: "ada@example.org" }),
    ).rejects.toBeInstanceOf(ProfileSaveError);
    expect(client.put).not.toHaveBeenCalled();
  });

  it("maps the API's 422 problem details back onto the inputs", async () => {
    const rejected = apiErrorFrom(422, {
      detail: "The profile is not valid.",
      errors: [
        { loc: ["body", "email"], msg: "must be a valid email address" },
        { loc: ["body", "name"], msg: "must not be blank" },
      ],
    });
    const client = fakeClient(undefined, () => {
      throw rejected;
    });

    const failure = await saveProfile(client, OWNER, PROFILE).catch((error: unknown) => error);

    expect(isProfileSaveError(failure)).toBe(true);
    expect((failure as ProfileSaveError).problems).toEqual([
      { field: "email", message: "must be a valid email address" },
      { field: "name", message: "must not be blank" },
    ]);
  });

  it("turns a 422 without field errors into one form-level problem", () => {
    const error = apiErrorFrom(422, { detail: "The profile is not valid." });
    expect(profileProblemsFromApiError(error)).toEqual([
      { field: null, message: "The profile is not valid." },
    ]);
  });

  it("rethrows anything that is not a validation failure", async () => {
    const offline = apiErrorFrom(503, { detail: "unavailable" });
    const client = fakeClient(undefined, () => {
      throw offline;
    });

    await expect(saveProfile(client, OWNER, PROFILE)).rejects.toBe(offline);
  });
});
