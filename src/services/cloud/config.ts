export type CloudConfigStatus = 'unconfigured' | 'invalid' | 'configured';

export type CloudAvailabilityStatus =
  | 'unconfigured'
  | 'offline'
  | 'unavailable'
  | 'ready'
  | 'error';

export type SupabaseEnvVarName =
  | 'VITE_SUPABASE_URL'
  | 'VITE_SUPABASE_PUBLISHABLE_KEY';

export interface SupabaseEnvInput {
  VITE_SUPABASE_URL?: unknown;
  VITE_SUPABASE_PUBLISHABLE_KEY?: unknown;
  VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY?: unknown;
  VITE_SUPABASE_ANON_KEY?: unknown;
}

export interface SupabaseConfigValidationResult {
  status: CloudConfigStatus;
  isConfigured: boolean;
  url: string | null;
  publishableKey: string | null;
  missingVars: SupabaseEnvVarName[];
  issues: string[];
  error: string | null;
}

export interface CloudAvailabilityState {
  status: CloudAvailabilityStatus;
  isConfigured: boolean;
  isOnline: boolean;
  isCloudAvailable: boolean;
  configStatus: CloudConfigStatus;
  reason: string | null;
  checkedAt: string;
}

const PLACEHOLDER_URL_HOSTS = new Set([
  'your-project-ref.supabase.co',
  'your-project.supabase.co',
  'example.supabase.co',
]);

const PLACEHOLDER_KEY_PREFIXES = [
  'sb_publishable_your_',
  'your-publishable-key',
  'your_publishable_key',
  'your-anon-key',
  'your_anon_key',
];

const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function readDefaultViteEnv(): SupabaseEnvInput {
  let url: unknown;
  let publishableKey: unknown;
  let publishableDefaultKey: unknown;
  let anonKey: unknown;

  // Use direct static property access so Vite/Rollup reliably inlines VITE_* vars in desktop builds.
  try {
    url = import.meta.env.VITE_SUPABASE_URL;
  } catch {
    url = undefined;
  }

  try {
    publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  } catch {
    publishableKey = undefined;
  }

  try {
    publishableDefaultKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
  } catch {
    publishableDefaultKey = undefined;
  }

  try {
    anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  } catch {
    anonKey = undefined;
  }

  return {
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY: publishableDefaultKey,
    VITE_SUPABASE_ANON_KEY: anonKey,
  };
}

function normalizeEnvValue(
  raw: unknown
): { kind: 'missing' } | { kind: 'invalid_type' } | { kind: 'present'; value: string } {
  if (raw === undefined || raw === null) {
    return { kind: 'missing' };
  }
  if (typeof raw !== 'string') {
    return { kind: 'invalid_type' };
  }
  let trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) {
    return { kind: 'missing' };
  }
  return { kind: 'present', value: trimmed };
}

function isTemplatePlaceholderValue(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.startsWith('<') && lower.endsWith('>')) {
    return true;
  }
  return PLACEHOLDER_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (base64.length % 4)) % 4;
    const padded = base64 + '='.repeat(padLength);
    let jsonText: string;

    if (typeof atob === 'function') {
      jsonText = atob(padded);
    } else if (typeof Buffer !== 'undefined') {
      jsonText = Buffer.from(padded, 'base64').toString('utf8');
    } else {
      return null;
    }

    const parsed: unknown = JSON.parse(jsonText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isPrivilegedSupabaseKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.startsWith('sb_secret_')) {
    return true;
  }

  const parts = key.split('.');
  if (parts.length === 3) {
    const payload = decodeBase64UrlJson(parts[1]);
    const role = typeof payload?.role === 'string' ? payload.role.toLowerCase() : null;
    if (role === 'service_role' || role === 'supabase_admin') {
      return true;
    }
  }

  return false;
}

