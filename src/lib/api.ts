// HTTP client for Vaultwarden /identity and /api. Only allowlisted endpoints can be called.

import { b64url, normalizeEmail } from './crypto';
import type { PreloginResponse, RawCipher, SyncResponse, TokenResponse } from './types';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** The only endpoints this extension may call (todo.md, Decision 19). */
export const ALLOWED_ENDPOINTS: readonly [method: string, path: RegExp][] = [
  ['POST', /^\/identity\/accounts\/prelogin$/],
  ['POST', /^\/identity\/connect\/token$/],
  ['GET', /^\/api\/sync\?excludeDomains=true$/],
  ['POST', /^\/api\/ciphers$/],
  ['PUT', new RegExp(`^/api/ciphers/${UUID}$`)],
  ['PUT', new RegExp(`^/api/ciphers/${UUID}/delete$`)],
  ['PUT', new RegExp(`^/api/ciphers/${UUID}/restore$`)],
];

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export function assertAllowed(method: string, path: string): void {
  if (!ALLOWED_ENDPOINTS.some(([m, re]) => m === method && re.test(path))) {
    throw new Error(`Blocked: ${method} ${path} is not on the endpoint allowlist`);
  }
}

// ---- Write lock ----

declare const __LW_WRITE_LOCK__: { release: boolean; testEmail: string } | undefined;
const writeLock = typeof __LW_WRITE_LOCK__ !== 'undefined' ? __LW_WRITE_LOCK__ : { release: false, testEmail: '' };

export function writesAllowedFor(email: string, lock = writeLock): boolean {
  if (lock.release) return true;
  return !!lock.testEmail && normalizeEmail(email) === normalizeEmail(lock.testEmail);
}

export function assertWriteAllowed(email: string): void {
  if (!writesAllowedFor(email)) {
    throw new Error('Writes are disabled in this build for this account (dev write lock).');
  }
}

// ---- Errors / normalization ----

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Recursively lowercase the first letter of every object key (PascalCase → camelCase). */
export function normalizeKeys<T = unknown>(v: unknown): T {
  if (Array.isArray(v)) return v.map(normalizeKeys) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k.charAt(0).toLowerCase() + k.slice(1)] = normalizeKeys(val);
    return out as T;
  }
  return v as T;
}

async function errorFrom(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let body: any = null;
  try {
    body = normalizeKeys(JSON.parse(text));
  } catch {
    if ((res.status === 403 || res.status === 503) && /<html/i.test(text)) {
      return new ApiError(`Blocked by Cloudflare (HTTP ${res.status}). The server needs a WAF skip rule.`, res.status);
    }
  }
  const msg =
    body?.error_description ||
    body?.message ||
    body?.errorModel?.message ||
    (body?.validationErrors && Object.values(body.validationErrors).flat().join('; ')) ||
    `HTTP ${res.status}${text ? `: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}`;
  return new ApiError(String(msg), res.status);
}

interface ReqOpts {
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  token?: string;
}

export function joinUrl(server: string, path: string): string {
  return server.trim().replace(/\/+$/, '') + path;
}

async function request<T>(server: string, method: string, path: string, opts: ReqOpts = {}): Promise<T> {
  assertAllowed(method, path);
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    body = new URLSearchParams(opts.form).toString();
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(joinUrl(server, path), { method, headers, body, credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new ApiError('Cannot reach the server (offline?)', 0);
  }
  if (!res.ok) throw await errorFrom(res);
  const text = await res.text();
  if (!text) return null as T;
  try {
    return normalizeKeys<T>(JSON.parse(text));
  } catch {
    throw new ApiError(`Unexpected non-JSON response (HTTP ${res.status})`, res.status);
  }
}

// ---- Identity ----

export interface Device {
  identifier: string;
  type: number;
  name: string;
}

export function prelogin(server: string, email: string): Promise<PreloginResponse> {
  return request(server, 'POST', '/identity/accounts/prelogin', { json: { email: normalizeEmail(email) } });
}

export async function login(server: string, email: string, hash: string, device: Device): Promise<TokenResponse> {
  const e = normalizeEmail(email);
  try {
    return await request<TokenResponse>(server, 'POST', '/identity/connect/token', {
      form: {
        grant_type: 'password',
        username: e,
        password: hash,
        scope: 'api offline_access',
        client_id: 'browser',
        deviceType: String(device.type),
        deviceIdentifier: device.identifier,
        deviceName: device.name,
      },
      headers: { 'Auth-Email': b64url(e) },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) throw new ApiError('Invalid email or master password', 400);
    throw err;
  }
}

export function refresh(server: string, refreshToken: string): Promise<TokenResponse> {
  return request(server, 'POST', '/identity/connect/token', {
    form: { grant_type: 'refresh_token', client_id: 'browser', refresh_token: refreshToken },
  });
}

// ---- Authenticated API ----

export interface AuthCtx {
  server: string;
  email: string;
  /** Returns a valid access token, refreshing first if it expires within 60 s. */
  token(): Promise<string>;
  /** Forces a refresh (after a 401) and returns the new token. */
  forceRefresh(): Promise<string>;
}

async function authed<T>(ctx: AuthCtx, method: string, path: string, json?: unknown): Promise<T> {
  assertAllowed(method, path);
  if (WRITE_METHODS.has(method)) assertWriteAllowed(ctx.email);
  try {
    return await request<T>(ctx.server, method, path, { json, token: await ctx.token() });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    return request<T>(ctx.server, method, path, { json, token: await ctx.forceRefresh() });
  }
}

export function sync(ctx: AuthCtx): Promise<SyncResponse> {
  return authed(ctx, 'GET', '/api/sync?excludeDomains=true');
}

export function createCipher(ctx: AuthCtx, body: unknown): Promise<RawCipher> {
  return authed(ctx, 'POST', '/api/ciphers', body);
}

export function updateCipher(ctx: AuthCtx, id: string, body: unknown): Promise<RawCipher> {
  return authed(ctx, 'PUT', `/api/ciphers/${id}`, body);
}

export function trashCipher(ctx: AuthCtx, id: string): Promise<void> {
  return authed(ctx, 'PUT', `/api/ciphers/${id}/delete`);
}

export function restoreCipher(ctx: AuthCtx, id: string): Promise<RawCipher> {
  return authed(ctx, 'PUT', `/api/ciphers/${id}/restore`);
}
