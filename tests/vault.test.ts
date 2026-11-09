import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { decryptCipher } from '../src/lib/cipher';
import { b64encode, decryptStr, encryptBytes, encryptStr, symKeyFromBytes, symKeyToBytes } from '../src/lib/crypto';
import * as session from '../src/lib/session';
import type { RawCipher } from '../src/lib/types';
import * as vault from '../src/lib/vault';

const WRITER = 'writer@lightwarden.invalid';
const ID = '11111111-2222-4333-8444-555555555555';
const userKey = symKeyFromBytes(new Uint8Array(64).map((_, i) => (i * 7) % 256));
const itemBytes = new Uint8Array(64).map((_, i) => 255 - i);
const itemKey = symKeyFromBytes(itemBytes);

async function fixture(): Promise<RawCipher> {
  const e = (s: string) => encryptStr(s, itemKey);
  return {
    id: ID,
    type: 1,
    folderId: null,
    name: await e('Keyed with passkey'),
    notes: null,
    favorite: false,
    reprompt: 0,
    key: await encryptBytes(itemBytes, userKey),
    login: {
      username: await e('alice'),
      password: await e('old-pw'),
      totp: null,
      uris: [{ uri: await e('https://example.com'), match: null }],
      fido2Credentials: [{ credentialId: await e('cred'), creationDate: '2025-01-01T00:00:00Z' }],
    },
    passwordHistory: [{ password: await e('older'), lastUsedDate: '2024-01-01T00:00:00Z' }],
    revisionDate: '2026-01-01T00:00:00.000Z',
    archivedDate: null,
    someFutureField: { a: 1 },
  } as RawCipher;
}

async function setup(email = WRITER) {
  const raw = await fixture();
  await session.saveCache({
    server: 'https://vault.example',
    email,
    kdf: { kdf: 0, iterations: 1000 },
    sync: { profile: { id: 'user-uuid', email, key: 'unused' }, folders: [], ciphers: [raw] },
    lastSync: Date.now(),
  });
  await fakeBrowser.storage.session.set({
    userKey: b64encode(symKeyToBytes(userKey)),
    account: { server: 'https://vault.example', email },
    tokens: { access: 'tok', refresh: 'r', expiresAt: Date.now() + 3600_000 },
  });
  return raw;
}

describe('vault write path', () => {
  const calls: { method: string; url: string; body: any }[] = [];
  beforeEach(() => {
    fakeBrowser.reset();
    vault.clearIndex();
    session.forgetCacheMemory();
    calls.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  // Fake server: echoes the PUT body back like Vaultwarden does (with a new revision date).
  function stubServer(override?: (body: any) => Response) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ method: init.method!, url, body });
        if (override) return override(body);
        const { lastKnownRevisionDate: _, encryptedFor: _e, ...rest } = body;
        return new Response(JSON.stringify({ ...rest, revisionDate: '2026-02-02T00:00:00.000Z' }), { status: 200 });
      }),
    );
  }

  it('password update keeps passkeys, item key, unknown fields; adds history; saves undo', async () => {
    const raw = await setup();
    stubServer();
    const view = await vault.getItem(ID);
    view.login!.password = 'new-pw';
    const saved = await vault.save(view);
    expect(saved.login!.password).toBe('new-pw');
    expect(calls).toHaveLength(1);
    const { method, url, body } = calls[0]!;
    expect(method).toBe('PUT');
    expect(url).toBe(`https://vault.example/api/ciphers/${ID}`);
    expect(body.key).toBe(raw.key);
    expect(body.login.fido2Credentials).toEqual(raw.login!.fido2Credentials);
    expect(body.someFutureField).toEqual({ a: 1 });
    expect(body.lastKnownRevisionDate).toBe(raw.revisionDate);
    expect(body.encryptedFor).toBe('user-uuid');
    expect(body.passwordHistory).toHaveLength(2);
    expect(await decryptStr(body.passwordHistory[0].password, itemKey)).toBe('old-pw');
    expect(body.passwordHistory[1]).toEqual(raw.passwordHistory![0]);
    // Undo has the untouched original; cache has the server copy.
    expect((await vault.latestUndo(ID))?.cipher).toEqual(raw);
    const cached = (await session.getCache())!.sync.ciphers[0]!;
    expect(cached.revisionDate).toBe('2026-02-02T00:00:00.000Z');
    expect((await decryptCipher(cached, userKey)).login!.password).toBe('new-pw');
  });

  it('no-op save sends nothing', async () => {
    await setup();
    stubServer();
    await vault.save(await vault.getItem(ID));
    expect(calls).toHaveLength(0);
  });

  it('post-write check flags a server copy that lost the passkey', async () => {
    await setup();
    stubServer((body) => {
      const { lastKnownRevisionDate: _, encryptedFor: _e, ...rest } = body;
      rest.login.fido2Credentials = null;
      return new Response(JSON.stringify({ ...rest, revisionDate: 'x' }), { status: 200 });
    });
    const view = await vault.getItem(ID);
    view.name = 'Renamed';
    await expect(vault.save(view)).rejects.toThrow(/passkeys were lost.*undo store/);
    expect(await vault.latestUndo(ID)).not.toBeNull();
  });

  it('out-of-date conflict → friendly error', async () => {
    await setup();
    stubServer((b) =>
      b
        ? new Response(JSON.stringify({ message: 'The client copy of this cipher is out of date. Resync the client and try again.' }), { status: 400 })
        : new Response('{}', { status: 500 }),
    );
    const view = await vault.getItem(ID);
    view.name = 'x';
    await expect(vault.save(view)).rejects.toThrow('Item changed elsewhere; reloaded. Re-apply your edit.');
  });

  it('stale view is refused before any request', async () => {
    await setup();
    stubServer();
    const view = await vault.getItem(ID);
    view.revisionDate = '2020-01-01T00:00:00.000Z';
    view.name = 'x';
    await expect(vault.save(view)).rejects.toThrow(/changed elsewhere/);
    expect(calls).toHaveLength(0);
  });

  it('write lock blocks other accounts before any request', async () => {
    await setup('bryan@mccormick.sh');
    stubServer();
    const view = await vault.getItem(ID);
    view.name = 'x';
    await expect(vault.save(view)).rejects.toThrow(/write lock/);
    await expect(vault.trash(ID)).rejects.toThrow(/write lock/);
    expect(calls).toHaveLength(0);
  });

  it('revert writes the undo copy back', async () => {
    const raw = await setup();
    stubServer();
    const view = await vault.getItem(ID);
    view.name = 'Renamed';
    await vault.save(view);
    const reverted = await vault.revert(ID);
    expect(reverted.name).toBe('Keyed with passkey');
    const body = calls[1]!.body;
    expect(body.name).toBe(raw.name);
    expect(body.login.fido2Credentials).toEqual(raw.login!.fido2Credentials);
    expect(body.lastKnownRevisionDate).toBe('2026-02-02T00:00:00.000Z');
  });
});
