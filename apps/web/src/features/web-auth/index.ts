/**
 * `web-auth` — passkey-gated device identity for Scholium.
 *
 * The feature owns one job: keep an Ed25519 signing key on the device, never
 * exportable, and require a WebAuthn passkey prompt before it signs anything.
 *
 * ```ts
 * import { DeviceKeyManager, MemoryDeviceKeyStorage } from "@/features/web-auth";
 *
 * const key = new DeviceKeyManager();
 * await key.create({ userName: "mei@example.edu" }); // passkey prompt
 * const did = await key.didKey();                    // "did:key:z6Mk…"
 * const signature = await key.sign(nonce);           // unlocked for 5 minutes
 * ```
 *
 * The export is the plugin's public surface; route files in
 * `apps/web/src/app/(web-auth)/` and other features import from here.
 */

export {
  DeviceKeyError,
  PasskeyCancelledError,
  RecordSigningError,
  isDeviceKeyError,
  isPasskeyCancellation,
  isRecordSigningError,
  toDeviceKeyError,
  type DeviceKeyErrorCode,
  type RecordSigningErrorCode,
} from "./errors";

export {
  bytesEqual,
  concatBytes,
  fromBase64Url,
  fromHex,
  toBase64Url,
  toHex,
  toUint8Array,
  utf8Decode,
  utf8Encode,
  type BinaryData,
} from "./encoding";

export {
  ED25519_MULTICODEC,
  decodeBase58,
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyFromDidKey,
  encodeBase58,
  isEd25519DidKey,
} from "./did-key";

export {
  ED25519,
  ED25519_ALGORITHM,
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SIGNATURE_LENGTH,
  assertNonExtractablePrivateKey,
  createEd25519Crypto,
  ed25519Crypto,
  isEd25519Supported,
  resolveCrypto,
  type CryptoProvider,
  type Ed25519Crypto,
  type Ed25519KeyPair,
} from "./webcrypto-ed25519";

export {
  DEVICE_KEY_DATABASE_NAME,
  DEVICE_KEY_DATABASE_VERSION,
  DEVICE_KEY_RECORD_ID,
  DEVICE_KEY_RECORD_VERSION,
  DEVICE_KEY_STORE_NAME,
  IndexedDbDeviceKeyStorage,
  MemoryDeviceKeyStorage,
  createDeviceKeyStorage,
  isStoredDeviceKey,
  type DeviceKeyStorage,
  type IndexedDbDeviceKeyStorageOptions,
  type StoredDeviceKey,
} from "./device-key-storage";

export {
  BrowserPasskeyProvider,
  COSE_ALG_EDDSA,
  COSE_ALG_ES256,
  DEFAULT_PASSKEY_TIMEOUT_MS,
  browserPasskeys,
  createBrowserPasskeyProvider,
  isBrowserPasskeySupported,
  type BrowserPasskeyProviderOptions,
  type CredentialsContainerLike,
  type PasskeyAssertionOptions,
  type PasskeyAssertionResult,
  type PasskeyProvider,
  type PasskeyRegistrationOptions,
  type PasskeyRegistrationResult,
} from "./passkey";

export {
  DEFAULT_UNLOCK_TTL_MS,
  DeviceKeyManager,
  createDeviceKeyManager,
  defaultRelyingPartyId,
  deviceKey,
  type CreateDeviceKeyOptions,
  type DeviceKeyManagerOptions,
  type DeviceKeySummary,
  type SignOptions,
  type UnlockDeviceKeyOptions,
} from "./device-key";

export {
  RECORD_ENVELOPE_VERSION,
  SIGN_AND_SUBMIT_REASON,
  signRecord,
  type ComputeRecordCid,
  type RecordCid,
  type RecordSigner,
  type SignRecordOptions,
  type SignedRecord,
} from "./sign-record";

export {
  DEFAULT_PASSKEY_DISPLAY_NAME,
  DEFAULT_PASSKEY_USER_NAME,
  DEFAULT_SIGNIN_REDIRECT,
  NEW_ACCOUNT_STORAGE_KEY,
  ONBOARDING_PATH,
  SIGNIN_PATH,
  SignInError,
  hasPendingNewAccount,
  isSignInError,
  parseChallenge,
  safeRedirectPath,
  signIn,
  signInDestination,
  type ChallengeResponse,
  type SignInClient,
  type SignInDeviceKey,
  type SignInErrorCode,
  type SignInOptions,
  type SignInResult,
  type SignInStage,
} from "./signin";

export {
  SIGNIN_FALLBACK_MESSAGE,
  SIGNIN_STAGE_MESSAGES,
  SIGNIN_SUCCESS_MESSAGE,
  SIGNIN_UNSUPPORTED_MESSAGE,
  describeSignInError,
} from "./signin-messages";

export {
  GUARDIAN_COUNT,
  ONBOARDING_CATEGORY_CHOICES,
  ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY,
  GuardianSaveError,
  OnboardingError,
  checkOrcidLink,
  countCompletedSteps,
  emptyPersistedOnboarding,
  followCategories,
  followsEndpointUnavailable,
  guardianProblemsFromApiError,
  isGuardianSaveError,
  isOnboardingError,
  loadPersistedOnboarding,
  normalizeCategory,
  onboardingStepCompletion,
  parseOrcidStart,
  profileShowsLinkedOrcid,
  saveGuardians,
  savePersistedOnboarding,
  startOrcidLink,
  updatePersistedOnboarding,
  validateGuardians,
  type FollowCategoriesResult,
  type GuardianProblem,
  type OnboardingClient,
  type OnboardingErrorCode,
  type OnboardingStepId,
  type OnboardingStepInfo,
  type OrcidStartInfo,
  type PersistedOnboarding,
} from "./onboarding";

export {
  GUARDIANS_REQUIRED_NOTE,
  GUARDIANS_SKIP_NOTE,
  ONBOARDING_FINISH_ACTION,
  ONBOARDING_LEDE,
  describeOnboardingError,
} from "./onboarding-messages";

export {
  defaultOnboardingServices,
  useOnboarding,
  type OnboardingServices,
  type UseOnboardingResult,
} from "./use-onboarding";
