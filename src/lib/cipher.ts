// Pure cipher logic: decrypt to views, build write payloads, and the Decision 19 safety checks.

import { decryptEnc, decryptStr, encryptStr, sha256B64, symKeyFromBytes, type SymKey } from './crypto';
import {
  CARD_FIELDS,
  CipherType,
  IDENTITY_FIELDS,
  type CardView,
  type CipherView,
  type FieldView,
  type IdentityView,
  type ListRow,
  type RawCipher,
  type RawField,
  type RawLogin,
  type UriView,
} from './types';

export const HISTORY_MAX = 5;

const itemKeyCache = new Map<string, Promise<SymKey>>();

/** The key for every encrypted field of this cipher: its own item key, or the user key. */
export function cipherKey(raw: Pick<RawCipher, 'key'>, userKey: SymKey): Promise<SymKey> {
  if (!raw.key) return Promise.resolve(userKey);
  const cacheKey = raw.key;
  let k = itemKeyCache.get(cacheKey);
  if (!k) {
    k = decryptEnc(raw.key, userKey).then(symKeyFromBytes);
    k.catch(() => itemKeyCache.delete(cacheKey));
    itemKeyCache.set(cacheKey, k);
  }
  return k;
}

export function clearKeyCache(): void {
  itemKeyCache.clear();
}

async function dec(v: unknown, key: SymKey): Promise<string> {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw new Error('Expected EncString');
  return decryptStr(v, key);
}

async function decLenient(v: unknown, key: SymKey): Promise<string> {
  try {
    return await dec(v, key);
  } catch {
    return '[decryption error]';
  }
}

async function decUris(login: RawLogin | null | undefined, key: SymKey, d = dec): Promise<UriView[]> {
  return Promise.all((login?.uris ?? []).map(async (u) => ({ uri: await d(u.uri, key), match: u.match ?? null })));
}

const blank = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, ''])) as Record<K, string>;

export function emptyView(type: number): CipherView {
  return {
    id: null,
    type,
    name: '',
    notes: '',
    folderId: null,
    favorite: false,
    reprompt: 0,
    login:
      type === CipherType.Login
        ? { username: '', password: '', totp: '', uris: [], passwordRevisionDate: null, passkeys: [] }
        : null,
    card: type === CipherType.Card ? blank(CARD_FIELDS) : null,
    identity: type === CipherType.Identity ? blank(IDENTITY_FIELDS) : null,
    fields: [],
    passwordHistory: [],
    revisionDate: null,
    creationDate: null,
    deletedDate: null,
    hasPerItemKey: false,
  };
}

/** Full, strict decryption (throws on any failure so a broken item can't be edited). */
export async function decryptCipher(raw: RawCipher, userKey: SymKey): Promise<CipherView> {
  const key = await cipherKey(raw, userKey);
  const v = emptyView(raw.type);
  v.id = raw.id;
  v.name = await dec(raw.name, key);
  v.notes = await dec(raw.notes, key);
  v.folderId = raw.folderId ?? null;
  v.favorite = !!raw.favorite;
  v.reprompt = raw.reprompt ?? 0;
  v.revisionDate = raw.revisionDate ?? null;
  v.creationDate = raw.creationDate ?? null;
  v.deletedDate = raw.deletedDate ?? null;
  v.hasPerItemKey = !!raw.key;
  if (raw.type === CipherType.Login) {
    const l = raw.login;
    v.login = {
      username: await dec(l?.username, key),
      password: await dec(l?.password, key),
      totp: await dec(l?.totp, key),
      uris: await decUris(l, key),
      passwordRevisionDate: l?.passwordRevisionDate ?? null,
      passkeys: (l?.fido2Credentials ?? []).map((f) => String(f.creationDate ?? '')),
    };
  }
  if (raw.type === CipherType.Card) {
    const c = (raw.card ?? {}) as Record<string, unknown>;
    v.card = Object.fromEntries(await Promise.all(CARD_FIELDS.map(async (k) => [k, await dec(c[k], key)]))) as CardView;
  }
  if (raw.type === CipherType.Identity) {
    const c = (raw.identity ?? {}) as Record<string, unknown>;
    v.identity = Object.fromEntries(
      await Promise.all(IDENTITY_FIELDS.map(async (k) => [k, await dec(c[k], key)])),
    ) as IdentityView;
  }
  v.fields = await Promise.all(
    (raw.fields ?? []).map(async (f) => ({
      name: await dec(f.name, key),
      value: await dec(f.value, key),
      type: f.type,
      linkedId: f.linkedId ?? null,
    })),
  );
  v.passwordHistory = await Promise.all(
    (raw.passwordHistory ?? []).map(async (h) => ({ password: await dec(h.password, key), lastUsedDate: h.lastUsedDate })),
  );
  return v;
}

