// Login/unlock/lock, key + token storage, and the encrypted offline cache.
//
// storage.session (memory only, cleared when the browser closes, TRUSTED_CONTEXTS):
//   userKey (b64), tokens, account {server,email}, serverHash, syncError
// storage.local (disk): cache (encrypted sync data + email + KDF + server), deviceId, server,
//   lastUsed, neverDomains, undo, pendingAt

import { browser } from 'wxt/browser';
import * as api from './api';
import {
  b64decode,
  b64encode,
  decryptEnc,
  deriveMasterKey,
  normalizeEmail,
  serverHash,
  stretch,
  symKeyFromBytes,
  symKeyToBytes,
  type SymKey,
} from './crypto';
import type { RawCipher, RawFolder, SyncResponse, TokenResponse } from './types';

export const DEFAULT_SERVER = 'https://vault.mccormick.sh';
export const SYNC_STALE_MS = 5 * 60_000;

export type LockState = 'loggedOut' | 'locked' | 'unlocked';

export interface Cache {
  server: string;
  email: string;
  kdf: { kdf: number; iterations: number };
  sync: { profile: SyncResponse['profile']; folders: RawFolder[]; ciphers: RawCipher[] };
  lastSync: number;
}

interface Tokens {
  access: string;
  refresh: string | null;
  expiresAt: number;
}

interface Account {
  server: string;
  email: string;
}

const local = () => browser.storage.local;
const sess = () => browser.storage.session;

export async function getLocal<T>(key: string): Promise<T | undefined> {
  return (await local().get(key))[key] as T | undefined;
}
export function setLocal(key: string, value: unknown): Promise<void> {
  return local().set({ [key]: value });
}
async function getSess<T>(key: string): Promise<T | undefined> {
  return (await sess().get(key))[key] as T | undefined;
}
function setSess(values: Record<string, unknown>): Promise<void> {
  return sess().set(values);
}

