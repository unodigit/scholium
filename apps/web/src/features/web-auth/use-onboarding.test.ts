// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryTokenStorage, apiErrorFrom, NetworkError } from "../../lib/api";

import { ONBOARDING_STORAGE_KEY } from "./onboarding";
import {
  CATEGORY_INVALID_MESSAGE,
  ONBOARDING_SESSION_EXPIRED_MESSAGE,
} from "./onboarding-messages";
import { useOnboarding, type OnboardingServices } from "./use-onboarding";

const OWNER = "did:key:z6MkrQDrTkUp4gGH7aUiPNDDT2B2DzAssL2wib7awcqYzKqG";
const G1 = "did:key:z6MkmHq27QXR7YPRFhKZsCVfKBk5i855vPEuF7nfC7fALpih";
const G2 = "did:key:z6MkkCCsRVKCouTLfDzdH3irfi2mkRyQLxPHYhkcWYbFvhrm";
const G3 = "did:key:z6MkmHyqwywLHLJbfhudWDfonpRdQSzNzcRVjPDbHDijN5Yv";
const G4 = "did:key:z6MkkyvRXrgTtxx4V1xncehSAnT66FATqQtKXsKkEFrHQ26n";
const G5 = "did:key:z6MkfecoxWGf7w3UuW6NmoYSvUT9eERAgNUvKrDwTSgVHES7";
const FIVE = [G1, G2, G3, G4, G5];

const ORCID_START_BODY = {
  authorize_url: "https://sandbox.orcid.org/oauth/authorize?client_id=x&state=s",
  state: "s",
};

/** Services with every collaborator mocked; the storage is real (in memory). */
function makeServices(overrides: Partial<OnboardingServices> = {}) {
  const storage = new MemoryTokenStorage();
  const services: OnboardingServices = {
    deviceKey: {
      exists: vi.fn(async () => true),
      didKey: vi.fn(async () => OWNER),
    },
    client: {
      get: vi.fn(async () => ({})),
      put: vi.fn(async () => undefined),
    } as unknown as OnboardingServices["client"],
    storage,
    openExternalUrl: vi.fn(),
    ...overrides,
  };
  return {
    services,
    storage,
    get: services.client.get as ReturnType<typeof vi.fn>,
    put: services.client.put as ReturnType<typeof vi.fn>,
    openExternalUrl: services.openExternalUrl as ReturnType<typeof vi.fn>,
  };
}

/** Render the hook and wait for the mount pass to finish. */
async function renderOnboarding(services: OnboardingServices) {
  const rendered = renderHook(() => useOnboarding({ services }));
  await waitFor(() => expect(rendered.result.current.ready).toBe(true));
  return rendered;
}

function seed(storage: MemoryTokenStorage, progress: Record<string, unknown>): void {
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(progress));
}

afterEach(() => {
  cleanup();
});

