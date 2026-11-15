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

export {
  RECOVER_PATH,
  RECOVERY_APPROVAL_THRESHOLD,
  RECOVERY_CANCEL_REASON,
  RECOVERY_GUARDIAN_COUNT,
  RECOVERY_REQUESTS_PATH,
  RECOVERY_STORAGE_KEY,
  RECOVERY_STATUSES,
  RecoveryError,
  approvalProgressText,
  approvalsRemaining,
  cancelRecoveryRequest,
  clearPersistedRecovery,
  fetchRecoveryStatus,
  formatRecoveryDeadline,
  formatSafetyWindowRemaining,
  isCancellable,
  isOrcid,
  isRecoveryError,
  isRecoveryStatusUnavailable,
  loadPersistedRecovery,
  mergeRecoveryStatus,
  normalizeOrcid,
  openRecoveryRequest,
  parseOpenedRecovery,
  parseRecoveryInstant,
  parseRecoveryStatus,
  parseRecoveryStatusUpdate,
  placeholderRecovery,
  recoveryRequestPath,
  savePersistedRecovery,
  safetyWindowRemainingMs,
  type OpenRecoveryRequestOptions,
  type OpenedRecovery,
  type RecoveryClient,
  type RecoveryErrorCode,
  type RecoverySigner,
  type RecoverySnapshot,
  type RecoveryStatus,
  type RecoveryStatusUpdate,
} from "./recover";

export {
  RECOVER_ACCOUNT_NOT_FOUND_MESSAGE,
  RECOVER_CANCELLED_NOTICE,
  RECOVER_CANCEL_ACTION,
  RECOVER_CANCEL_NOTE,
  RECOVER_FALLBACK_MESSAGE,
  RECOVER_GUARDIANS_NOT_SET_MESSAGE,
  RECOVER_HOW_IT_WORKS,
  RECOVER_LEDE,
  RECOVER_ORCID_INVALID_MESSAGE,
  RECOVER_REQUEST_ID_LABEL,
  RECOVER_SAFETY_WINDOW_HEADING,
  RECOVER_START_ACTION,
  RECOVER_STARTED_NOTICE,
  RECOVER_STATUS_UNAVAILABLE_NOTE,
  RECOVER_TITLE,
  RECOVER_UNSUPPORTED_MESSAGE,
  RECOVER_WRONG_DEVICE_MESSAGE,
  describeRecoveryError,
  recoveryProgressLine,
  recoveryProgressNote,
  recoveryStatusLabel,
  safetyWindowNote,
} from "./recover-messages";

export {
  defaultRecoveryServices,
  useRecover,
  type RecoveryDeviceKey,
  type RecoveryServices,
  type UseRecoverOptions,
  type UseRecoverResult,
} from "./use-recover";
