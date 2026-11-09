import { describe, expect, it } from 'vitest';
import {
  buildCreate,
  buildUpdate,
  decryptCipher,
  decryptRow,
  postcheck,
  preflight,
  preflightCreate,
} from '../src/lib/cipher';
import { decryptStr, encryptBytes, encryptStr, symKeyFromBytes, type SymKey } from '../src/lib/crypto';
import type { CipherView, RawCipher } from '../src/lib/types';

const UID = 'user-1';
const userKey = symKeyFromBytes(new Uint8Array(64).map((_, i) => i + 1));
const itemKeyBytes = new Uint8Array(64).map((_, i) => 200 - i);
const itemKey = symKeyFromBytes(itemKeyBytes);

const e = (s: string, k: SymKey = userKey) => encryptStr(s, k);

async function loginFixture(opts: { perItemKey?: boolean; passkeys?: boolean; history?: number } = {}): Promise<RawCipher> {
  const k = opts.perItemKey ? itemKey : userKey;
  const history = [];
  for (let i = 0; i < (opts.history ?? 0); i++) {
    history.push({ password: await e(`old${i}`, k), lastUsedDate: `2025-01-0${i + 1}T00:00:00.000Z` });
  }
  return {
    object: 'cipherDetails',
    id: '11111111-2222-4333-8444-555555555555',
    type: 1,
    folderId: null,
    organizationId: null,
    name: await e('Example', k),
    notes: await e('some notes', k),
    favorite: false,
    reprompt: 1,
    key: opts.perItemKey ? await encryptBytes(itemKeyBytes, userKey) : null,
    login: {
      username: await e('alice', k),
      password: await e('hunter2', k),
      totp: null,
      passwordRevisionDate: null,
      uri: await e('https://example.com', k),
      uris: [{ uri: await e('https://example.com', k), match: null, uriChecksum: await e('checksum', k) }],
      fido2Credentials: opts.passkeys
        ? [{ credentialId: await e('cred', k), keyValue: await e('pk', k), creationDate: '2025-05-01T00:00:00Z', counter: await e('0', k) }]
        : null,
      futureLoginField: { nested: [1, 2, 3] },
    },
    card: null,
    identity: null,
    secureNote: null,
    sshKey: null,
    fields: [{ type: 1, name: await e('pin', k), value: await e('1234', k), linkedId: null }],
    passwordHistory: history.length ? history : null,
    attachments: null,
    archivedDate: null,
    unknownTopLevel: 'keep-me',
    revisionDate: '2025-06-01T12:00:00.000Z',
    creationDate: '2025-01-01T00:00:00.000Z',
    deletedDate: null,
    edit: true,
    viewPassword: true,
  } as RawCipher;
}

async function edit(raw: RawCipher, f: (v: CipherView) => void) {
  const before = await decryptCipher(raw, userKey);
  const after = structuredClone(before);
  f(after);
  const plan = await buildUpdate(raw, before, after, userKey, new Date('2026-01-01T00:00:00Z'));
  (plan.payload as Record<string, unknown>).encryptedFor = UID;
  return { before, after, plan };
}

describe('decrypt', () => {
  it('uses the per-item key for every field', async () => {
    const raw = await loginFixture({ perItemKey: true, passkeys: true, history: 2 });
    const v = await decryptCipher(raw, userKey);
    expect(v).toMatchObject({ name: 'Example', notes: 'some notes', hasPerItemKey: true, reprompt: 1 });
    expect(v.login).toMatchObject({ username: 'alice', password: 'hunter2', passkeys: ['2025-05-01T00:00:00Z'] });
    expect(v.fields).toEqual([{ name: 'pin', value: '1234', type: 1, linkedId: null }]);
    expect(v.passwordHistory.map((h) => h.password)).toEqual(['old0', 'old1']);
    const row = await decryptRow(raw, userKey);
    expect(row).toMatchObject({ name: 'Example', username: 'alice', uri: 'https://example.com', deleted: false });
  });

  it('row decryption is lenient', async () => {
    const raw = await loginFixture();
    raw.name = 'garbage';
    expect((await decryptRow(raw, userKey)).name).toBe('[decryption error]');
    await expect(decryptCipher(raw, userKey)).rejects.toThrow();
  });
});