describe("useOnboarding", () => {
  describe("initial state", () => {
    it("shows the passkey step done and the rest to do", async () => {
      const { services } = makeServices();
      const { result } = await renderOnboarding(services);

      expect(result.current.passkeyReady).toBe(true);
      expect(result.current.did).toBe(OWNER);
      expect(result.current.steps).toEqual([
        { id: "passkey", done: true },
        { id: "orcid", done: false },
        { id: "categories", done: false },
        { id: "guardians", done: false },
      ]);
      expect(result.current.completedCount).toBe(1);
      expect(result.current.canFinish).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("marks the passkey step to do when this device has no key", async () => {
      const { services } = makeServices({
        deviceKey: { exists: vi.fn(async () => false), didKey: vi.fn(async () => OWNER) },
      });
      const { result } = await renderOnboarding(services);

      expect(result.current.passkeyReady).toBe(false);
      expect(result.current.did).toBeNull();
      expect(result.current.steps[0].done).toBe(false);
      expect(result.current.canFinish).toBe(false);
    });

    it("restores progress saved on an earlier visit", async () => {
      const { services, storage } = makeServices();
      seed(storage, {
        orcidLinkedAt: "2026-11-15T00:00:00Z",
        categories: ["cs.AI"],
        guardiansSavedAt: "2026-11-15T00:01:00Z",
        guardians: FIVE,
      });
      const { result } = await renderOnboarding(services);

      expect(result.current.steps.every((step) => step.done)).toBe(true);
      expect(result.current.completedCount).toBe(4);
      expect(result.current.canFinish).toBe(true);
    });

    it("renders the same empty checklist on the server and before the mount pass", () => {
      // The page is server-rendered, where browser storage is empty. Reading
      // it in the initial render would make the client's first render differ
      // from the server's markup; progress is loaded by the effect instead.
      const { services, storage } = makeServices();
      seed(storage, {
        categories: ["cs.AI"],
        guardiansSavedAt: "2026-11-15T00:01:00Z",
        guardians: FIVE,
      });

      const { result } = renderHook(() => useOnboarding({ services }));

      expect(result.current.ready).toBe(false);
      expect(result.current.completedCount).toBe(0);
      expect(result.current.steps.every((step) => !step.done)).toBe(true);
    });
  });

  describe("link ORCID", () => {
    it("sends the browser to the authorize URL and remembers the attempt", async () => {
      const { services, storage, get, openExternalUrl } = makeServices({
        client: {
          get: vi.fn(async () => ORCID_START_BODY),
          put: vi.fn(async () => undefined),
        } as unknown as OnboardingServices["client"],
      });
      const { result } = await renderOnboarding(services);

      await act(async () => {
        await result.current.linkOrcid();
      });

      expect(get).toHaveBeenCalledWith("/auth/orcid/start");
      expect(openExternalUrl).toHaveBeenCalledWith(ORCID_START_BODY.authorize_url);
      expect(result.current.orcid.started).toBe(true);
      const stored = JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}");
      expect(stored.orcidStartedAt).toEqual(expect.any(String));
    });

    it("keeps the page (with a message) when the start call fails", async () => {
      const { services, openExternalUrl } = makeServices({
        client: {
          get: vi.fn(async () => {
            throw apiErrorFrom(503, { detail: "ORCID sign-in is not configured." });
          }),
          put: vi.fn(async () => undefined),
        } as unknown as OnboardingServices["client"],
      });
      const { result } = await renderOnboarding(services);

      await act(async () => {
        await result.current.linkOrcid();
      });

      expect(openExternalUrl).not.toHaveBeenCalled();
      expect(result.current.orcid.started).toBe(false);
      expect(result.current.error).toBe(
        "Scholium is having trouble right now. Please try again in a moment.",
      );
    });

    it("flips to linked after the round-trip, once the profile shows the iD", async () => {
      const { services, storage, get } = makeServices({
        client: {
          get: vi.fn(async (path: string) =>
            path.startsWith("/profiles/") ? { orcid: "0000-0002-1825-0097" } : ({}),
          ),
          put: vi.fn(async () => undefined),
        } as unknown as OnboardingServices["client"],
      });
      seed(storage, { orcidStartedAt: "2026-11-15T00:00:00Z" });

      const { result } = await renderOnboarding(services);

      expect(get).toHaveBeenCalledWith(`/profiles/${encodeURIComponent(OWNER)}`);
      expect(result.current.orcid.linked).toBe(true);
      expect(result.current.steps.find((step) => step.id === "orcid")?.done).toBe(true);
    });

    it("a profile it cannot read leaves the step at started, not failed", async () => {
      const { services, storage } = makeServices();
      seed(storage, { orcidStartedAt: "2026-11-15T00:00:00Z" });

      const { result } = await renderOnboarding(services);

      expect(result.current.orcid.started).toBe(true);
      expect(result.current.orcid.linked).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe("pick categories", () => {
    it("toggles chips, adds a custom one, and saves them", async () => {
      const { services, storage, put } = makeServices();
      const { result } = await renderOnboarding(services);

      act(() => {
        result.current.toggleCategory("cs.AI");
        result.current.toggleCategory("cs.LG");
        result.current.toggleCategory("cs.LG"); // off again
      });
      expect(result.current.categories.selected).toEqual(["cs.AI"]);

      let added = false;
      act(() => {
        added = result.current.addCategory("math.CO");
      });
      expect(added).toBe(true);
      expect(result.current.categories.selected).toEqual(["cs.AI", "math.CO"]);
      expect(result.current.categories.choices).toContain("math.CO");

      await act(async () => {
        await result.current.saveCategories();
      });

      expect(put.mock.calls.map(([path]) => path)).toEqual([
        "/me/follows/cs.AI",
        "/me/follows/math.CO",
      ]);
      expect(result.current.categories.saved).toEqual(["cs.AI", "math.CO"]);
      expect(result.current.categories.savedToAccount).toBe(true);
      expect(result.current.steps.find((step) => step.id === "categories")?.done).toBe(true);
      const stored = JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}");
      expect(stored.categories).toEqual(["cs.AI", "math.CO"]);
    });

    it("completes the step locally when following is not on this node yet", async () => {
      const { services } = makeServices({
        client: {
          get: vi.fn(async () => ({})),
          put: vi.fn(async () => {
            throw apiErrorFrom(404, { detail: "Not Found" });
          }),
        } as unknown as OnboardingServices["client"],
      });
      const { result } = await renderOnboarding(services);

      act(() => result.current.toggleCategory("cs.AI"));
      await act(async () => {
        await result.current.saveCategories();
      });

      expect(result.current.categories.savedToAccount).toBe(false);
      expect(result.current.steps.find((step) => step.id === "categories")?.done).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it("shows why a typed-in category cannot be added", async () => {
      const { services } = makeServices();
      const { result } = await renderOnboarding(services);

      let added = true;
      act(() => {
        added = result.current.addCategory("machine learning");
      });
      expect(added).toBe(false);
      expect(result.current.categories.invalidMessage).toBe(CATEGORY_INVALID_MESSAGE);
      expect(result.current.categories.selected).toEqual([]);
    });

    it("reports a failed save and leaves the step undone", async () => {
      const { services } = makeServices({
        client: {
          get: vi.fn(async () => ({})),
          put: vi.fn(async () => {
            throw apiErrorFrom(401, { detail: "Not authenticated" });
          }),
        } as unknown as OnboardingServices["client"],
      });
      const { result } = await renderOnboarding(services);

      act(() => result.current.toggleCategory("cs.AI"));
      await act(async () => {
        await result.current.saveCategories();
      });

      expect(result.current.error).toBe(ONBOARDING_SESSION_EXPIRED_MESSAGE);
      expect(result.current.steps.find((step) => step.id === "categories")?.done).toBe(false);
    });
  });

  describe("set guardians (required before the first submission)", () => {
    async function typeGuardians(result: { current: ReturnType<typeof useOnboarding> }) {
      for (const [index, value] of FIVE.entries()) {
        act(() => result.current.setGuardianValue(index, value));
      }
    }

    it("saves five guardians and unlocks finishing", async () => {
      const { services, storage, put } = makeServices();
      const { result } = await renderOnboarding(services);
      expect(result.current.canFinish).toBe(false);

      await typeGuardians(result);
      await act(async () => {
        await result.current.saveGuardiansAction();
      });

      expect(put).toHaveBeenCalledWith("/me/guardians", { guardians: FIVE });
      expect(result.current.guardians.saved).toEqual(FIVE);
      expect(result.current.guardians.problems).toEqual([]);
      expect(result.current.steps.find((step) => step.id === "guardians")?.done).toBe(true);
      expect(result.current.canFinish).toBe(true);
      const stored = JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}");
      expect(stored.guardians).toEqual(FIVE);
      expect(stored.guardiansSavedAt).toEqual(expect.any(String));
    });

    it("rejects the list in the browser first, with the input named", async () => {
      const { services, put } = makeServices();
      const { result } = await renderOnboarding(services);

      for (const [index, value] of [G1, G1, G2, G3, G4].entries()) {
        act(() => result.current.setGuardianValue(index, value));
      }
      await act(async () => {
        await result.current.saveGuardiansAction();
      });

      expect(put).not.toHaveBeenCalled();
      expect(result.current.guardians.problems).toHaveLength(1);
      expect(result.current.guardians.problems[0].index).toBe(1);
      expect(result.current.canFinish).toBe(false);
    });

    it("refuses to let the account be its own guardian", async () => {
      const { services } = makeServices();
      const { result } = await renderOnboarding(services);

      for (const [index, value] of [G1, G2, G3, G4, OWNER].entries()) {
        act(() => result.current.setGuardianValue(index, value));
      }
      await act(async () => {
        await result.current.saveGuardiansAction();
      });

      expect(result.current.guardians.problems[0].index).toBe(4);
      expect(result.current.guardians.problems[0].message).toContain("own DID");
    });

    it("maps the API's 422 onto the inputs and keeps the step undone", async () => {
      const { services } = makeServices({
        client: {
          get: vi.fn(async () => ({})),
          put: vi.fn(async () => {
            throw apiErrorFrom(422, {
              type: "urn:scholium:problem:invalid-guardians",
              detail: "The guardian list is not valid.",
              errors: [
                {
                  loc: ["body", "guardians", 2],
                  msg: "Guardian 2 is not a canonical did:key.",
                },
              ],
            });
          }),
        } as unknown as OnboardingServices["client"],
      });
      const { result } = await renderOnboarding(services);

      await typeGuardians(result);
      await act(async () => {
        await result.current.saveGuardiansAction();
      });

      expect(result.current.guardians.problems).toEqual([
        { index: 2, message: "Guardian 2 is not a canonical did:key." },
      ]);
      expect(result.current.canFinish).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("editing an input clears only its own problem", async () => {
      const { services } = makeServices();
      const { result } = await renderOnboarding(services);

      for (const [index, value] of ["nope", G2, G3, G4, ""].entries()) {
        act(() => result.current.setGuardianValue(index, value));
      }
      await act(async () => {
        await result.current.saveGuardiansAction();
      });
      const problemCount = result.current.guardians.problems.length;
      expect(problemCount).toBeGreaterThan(0);

      act(() => result.current.setGuardianValue(0, G1));
      const remaining = result.current.guardians.problems;
      expect(remaining.every((problem) => problem.index !== 0)).toBe(true);
      expect(remaining.length).toBe(problemCount - 1);
    });

    it("a transport failure is described, not turned into input problems", async () => {
      const { services } = makeServices({
        client: {
          get: vi.fn(async () => ({})),
          put: vi.fn(async () => {
            throw new NetworkError("http://api.invalid/v1/me/guardians");
          }),
        } as unknown as OnboardingServices["client"],
      });
      const { result } = await renderOnboarding(services);

      await typeGuardians(result);
      await act(async () => {
        await result.current.saveGuardiansAction();
      });

      expect(result.current.guardians.problems).toEqual([]);
      expect(result.current.error).toBe(
        "Can't reach Scholium. Check your connection and try again.",
      );
      expect(result.current.canFinish).toBe(false);
    });
  });
});
