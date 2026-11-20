/**
 * Centralized multiplayer backend configuration.
 *
 * Resolution order for the Cloudflare Worker URL:
 * 1. Build-time env var `VITE_API_BASE_URL` (set automatically by GitHub Actions or local `.env`)
 * 2. Build-time alias `VITE_CLOUDFLARE_WORKER_URL`
 * 3. `DEFAULT_CLOUDFLARE_WORKER_URL` (optional hardcoded Worker URL for zero-config builds)
 * 4. Same-origin fallback (`window.location.host`) for local Node.js development (`npm run dev`)
 */
export const DEFAULT_CLOUDFLARE_WORKER_URL = 'https://deep-tile-multiplayer.karizmadbst.workers.dev';

function normalizeHttpBase(raw: string | undefined): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^wss?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://').replace(/\/ws$/i, '');
  }
  return `https://${trimmed}`;
}

function normalizeWsBase(raw: string | undefined): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const withScheme = /^wss?:\/\//i.test(trimmed)
    ? trimmed
    : /^https:\/\//i.test(trimmed)
      ? trimmed.replace(/^https:\/\//i, 'wss://')
      : /^http:\/\//i.test(trimmed)
        ? trimmed.replace(/^http:\/\//i, 'ws://')
        : `wss://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      parsed.pathname = '/ws';
    }
    return parsed.toString();
  } catch {
    return withScheme.endsWith('/ws') ? withScheme : `${withScheme}/ws`;
  }
}

const ENV_API_BASE = normalizeHttpBase(
  import.meta.env.VITE_API_BASE_URL ||
    import.meta.env.VITE_CLOUDFLARE_WORKER_URL ||
    DEFAULT_CLOUDFLARE_WORKER_URL
);

const ENV_WS_BASE = normalizeWsBase(import.meta.env.VITE_WS_BASE_URL);

export function getMultiplayerApiBase(): string {
  return ENV_API_BASE;
}

export function isRemoteWorkerBackend(): boolean {
  return Boolean(ENV_API_BASE || ENV_WS_BASE);
}

export function resolveApiUrl(path: string): string {
  if (!ENV_API_BASE) return path;
  return path.startsWith('/') ? `${ENV_API_BASE}${path}` : `${ENV_API_BASE}/${path}`;
}

export function resolveWsUrl(): string {
  if (ENV_WS_BASE) {
    return ENV_WS_BASE;
  }
  if (ENV_API_BASE) {
    try {
      const apiUrl = new URL(ENV_API_BASE);
      const wsProto = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${apiUrl.host}/ws`;
    } catch {
      // Fall back to location host below
    }
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}