/** Cheap list-row decryption; never throws. */
export async function decryptRow(raw: RawCipher, userKey: SymKey): Promise<ListRow> {
  let key: SymKey | null = null;
  try {
    key = await cipherKey(raw, userKey);
  } catch {
    /* broken item key */
  }
  const d = (v: unknown) => (key ? decLenient(v, key) : Promise.resolve(v ? '[decryption error]' : ''));
  const row: ListRow = {
    id: raw.id,
    type: raw.type,
    name: (await d(raw.name)) || '(no name)',
    username: '',
    uri: '',
    uris: [],
    folderId: raw.folderId ?? null,
    favorite: !!raw.favorite,
    deleted: !!raw.deletedDate,
    hasTotp: false,
    subtitle: '',
  };
  if (raw.type === CipherType.Login && raw.login) {
    row.username = await d(raw.login.username);
    row.uris = key ? await decUris(raw.login, key, decLenient) : [];
    row.uri = row.uris.find((u) => u.uri)?.uri ?? '';
    row.hasTotp = !!raw.login.totp;
    row.subtitle = row.username;
  } else if (raw.type === CipherType.Card && raw.card) {
    const brand = await d(raw.card.brand);
    const num = await d(raw.card.number);
    row.subtitle = [brand, num ? `*${num.slice(-4)}` : ''].filter(Boolean).join(', ');
  } else if (raw.type === CipherType.Identity && raw.identity) {
    row.subtitle = [await d(raw.identity.firstName), await d(raw.identity.lastName)].filter(Boolean).join(' ');
  }
  return row;
}

// ---------------------------------------------------------------------------
// Building payloads

const encOrNull = (s: string, key: SymKey) => (s ? encryptStr(s, key) : Promise.resolve(null));

function sameUri(a: UriView, b: UriView) {
  return a.uri === b.uri && (a.match ?? null) === (b.match ?? null);
}

function sameField(a: FieldView, b: FieldView) {
  return a.name === b.name && a.value === b.value && a.type === b.type && (a.linkedId ?? null) === (b.linkedId ?? null);
}

function sameList<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean) {
  return a.length === b.length && a.every((x, i) => eq(x, b[i]!));
}

async function buildUris(
  rawUris: NonNullable<RawLogin['uris']>,
  before: UriView[],
  after: UriView[],
  key: SymKey,
): Promise<NonNullable<RawLogin['uris']>> {
  const used = new Set<number>();
  const out: NonNullable<RawLogin['uris']> = [];
  for (const u of after) {
    const i = before.findIndex((b, j) => !used.has(j) && sameUri(b, u) && rawUris[j]);
    if (i >= 0) {
      used.add(i);
      out.push(rawUris[i]!);
    } else {
      out.push({
        uri: await encOrNull(u.uri, key),
        match: u.match ?? null,
        uriChecksum: u.uri ? await encryptStr(await sha256B64(u.uri), key) : null,
      });
    }
  }
  return out;
}

async function buildFields(rawFields: RawField[], before: FieldView[], after: FieldView[], key: SymKey): Promise<RawField[]> {
  const used = new Set<number>();
  const out: RawField[] = [];
  for (const f of after) {
    const i = before.findIndex((b, j) => !used.has(j) && sameField(b, f) && rawFields[j]);
    if (i >= 0) {
      used.add(i);
      out.push(rawFields[i]!);
    } else {
      out.push({
        type: f.type,
        name: await encOrNull(f.name, key),
        value: await encOrNull(f.value, key),
        linkedId: f.type === 3 ? f.linkedId : null,
      });
    }
  }
  return out;
}

export interface UpdatePlan {
  payload: RawCipher & { lastKnownRevisionDate: string };
  changed: Set<string>;
}

/**
 * Start from the original encrypted cipher and re-encrypt only the fields that differ
 * between `before` (decryption of `raw`) and `after` (the user's edit).
 */
