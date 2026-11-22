export const BIZORA_OAUTH_REDIRECT_SCHEME = 'bizora';
export const BIZORA_OAUTH_REDIRECT_URI = 'bizora://auth/callback';
export const BIZORA_OAUTH_STATE_PARAM = 'bizora_state';
export const BIZORA_PKCE_FLOW_ID_PARAM = 'sb_flow_id';
export const PENDING_OAUTH_STORAGE_KEY = 'bizora.cloud.pending_oauth_v1';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface PendingOAuthFlow {
  nonce: string;
  createdAtMs: number;
  expiresAtMs: number;
  redirectUri: string;
  flowId?: string | null;
}

export interface ParsedOAuthCallback {
  isCallbackUrl: boolean;
  code: string | null;
  bizoraState: string | null;
  flowId: string | null;
  error: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  hasUnexpectedTokens: boolean;
}

export type OAuthCallbackValidationResult =
  | { kind: 'ignored' }
  | { kind: 'duplicate'; fingerprint: string }
  | { kind: 'cancelled'; fingerprint: string; reason: string }
  | { kind: 'failed'; fingerprint: string; reason: string }
  | {
      kind: 'valid_code';
      code: string;
      state: string;
      flowId: string | null;
      fingerprint: string;
    };

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Generates a 256-bit cryptographically random URL-safe OAuth state nonce.
 */
export function generateOAuthStateNonce(): string {
  const bytes = new Uint8Array(32);
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    globalThis.crypto.getRandomValues(bytes);
    return toBase64Url(bytes);
  }
  throw new Error('Cryptographic random generator is unavailable for OAuth state generation.');
}

export function buildOAuthRedirectUri(nonce: string): string {
  const url = new URL(BIZORA_OAUTH_REDIRECT_URI);
  url.searchParams.set(BIZORA_OAUTH_STATE_PARAM, nonce);
  return url.toString();
}

export function isValidOAuthBrowserUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') {
      return Boolean(parsed.hostname);
    }
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i += 1) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    diff |= charA ^ charB;
  }
  return diff === 0;
}

function hashCallbackFingerprint(parts: string[]): string {
  const input = parts.join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function sanitizeProviderErrorMessage(
  error: string | null,
  description: string | null
): string {
  const combined = `${description ?? ''} ${error ?? ''}`.trim();
  const redacted = combined
    .replace(/https?:\/\/[^\s]+/gi, '[URL]')
    .replace(/bizora:\/\/[^\s]+/gi, '[CALLBACK]')
    .trim();

  if (!redacted) {
    return 'Google sign-in failed. Please try again.';
  }
  return redacted.length > 220 ? `${redacted.slice(0, 217)}...` : redacted;
}

function isCancelledOAuthError(
  error: string | null,
  description: string | null
): boolean {
  const normalizedError = (error ?? '').trim().toLowerCase();
  const normalizedDesc = (description ?? '').trim().toLowerCase();
  if (
    normalizedError === 'access_denied' ||
    normalizedError === 'user_cancelled' ||
    normalizedError === 'cancelled'
  ) {
    return true;
  }
  return (
    normalizedDesc.includes('access_denied') ||
    normalizedDesc.includes('user denied') ||
    normalizedDesc.includes('cancelled') ||
    normalizedDesc.includes('canceled')
  );
}

export function parseOAuthCallbackUrl(rawUrl: string): ParsedOAuthCallback {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      isCallbackUrl: false,
      code: null,
      bizoraState: null,
      flowId: null,
      error: null,
      errorCode: null,
      errorDescription: null,
      hasUnexpectedTokens: false,
    };
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
  const matchesAuthCallback =
    scheme === BIZORA_OAUTH_REDIRECT_SCHEME &&
    ((host === 'auth' && normalizedPath === '/callback') ||
      (host === '' && normalizedPath === '/auth/callback'));

  if (!matchesAuthCallback) {
    return {
      isCallbackUrl: false,
      code: null,
      bizoraState: null,
      flowId: null,
      error: null,
      errorCode: null,
      errorDescription: null,
      hasUnexpectedTokens: false,
    };
  }

  const hashParams = new URLSearchParams(
    parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
  );
  const readParam = (name: string): string | null => {
    const fromQuery = parsed.searchParams.get(name);
    if (fromQuery !== null && fromQuery.trim() !== '') {
      return fromQuery.trim();
    }
    const fromHash = hashParams.get(name);
    if (fromHash !== null && fromHash.trim() !== '') {
      return fromHash.trim();
    }
    return null;
  };

  const hasUnexpectedTokens =
    readParam('access_token') !== null ||
    readParam('refresh_token') !== null ||
    readParam('provider_token') !== null;

  return {
    isCallbackUrl: true,
    code: readParam('code'),
    bizoraState: readParam(BIZORA_OAUTH_STATE_PARAM),
    flowId: readParam(BIZORA_PKCE_FLOW_ID_PARAM),
    error: readParam('error'),
    errorCode: readParam('error_code'),
    errorDescription: readParam('error_description'),
    hasUnexpectedTokens,
  };
}

