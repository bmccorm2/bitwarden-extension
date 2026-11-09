// Decrypted in-memory index, item access, and the guarded write path (Decision 19).

import * as api from './api';
import {
  buildCreate,
  buildUpdate,
  cipherKey,
  clearKeyCache,
  decryptCipher,
  decryptRow,
  deepEqual,
  postcheck,
  preflight,
  preflightCreate,
} from './cipher';
import { decryptStr } from './crypto';
import type { PasskeyMeta } from './passkey';
import * as session from './session';
import type { CipherView, FolderView, ListRow, RawCipher } from './types';

interface Index {
  rows: Map<string, ListRow>;
  folders: FolderView[];
}

let index: Index | null = null;
let building: Promise<Index> | null = null;

session.onCacheChange(() => {
  index = null;
});

export function clearIndex(): void {
  index = null;
  clearKeyCache();
}

async function requireKey() {
  const key = await session.getUserKey();
  if (!key) throw new Error('Vault is locked');
  return key;
}

export async function ensureIndex(): Promise<Index> {
  if (index) return index;
  building ??= (async () => {
    const key = await requireKey();
    const cache = await session.getCache();
    if (!cache) throw new Error('No vault data');
    const rows = await Promise.all(cache.sync.ciphers.map((c) => decryptRow(c, key)));
    const folders = await Promise.all(
      cache.sync.folders.map(async (f) => ({
        id: f.id,
        name: await decryptStr(f.name, key).catch(() => '[decryption error]'),
      })),
    );
    folders.sort((a, b) => a.name.localeCompare(b.name));
    index = { rows: new Map(rows.map((r) => [r.id, r])), folders };
    return index;
  })().finally(() => (building = null));
  return building;
}

export async function listRows(): Promise<{ rows: ListRow[]; folders: FolderView[] }> {
  const i = await ensureIndex();
  const rows = [...i.rows.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { rows, folders: i.folders };
}

async function rawById(id: string): Promise<RawCipher> {
  const c = (await session.getCache())?.sync.ciphers.find((x) => x.id === id);
  if (!c) throw new Error('Item not found');
  return c;
}

export async function getItem(id: string): Promise<CipherView> {
  return decryptCipher(await rawById(id), await requireKey());
}

// ---- passkeys (read-only; Decision 20) ----

const META_FIELDS = ['rpId', 'credentialId', 'userName', 'discoverable', 'counter', 'keyAlgorithm', 'keyCurve'] as const;

/** Metadata of every passkey in active logins. Private keys stay encrypted; undecryptable ones are skipped. */
export async function passkeyMetas(): Promise<PasskeyMeta[]> {
  const key = await requireKey();
  const ciphers = (await session.getCache())?.sync.ciphers ?? [];
  const out: PasskeyMeta[] = [];
  for (const c of ciphers) {
    const creds = c.login?.fido2Credentials;
    if (c.type !== 1 || c.deletedDate || !creds?.length) continue;
    try {
      const k = await cipherKey(c, key);
      const itemName = c.name ? await decryptStr(c.name, k) : '';
      for (const [credIndex, f] of creds.entries()) {
        try {
          const m = Object.fromEntries(
            await Promise.all(
              META_FIELDS.map(async (n) => [n, typeof f[n] === 'string' ? await decryptStr(f[n] as string, k) : '']),
            ),
          ) as Record<(typeof META_FIELDS)[number], string>;
          out.push({ cipherId: c.id, credIndex, itemName, ...m });
        } catch {
          /* skip this passkey */
        }
      }
    } catch {
      /* skip this item */
    }
  }
  return out;
}

/** Decrypts one passkey's private key and user handle (background only; never sent to a content script). */
export async function passkeySecret(cipherId: string, credIndex: number): Promise<{ keyValue: string; userHandle: string }> {
  const raw = await rawById(cipherId);
  const f = raw.login?.fido2Credentials?.[credIndex];
  if (!f || typeof f.keyValue !== 'string') throw new Error('Passkey not found');
  const k = await cipherKey(raw, await requireKey());
  return {
    keyValue: await decryptStr(f.keyValue, k),
    userHandle: typeof f.userHandle === 'string' ? await decryptStr(f.userHandle, k) : '',
  };
}

/** Replace (or add) a cipher in the cache and the index, without a full sync. */
async function merge(raw: RawCipher): Promise<void> {
  const cache = await session.getCache();
  if (!cache) return;
  const list = cache.sync.ciphers;
  const i = list.findIndex((c) => c.id === raw.id);
  if (i >= 0) list[i] = raw;
  else list.push(raw);
  await session.saveCache(cache, false);
  if (index) index.rows.set(raw.id, await decryptRow(raw, await requireKey()));
}

// ---- undo store ----

export interface UndoEntry {
  id: string;
  at: number;
  op: 'update' | 'trash' | 'restore' | 'revert';
  cipher: RawCipher;
}

const UNDO_MAX = 100;

export async function pushUndo(op: UndoEntry['op'], cipher: RawCipher): Promise<void> {
  const list = (await session.getLocal<UndoEntry[]>('undo')) ?? [];
  list.unshift({ id: cipher.id, at: Date.now(), op, cipher: structuredClone(cipher) });
  await session.setLocal('undo', list.slice(0, UNDO_MAX));
}

export async function latestUndo(id: string): Promise<UndoEntry | null> {
  return ((await session.getLocal<UndoEntry[]>('undo')) ?? []).find((u) => u.id === id) ?? null;
}

// ---- writes (one at a time, never retried) ----

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const OUT_OF_DATE = 'Item changed elsewhere; reloaded. Re-apply your edit.';

async function writeCtx() {
  const ctx = await session.authCtx();
  api.assertWriteAllowed(ctx.email);
  // Vaultwarden (web-v2025.6+) requires `encryptedFor` = the user id on every create/update.
  const userId = (await session.getCache())?.sync.profile.id;
  if (!userId) throw new Error('Missing user id; sync first');
  return { ctx, userId };
}

async function handleConflict<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof api.ApiError && e.status === 400 && /out of date/i.test(e.message)) {
      await session.syncNow().catch(() => {});
      throw new Error(OUT_OF_DATE);
    }
    throw e;
  }
}

