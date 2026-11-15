/**
 * `dashboard` — the signed-in member's home screen (`/me`).
 *
 * The feature owns the route group `app/(dashboard)/` and this module.
 *
 * ```tsx
 * import { ME_PATH, DashboardPage, SECURITY_PATH, SecurityPage } from "@/features/dashboard";
 *
 * <DashboardPage />   // /me
 * <SecurityPage />    // /me/security: devices, guardians 3 of 5, key rotation
 * ```
 */

export {
  ME_PATH,
  DASHBOARD_PATH,
  DASHBOARD_ENDPOINT,
  ME_DASHBOARD_ENDPOINT,
  ME_TITLE,
  DASHBOARD_TITLE,
  SIGNIN_HREF,
  DashboardError,
  MeError,
  MeDashboardError,
  parseDashboard,
  describeDashboardError,
  describeMeError,
  describeMeDashboardError,
  loadDashboard,
  loadMe,
  loadMeDashboard,
  type AttentionItem,
  type DashboardClient,
  type DashboardData,
  type LoadDashboard,
  type MeData,
  type MeDashboardData,
  type MyPaper,
  type MyReview,
  type NeedsAttention,
} from "./dashboard";

export {
  DashboardPage,
  MePage,
  MeDashboardPage,
  Dashboard,
  type DashboardPageProps,
} from "./dashboard-page";

export {
  GUARDIANS_ENDPOINT,
  GUARDIANS_SETUP_HREF,
  GUARDIAN_SCHEME,
  GUARDIAN_THRESHOLD,
  GUARDIAN_TOTAL,
  SECURITY_PATH,
  SECURITY_SIGNIN_HREF,
  SECURITY_TITLE,
  SecurityError,
  describeGuardianSource,
  describeGuardians,
  describeSecurityError,
  didEndpoint,
  formatDay,
  formatInstant,
  guardiansComplete,
  guardiansSet,
  loadDevices,
  loadGuardians,
  loadSecurity,
  parseGuardianList,
  parseKeyState,
  type DeviceInfo,
  type GuardianSource,
  type GuardianState,
  type KeyRotation,
  type KeyState,
  type LoadSecurityOptions,
  type SecurityClient,
  type SecurityData,
  type SecurityDevice,
} from "./security";

export {
  KEY_ROTATION_RECORD_TYPE,
  ROTATION_REASON_MAX_LENGTH,
  RotationError,
  TERMINAL_ROTATION_CODES,
  defaultRotationSeams,
  describeRotationError,
  isRotationError,
  rotateKey,
  type ReplacementKey,
  type RotateKey,
  type RotateKeyInput,
  type RotationErrorCode,
  type RotationResult,
  type RotationSeams,
} from "./rotate-key";

export { SecurityPage, type LoadSecurity, type SecurityPageProps } from "./security-page";
export {
  PROFILE_PATH,
  USER_PATH,
  PUBLIC_PROFILE_PATH,
  U_PATH,
  profilePath,
  PROFILE_ENDPOINT,
  PROFILE_TITLE,
  USER_TITLE,
  PUBLIC_PROFILE_TITLE,
  PROFILE_SIGNIN_HREF,
  ProfileError,
  ProfilePageError,
  PublicProfileError,
  UserProfileError,
  parseProfile,
  loadProfile,
  loadProfilePage,
  loadPublicProfile,
  loadUserProfile,
  fetchProfile,
  eraseProfile,
  deleteProfile,
  eraseMyProfile,
  describeProfileError,
  describeProfilePageError,
  describePublicProfileError,
  describeUserProfileError,
  type SignedReview,
  type ProfileData,
  type ProfilePageData,
  type PublicProfileData,
  type UserProfileData,
  type ProfileClient,
} from "./profile";

export { ProfilePage, UserProfilePage, PublicProfilePage, type LoadProfile, type ProfilePageProps } from "./profile-page";