function validateUrlValue(rawUrl: string): { ok: true; url: string } | { ok: false; issue: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      issue: 'VITE_SUPABASE_URL must be a valid URL (for example, https://<project-ref>.supabase.co).',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      issue: 'VITE_SUPABASE_URL must not contain embedded username or password credentials.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return {
      ok: false,
      issue: 'VITE_SUPABASE_URL must include a valid hostname.',
    };
  }

  if (PLACEHOLDER_URL_HOSTS.has(hostname) || (hostname.startsWith('<') && hostname.endsWith('>'))) {
    return {
      ok: false,
      issue: 'VITE_SUPABASE_URL is still set to a template placeholder value.',
    };
  }

  const isLocalHttp = parsed.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(hostname);
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    return {
      ok: false,
      issue: 'VITE_SUPABASE_URL must use https:// (http:// is only allowed for localhost/127.0.0.1).',
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      issue: 'VITE_SUPABASE_URL must be a base project URL without query parameters or hash fragments.',
    };
  }

  const rawNormalizedPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  const isHostedSupabase =
    hostname.endsWith('.supabase.co') || hostname.endsWith('.supabase.in');
  const normalizedPath =
    isHostedSupabase && /^\/(?:rest|auth)\/v1(?:\/.*)?$/i.test(rawNormalizedPath)
      ? ''
      : rawNormalizedPath;

  return {
    ok: true,
    url: `${parsed.origin}${normalizedPath}`,
  };
}

function validatePublishableKeyValue(
  rawKey: string
): { ok: true; key: string } | { ok: false; issue: string } {
  if (/[\s\r\n]/.test(rawKey)) {
    return {
      ok: false,
      issue: 'VITE_SUPABASE_PUBLISHABLE_KEY must not contain whitespace or line breaks.',
    };
  }

  if (isTemplatePlaceholderValue(rawKey)) {
    return {
      ok: false,
      issue: 'VITE_SUPABASE_PUBLISHABLE_KEY is still set to a template placeholder value.',
    };
  }

  if (isPrivilegedSupabaseKey(rawKey)) {
    return {
      ok: false,
      issue:
        'Privileged Supabase secret or service_role keys are forbidden in VITE_SUPABASE_PUBLISHABLE_KEY. Use a public publishable/anon key only.',
    };
  }

  if (rawKey.length < 20) {
    return {
      ok: false,
      issue: 'VITE_SUPABASE_PUBLISHABLE_KEY appears too short to be a valid Supabase publishable key.',
    };
  }

  return {
    ok: true,
    key: rawKey,
  };
}

/**
 * Validates Vite-compatible Supabase client configuration without throwing
 * and without ever exposing credential values in errors or diagnostics.
 */
