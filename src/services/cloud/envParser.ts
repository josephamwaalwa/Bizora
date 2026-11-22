export interface ParsedClientSupabaseEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY?: string;
  VITE_SUPABASE_ANON_KEY?: string;
}

/**
 * Decodes a `.env` file buffer safely across UTF-8 (with or without BOM),
 * UTF-16LE (common on Windows PowerShell/Notepad), and UTF-16BE.
 */
export function decodeEnvFileBuffer(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // UTF-8 BOM: EF BB BF
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }

  // UTF-16LE BOM: FF FE
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }

  // UTF-16BE BOM: FE FF (swap pairs into LE for portable TextDecoder support)
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2);
    const swapped = new Uint8Array(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    if (body.length % 2 === 1) {
      swapped[body.length - 1] = body[body.length - 1];
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }

  // Heuristic for BOM-less UTF-16LE (many alternating 0x00 bytes on ASCII chars)
  if (bytes.length >= 4 && bytes[1] === 0x00 && bytes[3] === 0x00) {
    return new TextDecoder('utf-16le').decode(bytes);
  }

  const decoded = new TextDecoder('utf-8').decode(bytes);
  return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
      return trimmed.slice(1, -1).trim();
    }
  }

  // Strip unquoted inline comments (e.g. KEY=value # comment)
  const commentIdx = trimmed.search(/\s+#/);
  if (commentIdx >= 0) {
    return trimmed.slice(0, commentIdx).trim();
  }

  return trimmed;
}

/**
 * Parses `.env` text cleanly, stripping any leading UTF-8 BOM, CRLF line endings,
 * optional `export ` prefixes, and outer quotes.
 */
export function parseEnvContent(rawText: string): Record<string, string> {
  const result: Record<string, string> = {};
  const normalized = (rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText).replace(/\r\n?/g, '\n');

  for (const rawLine of normalized.split('\n')) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const withoutExport = trimmedLine.startsWith('export ')
      ? trimmedLine.slice('export '.length).trimStart()
      : trimmedLine;

    const eqIndex = withoutExport.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const rawKey = withoutExport.slice(0, eqIndex).trim().replace(/^\uFEFF/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)) {
      continue;
    }

    const rawValue = withoutExport.slice(eqIndex + 1);
    result[rawKey] = unquoteEnvValue(rawValue);
  }

  return result;
}

function pickFirstNonEmpty(
  sources: Array<Record<string, string | undefined>>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    // Check highest-precedence source first (sources are ordered low -> high precedence)
    for (let i = sources.length - 1; i >= 0; i -= 1) {
      const val = sources[i]?.[key];
      if (typeof val === 'string' && val.trim().length > 0) {
        return val.trim();
      }
    }
  }
  return undefined;
}

/**
 * Resolves ONLY client-safe public Supabase variables from `.env` / `process.env` sources.
 * Never reads or exposes `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`.
 */
export function resolveSupabaseClientEnvFromSources(
  sources: Array<Record<string, string | undefined>>
): ParsedClientSupabaseEnv {
  const url = pickFirstNonEmpty(sources, ['VITE_SUPABASE_URL', 'SUPABASE_URL']);
  const publishableKey = pickFirstNonEmpty(sources, ['VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEY']);
  const publishableDefaultKey = pickFirstNonEmpty(sources, [
    'VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY',
    'SUPABASE_PUBLISHABLE_DEFAULT_KEY',
  ]);
  const anonKey = pickFirstNonEmpty(sources, ['VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY']);

  const resolved: ParsedClientSupabaseEnv = {};
  if (url) resolved.VITE_SUPABASE_URL = url;
  if (publishableKey) resolved.VITE_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  if (publishableDefaultKey) resolved.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY = publishableDefaultKey;
  if (anonKey) resolved.VITE_SUPABASE_ANON_KEY = anonKey;
  return resolved;
}
