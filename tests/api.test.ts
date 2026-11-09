import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/lib/api';

const ID = '11111111-2222-4333-8444-555555555555';

describe('endpoint allowlist', () => {
  it('allows exactly the protocol endpoints', () => {
    for (const [m, p] of [
      ['POST', '/identity/accounts/prelogin'],
      ['POST', '/identity/connect/token'],
      ['GET', '/api/sync?excludeDomains=true'],
      ['POST', '/api/ciphers'],
      ['PUT', `/api/ciphers/${ID}`],
      ['PUT', `/api/ciphers/${ID}/delete`],
      ['PUT', `/api/ciphers/${ID}/restore`],
    ] as const) {
      expect(() => api.assertAllowed(m, p)).not.toThrow();
    }
  });

  it('blocks everything else', () => {
    for (const [m, p] of [
      ['DELETE', `/api/ciphers/${ID}`], // permanent delete
      ['PUT', `/api/ciphers/${ID}/delete-admin`],
      ['DELETE', `/api/ciphers/${ID}/admin`],
      ['POST', '/api/ciphers/purge'],
      ['POST', '/api/ciphers/delete'], // bulk
      ['PUT', '/api/ciphers/delete'],
      ['PUT', '/api/ciphers/restore'],
      ['POST', '/api/ciphers/import'],
      ['POST', '/api/ciphers/move'],
      ['PUT', '/api/ciphers/purge'],
      ['POST', '/api/folders'],
      ['PUT', `/api/folders/${ID}`],
      ['DELETE', `/api/folders/${ID}`],
      ['POST', '/api/accounts/password'],
      ['POST', '/api/accounts/delete'],
      ['DELETE', '/api/accounts'],
      ['POST', '/api/accounts/kdf'],
      ['GET', '/api/organizations'],
      ['POST', '/api/organizations'],
      ['GET', '/admin'],
      ['POST', '/admin/users/x/delete'],
      ['GET', '/api/sync'],
      ['GET', '/api/sync?excludeDomains=false'],
      ['POST', '/api/sync?excludeDomains=true'],
      ['PUT', '/api/ciphers/not-a-uuid'],
      ['PUT', `/api/ciphers/${ID}/../purge`],
      ['PUT', `/api/ciphers/${ID}/share`],
      ['POST', `/api/ciphers/${ID}/attachment/v2`],
      ['GET', '/api/config'],
    ] as const) {
      expect(() => api.assertAllowed(m, p), `${m} ${p}`).toThrow(/allowlist/);
    }
  });
});

describe('network guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  const ctx = (email: string): api.AuthCtx => ({
    server: 'https://vault.example',
    email,
    token: async () => 't',
    forceRefresh: async () => 't2',
  });

  it('blocked writes never reach fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    // vitest.config.ts sets the dev write lock to writer@lightwarden.invalid only.
    await expect(api.createCipher(ctx('someone@example.com'), {})).rejects.toThrow(/write lock/);
    await expect(api.updateCipher(ctx('someone@example.com'), ID, {})).rejects.toThrow(/write lock/);
    await expect(api.trashCipher(ctx('someone@example.com'), ID)).rejects.toThrow(/write lock/);
    await expect(api.restoreCipher(ctx('someone@example.com'), ID)).rejects.toThrow(/write lock/);
    await expect(api.updateCipher(ctx('x@y.z'), 'purge', {})).rejects.toThrow(/allowlist/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('write lock only admits the test account in dev builds', () => {
    const dev = { release: false, testEmail: 'Test@Example.com' };
    expect(api.writesAllowedFor(' test@example.com ', dev)).toBe(true);
    expect(api.writesAllowedFor('bryan@mccormick.sh', dev)).toBe(false);
    expect(api.writesAllowedFor('bryan@mccormick.sh', { release: false, testEmail: '' })).toBe(false);
    expect(api.writesAllowedFor('bryan@mccormick.sh', { release: true, testEmail: '' })).toBe(true);
  });

  it('retries once on 401 with a refreshed token', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const auth = (init.headers as Record<string, string>).Authorization!;
        calls.push(auth);
        if (auth === 'Bearer t') return new Response('', { status: 401 });
        return new Response(JSON.stringify({ Profile: { Key: 'k' }, Folders: [], Ciphers: [] }), { status: 200 });
      }),
    );
    const s = await api.sync(ctx('a@b.c'));
    expect(calls).toEqual(['Bearer t', 'Bearer t2']);
    expect(s.profile.key).toBe('k'); // keys normalized to camelCase
  });

  it('reports Cloudflare challenges', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>challenge</html>', { status: 403 })));
    await expect(api.prelogin('https://vault.example', 'a@b.c')).rejects.toThrow(/Cloudflare/);
  });

  it('maps 400 login to bad password', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Username or password is incorrect.' }), { status: 400 })),
    );
    await expect(api.login('https://v', 'a@b.c', 'h', { identifier: 'd', type: 2, name: 'chrome' })).rejects.toThrow(
      'Invalid email or master password',
    );
  });
});