export async function buildUpdate(
  raw: RawCipher,
  before: CipherView,
  after: CipherView,
  userKey: SymKey,
  now = new Date(),
): Promise<UpdatePlan> {
  if (after.type !== raw.type) throw new Error('Changing the item type is not supported');
  const key = await cipherKey(raw, userKey);
  const p = structuredClone(raw) as UpdatePlan['payload'];
  const changed = new Set<string>();
  const nowIso = now.toISOString();

  if (after.name !== before.name) {
    p.name = await encOrNull(after.name, key);
    changed.add('name');
  }
  if (after.notes !== before.notes) {
    p.notes = await encOrNull(after.notes, key);
    changed.add('notes');
  }
  if ((after.folderId ?? null) !== (before.folderId ?? null)) {
    p.folderId = after.folderId ?? null;
    changed.add('folderId');
  }
  if (after.favorite !== before.favorite) {
    p.favorite = after.favorite;
    changed.add('favorite');
  }

  if (raw.type === CipherType.Login && after.login && before.login) {
    const a = after.login;
    const b = before.login;
    const l = (p.login ??= { username: null, password: null, totp: null }) as RawLogin;
    if (a.username !== b.username) {
      l.username = await encOrNull(a.username, key);
      changed.add('login.username');
    }
    if (a.totp !== b.totp) {
      l.totp = await encOrNull(a.totp, key);
      changed.add('login.totp');
    }
    if (a.password !== b.password) {
      l.password = await encOrNull(a.password, key);
      changed.add('login.password');
      if (b.password) {
        // Decision 12: old password goes to the history, newest first, max 5.
        const entry = { lastUsedDate: nowIso, password: await encryptStr(b.password, key) };
        p.passwordHistory = [entry, ...(raw.passwordHistory ?? [])].slice(0, HISTORY_MAX);
        l.passwordRevisionDate = nowIso;
        changed.add('passwordHistory');
        changed.add('login.passwordRevisionDate');
      }
    }
    if (!sameList(a.uris, b.uris, sameUri)) {
      l.uris = await buildUris(raw.login?.uris ?? [], b.uris, a.uris, key);
      changed.add('login.uris');
      if ('uri' in l) {
        // Legacy single-URI mirror; keep it consistent with uris[0].
        l.uri = l.uris[0]?.uri ?? null;
        changed.add('login.uri');
      }
    }
  }

  for (const [kind, names] of [
    ['card', CARD_FIELDS],
    ['identity', IDENTITY_FIELDS],
  ] as const) {
    const a = after[kind] as Record<string, string> | null;
    const b = before[kind] as Record<string, string> | null;
    if (!a || !b) continue;
    for (const k of names) {
      if (a[k] !== b[k]) {
        const obj = (p[kind] ??= {}) as Record<string, unknown>;
        obj[k] = await encOrNull(a[k] ?? '', key);
        changed.add(`${kind}.${k}`);
      }
    }
  }

  if (!sameList(after.fields, before.fields, sameField)) {
    p.fields = await buildFields(raw.fields ?? [], before.fields, after.fields, key);
    changed.add('fields');
  }

  p.lastKnownRevisionDate = raw.revisionDate;
  return { payload: p, changed };
}

export async function buildCreate(after: CipherView, userKey: SymKey): Promise<Record<string, unknown>> {
  const key = userKey; // New items have no per-item key.
  const empty = emptyView(after.type);
  const fake: RawCipher = {
    id: '',
    type: after.type,
    folderId: null,
    name: null,
    notes: null,
    favorite: false,
    reprompt: 0,
    key: null,
    login: after.type === CipherType.Login ? { username: null, password: null, totp: null, uris: [] } : null,
    secureNote: after.type === CipherType.SecureNote ? { type: 0 } : null,
    card: after.type === CipherType.Card ? {} : null,
    identity: after.type === CipherType.Identity ? {} : null,
    fields: [],
    passwordHistory: null,
    revisionDate: '',
  };
  const { payload } = await buildUpdate(fake, empty, { ...after, login: after.login && { ...after.login, passkeys: [] } }, key);
  const { id: _id, revisionDate: _r, lastKnownRevisionDate: _l, ...rest } = payload;
  return { ...rest, key: null, reprompt: 0, passwordHistory: null };
}

// ---------------------------------------------------------------------------
// Decision 19 safety checks

const NEVER_CHANGE = ['id', 'type', 'key', 'organizationId', 'attachments', 'login.fido2Credentials'];

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a) || !(k in b) || !deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

const isEnc = (v: unknown) => v === null || (typeof v === 'string' && /^2\.[^|]+\|[^|]+\|[^|]+$/.test(v));

/** Fields the server needs on every write that are not part of the stored cipher. */
const WRITE_ONLY = new Set(['lastKnownRevisionDate', 'encryptedFor']);