describe('buildUpdate + preflight', () => {
  it('passes unedited fields through untouched (passkeys, key, unknown fields)', async () => {
    for (const opts of [{ passkeys: true }, { perItemKey: true, passkeys: true }, { history: 3 }]) {
      const raw = await loginFixture(opts);
      const { plan } = await edit(raw, (v) => (v.name = 'Renamed'));
      expect([...plan.changed]).toEqual(['name']);
      preflight(raw, plan.payload, plan.changed, UID);
      const { name, lastKnownRevisionDate, encryptedFor: _e, ...rest } = plan.payload as typeof plan.payload & { encryptedFor: string };
      const { name: _n, ...origRest } = raw;
      expect(rest).toEqual(origRest);
      expect(lastKnownRevisionDate).toBe(raw.revisionDate);
      const k = opts.perItemKey ? itemKey : userKey;
      expect(await decryptStr(name!, k)).toBe('Renamed');
    }
  });

  it('no-op edit produces an identical payload', async () => {
    const raw = await loginFixture({ passkeys: true, perItemKey: true });
    const { plan } = await edit(raw, () => {});
    expect(plan.changed.size).toBe(0);
    const { lastKnownRevisionDate: _, encryptedFor: _e, ...rest } = plan.payload as typeof plan.payload & { encryptedFor: string };
    expect(rest).toEqual(raw);
    preflight(raw, plan.payload, plan.changed, UID);
  });

  it('password change prepends history (max 5) and sets revision date', async () => {
    const raw = await loginFixture({ perItemKey: true, history: 5, passkeys: true });
    const { plan, after } = await edit(raw, (v) => (v.login!.password = 'newpass'));
    preflight(raw, plan.payload, plan.changed, UID);
    const h = plan.payload.passwordHistory!;
    expect(h).toHaveLength(5);
    expect(await decryptStr(h[0]!.password, itemKey)).toBe('hunter2');
    expect(h[0]!.lastUsedDate).toBe('2026-01-01T00:00:00.000Z');
    expect(h.slice(1)).toEqual(raw.passwordHistory!.slice(0, 4));
    expect(plan.payload.login!.passwordRevisionDate).toBe('2026-01-01T00:00:00.000Z');
    expect(plan.payload.login!.fido2Credentials).toEqual(raw.login!.fido2Credentials);
    // Server echo → post-check passes.
    const returned = structuredClone(plan.payload) as RawCipher;
    await postcheck(returned, after, userKey, raw);
  });

  it('history grows from empty', async () => {
    const raw = await loginFixture();
    const { plan } = await edit(raw, (v) => (v.login!.password = 'x'));
    preflight(raw, plan.payload, plan.changed, UID);
    expect(plan.payload.passwordHistory).toHaveLength(1);
  });

  it('uri edits keep unchanged entries and refresh legacy uri', async () => {
    const raw = await loginFixture({ perItemKey: true });
    const { plan } = await edit(raw, (v) => v.login!.uris.unshift({ uri: 'https://new.example.com', match: 1 }));
    preflight(raw, plan.payload, plan.changed, UID);
    const uris = plan.payload.login!.uris!;
    expect(uris).toHaveLength(2);
    expect(uris[1]).toEqual(raw.login!.uris![0]);
    expect(await decryptStr(uris[0]!.uri!, itemKey)).toBe('https://new.example.com');
    expect(uris[0]!.match).toBe(1);
    expect(plan.payload.login!.uri).toBe(uris[0]!.uri);
  });

  it('custom field edits', async () => {
    const raw = await loginFixture();
    const { plan } = await edit(raw, (v) => v.fields.push({ name: 'flag', value: 'true', type: 2, linkedId: null }));
    preflight(raw, plan.payload, plan.changed, UID);
    expect(plan.payload.fields![0]).toEqual(raw.fields![0]);
    expect(plan.payload.fields).toHaveLength(2);
  });

  it('cleared field becomes null', async () => {
    const raw = await loginFixture();
    const { plan } = await edit(raw, (v) => (v.notes = ''));
    preflight(raw, plan.payload, plan.changed, UID);
    expect(plan.payload.notes).toBeNull();
  });
});