export function validateSupabaseConfig(
  envInput?: SupabaseEnvInput
): SupabaseConfigValidationResult {
  const env = envInput ?? readDefaultViteEnv();
  const missingVars: SupabaseEnvVarName[] = [];
  const issues: string[] = [];

  const urlEntry = normalizeEnvValue(env.VITE_SUPABASE_URL);
  const rawPublishableEntry = normalizeEnvValue(env.VITE_SUPABASE_PUBLISHABLE_KEY);
  const rawPublishableDefaultFallback = normalizeEnvValue(
    env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY
  );
  const rawAnonFallback = normalizeEnvValue(env.VITE_SUPABASE_ANON_KEY);
  const keyEntry =
    rawPublishableEntry.kind !== 'missing'
      ? rawPublishableEntry
      : rawPublishableDefaultFallback.kind !== 'missing'
        ? rawPublishableDefaultFallback
        : rawAnonFallback.kind !== 'missing'
          ? rawAnonFallback
          : rawPublishableEntry;

  if (urlEntry.kind === 'missing') {
    missingVars.push('VITE_SUPABASE_URL');
  } else if (urlEntry.kind === 'invalid_type') {
    issues.push('VITE_SUPABASE_URL must be a string.');
  }

  if (keyEntry.kind === 'missing') {
    missingVars.push('VITE_SUPABASE_PUBLISHABLE_KEY');
  } else if (keyEntry.kind === 'invalid_type') {
    issues.push('VITE_SUPABASE_PUBLISHABLE_KEY must be a string.');
  }

  // Neither variable is configured: normal offline-first unconfigured state
  if (
    urlEntry.kind === 'missing' &&
    keyEntry.kind === 'missing'
  ) {
    return {
      status: 'unconfigured',
      isConfigured: false,
      url: null,
      publishableKey: null,
      missingVars,
      issues: [],
      error: null,
    };
  }

  let validUrl: string | null = null;
  if (urlEntry.kind === 'present') {
    const checkedUrl = validateUrlValue(urlEntry.value);
    if (checkedUrl.ok) {
      validUrl = checkedUrl.url;
    } else {
      issues.push(checkedUrl.issue);
    }
  } else if (urlEntry.kind === 'missing') {
    issues.push('VITE_SUPABASE_URL is missing while VITE_SUPABASE_PUBLISHABLE_KEY is set.');
  }

  let validKey: string | null = null;
  if (keyEntry.kind === 'present') {
    const checkedKey = validatePublishableKeyValue(keyEntry.value);
    if (checkedKey.ok) {
      validKey = checkedKey.key;
    } else {
      issues.push(checkedKey.issue);
    }
  } else if (keyEntry.kind === 'missing') {
    issues.push('VITE_SUPABASE_PUBLISHABLE_KEY is missing while VITE_SUPABASE_URL is set.');
  }

  if (issues.length > 0 || !validUrl || !validKey) {
    return {
      status: 'invalid',
      isConfigured: false,
      url: null,
      publishableKey: null,
      missingVars,
      issues,
      error: issues.join(' '),
    };
  }

  return {
    status: 'configured',
    isConfigured: true,
    url: validUrl,
    publishableKey: validKey,
    missingVars: [],
    issues: [],
    error: null,
  };
}

export function detectBrowserOnlineStatus(override?: boolean): boolean {
  if (typeof override === 'boolean') {
    return override;
  }
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
  } catch {
    // Fallback to true when navigator.onLine is inaccessible
  }
  return true;
}

export function resolveCloudAvailabilityState(params: {
  config: SupabaseConfigValidationResult;
  isOnline: boolean;
  clientInitError?: string | null;
  checkedAt?: string;
}): CloudAvailabilityState {
  const { config, isOnline, clientInitError = null } = params;
  const checkedAt = params.checkedAt ?? new Date().toISOString();

  if (config.status === 'unconfigured') {
    return {
      status: 'unconfigured',
      isConfigured: false,
      isOnline,
      isCloudAvailable: false,
      configStatus: config.status,
      reason: 'Supabase cloud integration is not configured. Local offline-first SQLite mode is active.',
      checkedAt,
    };
  }

  if (config.status === 'invalid') {
    return {
      status: 'unavailable',
      isConfigured: false,
      isOnline,
      isCloudAvailable: false,
      configStatus: config.status,
      reason: config.error ?? 'Supabase configuration is invalid. Cloud features remain disabled.',
      checkedAt,
    };
  }

  if (clientInitError) {
    return {
      status: 'error',
      isConfigured: true,
      isOnline,
      isCloudAvailable: false,
      configStatus: config.status,
      reason: clientInitError,
      checkedAt,
    };
  }

  if (!isOnline) {
    return {
      status: 'offline',
      isConfigured: true,
      isOnline: false,
      isCloudAvailable: false,
      configStatus: config.status,
      reason: 'No internet connection detected. Cloud features are paused while local mode continues.',
      checkedAt,
    };
  }

  return {
    status: 'ready',
    isConfigured: true,
    isOnline: true,
    isCloudAvailable: true,
    configStatus: config.status,
    reason: null,
    checkedAt,
  };
}