export function validateOAuthCallback(params: {
  rawUrl: string;
  pendingFlow: PendingOAuthFlow | null;
  nowMs?: number;
  processedFingerprints: ReadonlySet<string>;
}): OAuthCallbackValidationResult {
  const { rawUrl, pendingFlow, processedFingerprints } = params;
  const nowMs = params.nowMs ?? Date.now();
  const parsed = parseOAuthCallbackUrl(rawUrl);

  if (!parsed.isCallbackUrl) {
    return { kind: 'ignored' };
  }

  const fingerprint = hashCallbackFingerprint([
    parsed.code ?? '',
    parsed.error ?? '',
    parsed.errorCode ?? '',
    parsed.bizoraState ?? '',
    parsed.flowId ?? '',
  ]);

  if (processedFingerprints.has(fingerprint)) {
    return { kind: 'duplicate', fingerprint };
  }

  if (parsed.hasUnexpectedTokens) {
    return {
      kind: 'failed',
      fingerprint,
      reason:
        'Rejected callback containing raw tokens in the URL. Only PKCE authorization code callbacks are permitted.',
    };
  }

  // If the callback carries bizora_state and we have an active flow, enforce constant-time match first
  if (
    parsed.bizoraState !== null &&
    pendingFlow &&
    !timingSafeEqualStrings(parsed.bizoraState, pendingFlow.nonce)
  ) {
    return {
      kind: 'failed',
      fingerprint,
      reason: 'OAuth state verification failed. Please start Google sign-in again.',
    };
  }

  if (parsed.error || parsed.errorCode || parsed.errorDescription) {
    if (isCancelledOAuthError(parsed.error, parsed.errorDescription)) {
      return {
        kind: 'cancelled',
        fingerprint,
        reason: 'Google sign-in was cancelled before completion.',
      };
    }

    return {
      kind: 'failed',
      fingerprint,
      reason: sanitizeProviderErrorMessage(parsed.error, parsed.errorDescription),
    };
  }

  if (!parsed.code) {
    return {
      kind: 'failed',
      fingerprint,
      reason: 'OAuth callback did not include an authorization code.',
    };
  }

  if (!pendingFlow) {
    return {
      kind: 'failed',
      fingerprint,
      reason: 'No active Google sign-in session was awaiting this callback. Please start sign-in again.',
    };
  }

  if (nowMs > pendingFlow.expiresAtMs) {
    return {
      kind: 'failed',
      fingerprint,
      reason: 'Google sign-in request expired before the callback arrived. Please try again.',
    };
  }

  if (
    !parsed.bizoraState ||
    !timingSafeEqualStrings(parsed.bizoraState, pendingFlow.nonce)
  ) {
    return {
      kind: 'failed',
      fingerprint,
      reason: 'OAuth callback state parameter was missing or invalid.',
    };
  }

  return {
    kind: 'valid_code',
    code: parsed.code,
    state: parsed.bizoraState,
    flowId: parsed.flowId ?? pendingFlow.flowId ?? null,
    fingerprint,
  };
}