export function save(view: CipherView): Promise<CipherView> {
  return serial(async () => {
    const { ctx, userId } = await writeCtx();
    const key = await requireKey();
    if (!view.id) {
      const payload = { ...(await buildCreate(view, key)), encryptedFor: userId };
      preflightCreate(payload, userId);
      const created = await api.createCipher(ctx, payload);
      await merge(created);
      return postcheck(created, view, key);
    }
    const raw = await rawById(view.id);
    if (raw.revisionDate !== view.revisionDate) throw new Error(OUT_OF_DATE);
    if (raw.deletedDate) throw new Error('Restore the item before editing it');
    const before = await decryptCipher(raw, key);
    const plan = await buildUpdate(raw, before, view, key);
    if (plan.changed.size === 0) return before;
    const payload = { ...plan.payload, encryptedFor: userId };
    preflight(raw, payload, plan.changed, userId);
    await pushUndo('update', raw);
    const updated = await handleConflict(api.updateCipher(ctx, raw.id, payload));
    await merge(updated);
    try {
      return await postcheck(updated, view, key, raw);
    } catch (e) {
      throw new Error(`${(e as Error).message}. The previous version is in the undo store.`);
    }
  });
}

export function trash(id: string): Promise<void> {
  return serial(async () => {
    const { ctx } = await writeCtx();
    const raw = await rawById(id);
    if (raw.deletedDate) return;
    await pushUndo('trash', raw);
    await api.trashCipher(ctx, id);
    await merge({ ...raw, deletedDate: new Date().toISOString() });
    // Refresh revision dates from the server and confirm the item is in the trash.
    const cache = await session.syncNow().catch(() => null);
    const now = cache?.sync.ciphers.find((c) => c.id === id);
    if (cache && (!now || !now.deletedDate)) throw new Error('Post-write check: item is not in the trash on the server');
  });
}

export function restore(id: string): Promise<CipherView> {
  return serial(async () => {
    const { ctx } = await writeCtx();
    const raw = await rawById(id);
    await pushUndo('restore', raw);
    const restored = await api.restoreCipher(ctx, id);
    if (!restored || restored.deletedDate) throw new Error('Post-write check: item is still in the trash');
    await merge(restored);
    const key = await requireKey();
    return postcheck(restored, await decryptCipher(raw, key), key, raw);
  });
}

/** Writes the last saved original back with a normal update ("Revert to previous version"). */
export async function revert(id: string): Promise<CipherView> {
  const entry = await latestUndo(id);
  if (!entry) throw new Error('Nothing to revert');
  if (entry.op === 'trash') return restore(id);
  if (entry.op === 'restore') {
    await trash(id);
    return getItem(id);
  }
  return serial(async () => {
    const { ctx, userId } = await writeCtx();
    const key = await requireKey();
    const current = await rawById(id);
    const old = entry.cipher;
    if ((old.key ?? null) !== (current.key ?? null)) throw new Error('Revert: item key differs; refusing');
    const n0 = current.login?.fido2Credentials?.length ?? 0;
    const n1 = old.login?.fido2Credentials?.length ?? 0;
    if (n1 < n0) throw new Error('Revert would remove a passkey; refusing');
    const payload = structuredClone(old) as RawCipher & { lastKnownRevisionDate: string; encryptedFor: string };
    payload.encryptedFor = userId;
    // Never shorten the password history.
    if ((current.passwordHistory?.length ?? 0) > (old.passwordHistory?.length ?? 0)) {
      payload.passwordHistory = structuredClone(current.passwordHistory);
    }
    payload.lastKnownRevisionDate = current.revisionDate;
    const intended = await decryptCipher(old, key);
    if (deepEqual({ ...old, revisionDate: '' }, { ...current, revisionDate: '' })) return getItem(id);
    await pushUndo('revert', current);
    const updated = await handleConflict(api.updateCipher(ctx, id, payload));
    await merge(updated);
    return postcheck(updated, intended, key, current);
  });
}