/** Pre-flight: every field outside `changed` must be byte-identical to the original. Throws on mismatch. */
export function preflight(raw: RawCipher, payload: Record<string, unknown>, changed: Set<string>, userId: string): void {
  if (!userId || payload.encryptedFor !== userId) throw new Error('Pre-flight: encryptedFor must be the user id');
  for (const c of changed) {
    if (NEVER_CHANGE.some((n) => c === n || c.startsWith(n + '.') || n.startsWith(c + '.'))) {
      throw new Error(`Pre-flight: refusing to change protected field "${c}"`);
    }
  }
  const walk = (a: unknown, b: unknown, path: string) => {
    if (changed.has(path)) return;
    if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!path && WRITE_ONLY.has(k)) continue;
        const sub = path ? `${path}.${k}` : k;
        if (!(k in a) || !(k in b)) {
          if (changed.has(sub)) continue;
          throw new Error(`Pre-flight: field "${sub}" was ${k in a ? 'dropped' : 'added'}`);
        }
        walk(a[k], b[k], sub);
      }
      return;
    }
    if (!deepEqual(a, b)) throw new Error(`Pre-flight: unedited field "${path}" differs from the original`);
  };
  walk(raw, payload, '');

  if (payload.lastKnownRevisionDate !== raw.revisionDate) throw new Error('Pre-flight: bad lastKnownRevisionDate');

  // Protected fields, checked explicitly as well.
  if (!deepEqual(raw.key, payload.key)) throw new Error('Pre-flight: item key changed');
  if (!deepEqual(raw.attachments, payload.attachments)) throw new Error('Pre-flight: attachments changed');
  const f0 = (raw.login as RawLogin | undefined)?.fido2Credentials;
  const f1 = (payload.login as RawLogin | undefined)?.fido2Credentials;
  if (!deepEqual(f0, f1)) throw new Error('Pre-flight: passkeys changed');

  if (changed.has('passwordHistory')) {
    const old = raw.passwordHistory ?? [];
    const now = (payload.passwordHistory ?? []) as unknown[];
    const expectedLen = Math.min(HISTORY_MAX, old.length + 1);
    const head = now[0] as { password?: unknown; lastUsedDate?: unknown } | undefined;
    if (
      !changed.has('login.password') ||
      now.length !== expectedLen ||
      !head ||
      !isEnc(head.password) ||
      typeof head.lastUsedDate !== 'string' ||
      !deepEqual(now.slice(1), old.slice(0, expectedLen - 1))
    ) {
      throw new Error('Pre-flight: password history would be lost');
    }
  }

  for (const c of changed) {
    if (['folderId', 'favorite', 'passwordHistory', 'login.passwordRevisionDate', 'login.uris', 'fields'].includes(c)) continue;
    const v = c.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), payload);
    if (!isEnc(v)) throw new Error(`Pre-flight: "${c}" is not an EncString`);
  }
}

export function preflightCreate(payload: Record<string, unknown>, userId: string): void {
  if (!userId || payload.encryptedFor !== userId) throw new Error('Pre-flight: encryptedFor must be the user id');
  if (payload.key !== null) throw new Error('Pre-flight: new items must not have an item key');
  if (![1, 2, 3, 4].includes(payload.type as number)) throw new Error('Pre-flight: bad type');
  if (!isEnc(payload.name) || !payload.name) throw new Error('Pre-flight: name required');
  if ((payload.login as RawLogin | null)?.fido2Credentials?.length) throw new Error('Pre-flight: passkeys not allowed');
  if ('id' in payload) throw new Error('Pre-flight: id must not be set');
}

/** Comparable subset of a view: everything the user can edit. */
export function editable(v: CipherView) {
  return {
    type: v.type,
    name: v.name,
    notes: v.notes,
    folderId: v.folderId ?? null,
    favorite: v.favorite,
    login: v.login && { username: v.login.username, password: v.login.password, totp: v.login.totp, uris: v.login.uris },
    card: v.card,
    identity: v.identity,
    fields: v.fields,
  };
}

/** Post-write: decrypt what the server returned and compare with what we meant to write. */
export async function postcheck(
  returned: RawCipher,
  intended: CipherView,
  userKey: SymKey,
  original?: RawCipher,
): Promise<CipherView> {
  let got: CipherView;
  try {
    got = await decryptCipher(returned, userKey);
  } catch (e) {
    throw new Error(`Post-write check: server copy does not decrypt (${(e as Error).message})`);
  }
  const a = editable(got);
  const b = editable(intended);
  for (const k of Object.keys(b) as (keyof typeof b)[]) {
    if (!deepEqual(a[k], b[k])) throw new Error(`Post-write check: "${k}" on the server differs from what was saved`);
  }
  if (original) {
    if ((original.key ?? null) !== (returned.key ?? null)) throw new Error('Post-write check: item key changed');
    const n0 = original.login?.fido2Credentials?.length ?? 0;
    const n1 = returned.login?.fido2Credentials?.length ?? 0;
    if (n0 !== n1) throw new Error('Post-write check: passkeys were lost');
    const h0 = original.passwordHistory?.length ?? 0;
    const h1 = returned.passwordHistory?.length ?? 0;
    if (h1 < Math.min(h0, HISTORY_MAX)) throw new Error('Post-write check: password history was shortened');
  }
  return got;
}