let restricted = false;
/** Keep session storage away from content scripts. */
export async function restrictSession(): Promise<void> {
  if (restricted) return;
  restricted = true;
  try {
    await (sess() as unknown as { setAccessLevel?: (o: object) => Promise<void> }).setAccessLevel?.({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
  } catch {
    /* Firefox: session storage is never exposed to content scripts. */
  }
}

// ---- cache ----

let cacheMem: Cache | null | undefined;
const cacheListeners = new Set<() => void>();
export function onCacheChange(cb: () => void): void {
  cacheListeners.add(cb);
}

/** Drop the in-memory copy so the next read comes from storage (used by the e2e harness). */
export function forgetCacheMemory(): void {
  cacheMem = undefined;
  cacheListeners.forEach((cb) => cb());
}

export async function getCache(): Promise<Cache | null> {
  if (cacheMem === undefined) cacheMem = (await getLocal<Cache>('cache')) ?? null;
  return cacheMem;
}

export async function saveCache(c: Cache | null, notify = true): Promise<void> {
  cacheMem = c;
  if (c) await setLocal('cache', c);
  else await local().remove('cache');
  if (notify) cacheListeners.forEach((cb) => cb());
}

// ---- keys / state ----

export async function getUserKey(): Promise<SymKey | null> {
  const b = await getSess<string>('userKey');
  return b ? symKeyFromBytes(b64decode(b)) : null;
}

export async function getState(): Promise<LockState> {
  if (await getSess<string>('userKey')) return 'unlocked';
  return (await getCache()) ? 'locked' : 'loggedOut';
}

export async function getAccount(): Promise<Account | null> {
  const a = await getSess<Account>('account');
  if (a) return a;
  const c = await getCache();
  return c ? { server: c.server, email: c.email } : null;
}

export async function getServerSetting(): Promise<string> {
  return (await getLocal<string>('server')) ?? DEFAULT_SERVER;
}

async function device(): Promise<api.Device> {
  let id = await getLocal<string>('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    await setLocal('deviceId', id);
  }
  const firefox = import.meta.env?.FIREFOX === true;
  return { identifier: id, type: firefox ? 3 : 2, name: firefox ? 'firefox' : 'chrome' };
}

function tokensFrom(t: TokenResponse, prevRefresh: string | null = null): Tokens {
  return {
    access: t.access_token,
    refresh: t.refresh_token ?? prevRefresh,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
  };
}

function normalizeServer(s: string): string {
  const url = new URL(s.trim());
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('Server URL must use https');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

// ---- unlock / login ----

export interface UnlockArgs {
  password: string;
  email?: string;
  server?: string;
}

/** Returns once the vault is usable. With a cache, login + sync continue in the background (`background`). */
export async function unlock(args: UnlockArgs): Promise<{ background: Promise<void> | null }> {
  const cache = await getCache();
  if (!cache) {
    await firstLogin(args);
    return { background: null };
  }
  const { password } = args;
  const mk = await deriveMasterKey(password, cache.email, cache.kdf.iterations);
  let userKey: SymKey;
  try {
    userKey = symKeyFromBytes(await decryptEnc(cache.sync.profile.key, await stretch(mk)));
  } catch {
    // Wrong password, or the KDF / master password changed on the server: try online.
    try {
      await onlineLogin(cache.server, cache.email, password);
      return { background: syncNow().then(() => undefined) };
    } catch (e) {
      if ((e as Error).message === 'Argon2id not supported') throw e;
      throw new Error('Invalid master password');
    }
  }
  const hash = await serverHash(mk, password);
  await restrictSession();
  await setSess({
    userKey: b64encode(symKeyToBytes(userKey)),
    account: { server: cache.server, email: cache.email },
    serverHash: hash,
    syncError: null,
  });
  const background = (async () => {
    try {
      await loginWithHash(cache.server, cache.email, hash);
      await syncNow();
    } catch (e) {
      await setSess({ syncError: (e as Error).message });
    }
  })();
  return { background };
}

async function loginWithHash(server: string, email: string, hash: string): Promise<TokenResponse> {
  const t = await api.login(server, email, hash, await device());
  await setSess({ tokens: tokensFrom(t) });
  return t;
}

/** Prelogin + login; stores user key, account and tokens in the session. */
async function onlineLogin(server: string, email: string, password: string): Promise<void> {
  const pre = await api.prelogin(server, email);
  if (pre.kdf !== 0) throw new Error('Argon2id not supported');
  const mk = await deriveMasterKey(password, email, pre.kdfIterations);
  const hash = await serverHash(mk, password);
  const t = await loginWithHash(server, email, hash);
  if (!t.key) throw new Error('Server did not return a user key');
  const userKey = symKeyFromBytes(await decryptEnc(t.key, await stretch(mk)));
  await restrictSession();
  await setSess({
    userKey: b64encode(symKeyToBytes(userKey)),
    account: { server, email },
    serverHash: hash,
    kdf: { kdf: pre.kdf, iterations: pre.kdfIterations },
    syncError: null,
  });
}

async function firstLogin({ password, email, server }: UnlockArgs): Promise<void> {
  if (!email) throw new Error('Email required');
  const srv = normalizeServer(server || (await getServerSetting()));
  const e = normalizeEmail(email);
  await setLocal('server', srv);
  await onlineLogin(srv, e, password);
  try {
    await syncNow();
  } catch (err) {
    await sess().clear();
    throw err;
  }
}

// ---- tokens ----

let refreshing: Promise<string> | null = null;

export async function authCtx(): Promise<api.AuthCtx> {
  const acct = await getAccount();
  if (!acct) throw new Error('Not logged in');
  const forceRefresh = (): Promise<string> => {
    refreshing ??= (async () => {
      const t = await getSess<Tokens>('tokens');
      if (t?.refresh) {
        try {
          const r = await api.refresh(acct.server, t.refresh);
          const next = tokensFrom(r, t.refresh);
          await setSess({ tokens: next });
          return next.access;
        } catch (e) {
          if (!(e instanceof api.ApiError) || (e.status !== 400 && e.status !== 401)) throw e;
        }
      }
      const hash = await getSess<string>('serverHash');
      if (!hash) throw new Error('Session expired. Lock and unlock again.');
      return (await loginWithHash(acct.server, acct.email, hash)).access_token;
    })().finally(() => (refreshing = null));
    return refreshing;
  };
  return {
    ...acct,
    async token() {
      const t = await getSess<Tokens>('tokens');
      if (t && t.expiresAt - Date.now() > 60_000) return t.access;
      return forceRefresh();
    },
    forceRefresh,
  };
}

// ---- sync ----

let syncing: Promise<Cache> | null = null;

export function isSyncing(): boolean {
  return !!syncing;
}

export function syncNow(): Promise<Cache> {
  syncing ??= (async () => {
    const ctx = await authCtx();
    const s = await api.sync(ctx);
    if (normalizeEmail(s.profile?.email ?? '') !== normalizeEmail(ctx.email)) {
      throw new Error('Sync returned a different account; refusing to cache it');
    }
    const prev = await getCache();
    const kdf = (await getSess<Cache['kdf']>('kdf')) ?? prev?.kdf;
    if (!kdf) throw new Error('Missing KDF parameters');
    const cache: Cache = {
      server: ctx.server,
      email: normalizeEmail(ctx.email),
      kdf,
      sync: { profile: s.profile, folders: s.folders ?? [], ciphers: s.ciphers ?? [] },
      lastSync: Date.now(),
    };
    await saveCache(cache);
    await setSess({ syncError: null });
    return cache;
  })()
    .catch(async (e) => {
      await setSess({ syncError: (e as Error).message }).catch(() => {});
      throw e;
    })
    .finally(() => (syncing = null));
  return syncing;
}

export async function syncError(): Promise<string | null> {
  return (await getSess<string>('syncError')) ?? null;
}

// ---- lock / logout ----

export async function lock(): Promise<void> {
  await sess().clear();
}

export async function logout(): Promise<void> {
  await sess().clear();
  await saveCache(null);
}