describe('preflight rejects data loss', () => {
  it('wrong or missing encryptedFor', async () => {
    const raw = await loginFixture();
    const { plan } = await edit(raw, (v) => (v.name = 'x'));
    expect(() => preflight(raw, plan.payload, plan.changed, 'someone-else')).toThrow(/encryptedFor/);
    expect(() => preflightCreate({ key: null, type: 1, name: '2.a|b|c' }, UID)).toThrow(/encryptedFor/);
  });

  it('dropped passkeys', async () => {
    const raw = await loginFixture({ passkeys: true });
    const { plan } = await edit(raw, (v) => (v.name = 'x'));
    delete plan.payload.login!.fido2Credentials;
    expect(() => preflight(raw, plan.payload, plan.changed, UID)).toThrow(/fido2Credentials|passkeys/);
  });

  it('changed passkeys even if marked changed', async () => {
    const raw = await loginFixture({ passkeys: true });
    const { plan } = await edit(raw, (v) => (v.name = 'x'));
    plan.payload.login!.fido2Credentials = [];
    expect(() => preflight(raw, plan.payload, new Set([...plan.changed, 'login.fido2Credentials']), UID)).toThrow(/protected/);
  });

  it('dropped item key', async () => {
    const raw = await loginFixture({ perItemKey: true });
    const { plan } = await edit(raw, (v) => (v.name = 'x'));
    plan.payload.key = null;
    expect(() => preflight(raw, plan.payload, plan.changed, UID)).toThrow(/key/);
  });

  it('shortened history', async () => {
    const raw = await loginFixture({ history: 3 });
    const { plan } = await edit(raw, (v) => (v.login!.password = 'new'));
    plan.payload.passwordHistory = plan.payload.passwordHistory!.slice(0, 2);
    expect(() => preflight(raw, plan.payload, plan.changed, UID)).toThrow(/history/);
    const p2 = await edit(raw, (v) => (v.name = 'n'));
    p2.plan.payload.passwordHistory = raw.passwordHistory!.slice(1);
    expect(() => preflight(raw, p2.plan.payload, p2.plan.changed, UID)).toThrow(/passwordHistory/);
  });

  it('unedited field modified or unknown field dropped', async () => {
    const raw = await loginFixture();
    const a = await edit(raw, (v) => (v.name = 'x'));
    a.plan.payload.notes = await e('tampered');
    expect(() => preflight(raw, a.plan.payload, a.plan.changed, UID)).toThrow(/notes/);
    const b = await edit(raw, (v) => (v.name = 'x'));
    delete (b.plan.payload as Record<string, unknown>).unknownTopLevel;
    expect(() => preflight(raw, b.plan.payload, b.plan.changed, UID)).toThrow(/unknownTopLevel/);
    const c = await edit(raw, (v) => (v.name = 'x'));
    delete (c.plan.payload.login as Record<string, unknown>).futureLoginField;
    expect(() => preflight(raw, c.plan.payload, c.plan.changed, UID)).toThrow(/futureLoginField/);
  });

  it('field encrypted with the wrong key is caught by postcheck', async () => {
    const raw = await loginFixture({ perItemKey: true });
    const { plan, after } = await edit(raw, (v) => (v.name = 'x'));
    plan.payload.name = await e('x', userKey); // wrong key
    await expect(postcheck(plan.payload as RawCipher, after, userKey, raw)).rejects.toThrow(/decrypt/);
  });

  it('postcheck catches lost passkeys and value mismatch', async () => {
    const raw = await loginFixture({ passkeys: true });
    const { plan, after } = await edit(raw, (v) => (v.name = 'x'));
    const r1 = structuredClone(plan.payload) as RawCipher;
    r1.login!.fido2Credentials = null;
    await expect(postcheck(r1, after, userKey, raw)).rejects.toThrow(/passkeys/);
    const r2 = structuredClone(plan.payload) as RawCipher;
    r2.name = await e('other');
    await expect(postcheck(r2, after, userKey, raw)).rejects.toThrow(/name/);
  });
});

describe('buildCreate', () => {
  it('builds a login without item key', async () => {
    const { emptyView } = await import('../src/lib/cipher');
    const v = emptyView(1);
    v.name = 'New';
    v.login!.username = 'bob';
    v.login!.password = 'pw';
    v.login!.uris = [{ uri: 'https://x.com', match: null }];
    const p = await buildCreate(v, userKey);
    preflightCreate({ ...p, encryptedFor: UID }, UID);
    expect(p.key).toBeNull();
    const back = await decryptCipher({ ...(p as unknown as RawCipher), id: 'n', revisionDate: 'r' }, userKey);
    expect(back.login).toMatchObject({ username: 'bob', password: 'pw', uris: [{ uri: 'https://x.com', match: null }] });
    expect(back.passwordHistory).toEqual([]);
  });

  it('builds a secure note with secureNote.type 0', async () => {
    const { emptyView } = await import('../src/lib/cipher');
    const v = emptyView(2);
    v.name = 'Note';
    v.notes = 'body';
    const p = await buildCreate(v, userKey);
    preflightCreate({ ...p, encryptedFor: UID }, UID);
    expect(p.secureNote).toEqual({ type: 0 });
  });
});
