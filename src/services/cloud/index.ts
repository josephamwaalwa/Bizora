export {
  detectBrowserOnlineStatus,
  resolveCloudAvailabilityState,
  validateSupabaseConfig,
  type CloudAvailabilityState,
  type CloudAvailabilityStatus,
  type CloudConfigStatus,
  type SupabaseConfigValidationResult,
  type SupabaseEnvInput,
  type SupabaseEnvVarName,
} from './config';

export {
  createDefaultCloudAuthStorage,
  createMemoryAuthStorage,
  createTauriSecureStorage,
  type AuthStorageKind,
  type CloudAuthStorage,
  type TauriInvokeFn,
} from './secureStorage';

export {
  BIZORA_OAUTH_REDIRECT_SCHEME,
  BIZORA_OAUTH_REDIRECT_URI,
  BIZORA_OAUTH_STATE_PARAM,
  BIZORA_PKCE_FLOW_ID_PARAM,
  OAUTH_STATE_TTL_MS,
  PENDING_OAUTH_STORAGE_KEY,
  buildOAuthRedirectUri,
  generateOAuthStateNonce,
  isValidOAuthBrowserUrl,
  parseOAuthCallbackUrl,
  timingSafeEqualStrings,
  validateOAuthCallback,
  type OAuthCallbackValidationResult,
  type ParsedOAuthCallback,
  type PendingOAuthFlow,
} from './oauthCallback';

export {
  createSupabaseClientManager,
  defaultSupabaseClientManager,
  getCloudAvailabilityState,
  getSupabaseClient,
  getSupabaseConfigStatus,
  subscribeCloudAvailability,
  type SupabaseClientFactory,
  type SupabaseClientManager,
  type SupabaseClientManagerOptions,
} from './supabaseClient';

export {
  cloudAuthService,
  createCloudAuthService,
  type CloudAuthErrorCode,
  type CloudAuthNotice,
  type CloudAuthResult,
  type CloudAuthService,
  type CloudAuthServiceDeps,
  type CloudAuthSession,
  type CloudAuthState,
  type CloudAuthStatus,
} from './authService';
