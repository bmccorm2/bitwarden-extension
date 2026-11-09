// Seeds the throwaway TEST account with items the extension can't create itself
// (passkeys, per-item keys), so edits can be checked against them. Test account only.
// Usage: bun scripts/seed-test.ts
import type { AuthCtx } from '../src/lib/api';
import { decryptEnc, deriveMasterKey, encryptBytes, encryptStr, serverHash, stretch, symKeyFromBytes, type SymKey } from '../src/lib/crypto';

const server = process.env.LW_SERVER ?? 'https://vault.mccormick.sh';
const email = (process.env.LW_TEST_EMAIL ?? '').trim().toLowerCase();
const password = process.env.LW_TEST_PASSWORD ?? '';
if (!email || !password) throw new Error('LW_TEST_EMAIL / LW_TEST_PASSWORD missing in .env.local');
if (email === 'bryan@mccormick.sh' || !email.includes('lwtest')) throw new Error('Refusing: not the test account');

// The api module's write lock admits only this email.
(globalThis as Record<string, unknown>).__LW_WRITE_LOCK__ = { release: false, testEmail: email };
const api = await import('../src/lib/api');

const pre = await api.prelogin(server, email);
const mk = await deriveMasterKey(password, email, pre.kdfIterations);
const tok = await api.login(server, email, await serverHash(mk, password), {
  identifier: '00000000-0000-4000-8000-00000000c11a',
  type: 2,
  name: 'chrome',
});
const userKey = symKeyFromBytes(await decryptEnc(tok.key!, await stretch(mk)));
const ctx: AuthCtx = { server, email, token: async () => tok.access_token, forceRefresh: async () => tok.access_token };

const existing = await api.sync(ctx);
const names = new Set<string>();
for (const c of existing.ciphers) {
  try {
    const k = c.key ? symKeyFromBytes(await decryptEnc(c.key, userKey)) : userKey;
    names.add(new TextDecoder().decode(await decryptEnc(c.name!, k)));
  } catch {}
}

async function passkey(k: SymKey) {
  const e = (s: string) => encryptStr(s, k);
  return {
    credentialId: await e('b64-cred-' + crypto.randomUUID()),
    keyType: await e('public-key'),
    keyAlgorithm: await e('ECDSA'),
    keyCurve: await e('P-256'),
    keyValue: await e('fake-private-key-material'),
    rpId: await e('passkey.example.com'),
    userHandle: await e('dXNlcg'),
    userName: await e('pk-user'),
    counter: await e('0'),
    rpName: await e('Passkey Example'),
    userDisplayName: await e('PK User'),
    discoverable: await e('true'),
    creationDate: '2025-04-01T10:00:00.000Z',
  };
}

async function login(name: string, k: SymKey, itemKey: string | null, opts: { passkey?: boolean; history?: string[]; uri: string; totp?: string }) {
  if (names.has(name)) return console.log('exists:', name);
  const e = (s: string) => encryptStr(s, k);
  const body = {
    encryptedFor: existing.profile.id,
    type: 1,
    folderId: null,
    name: await e(name),
    notes: await e('seeded by scripts/seed-test.ts'),
    favorite: false,
    reprompt: 0,
    key: itemKey,
    login: {
      username: await e(name.toLowerCase().replace(/\W+/g, '-')),
      password: await e('seed-password-1'),
      totp: opts.totp ? await e(opts.totp) : null,
      uris: [{ uri: await e(opts.uri), match: null }],
      fido2Credentials: opts.passkey ? [await passkey(k)] : null,
    },
    fields: [{ type: 1, name: await e('pin'), value: await e('4321'), linkedId: null }],
    passwordHistory: await Promise.all(
      (opts.history ?? []).map(async (p, i) => ({ password: await e(p), lastUsedDate: `2025-0${i + 1}-01T00:00:00.000Z` })),
    ),
  };
  const r = await api.createCipher(ctx, body);
  console.log('created:', name, r.id, 'key:', !!r.key, 'fido2:', r.login?.fido2Credentials?.length ?? 0);
}

await login('Seed passkey', userKey, null, { passkey: true, history: ['h1'], uri: 'https://passkey.example.com' });
const ik = crypto.getRandomValues(new Uint8Array(64));
await login('Seed keyed', symKeyFromBytes(ik), await encryptBytes(ik, userKey), {
  passkey: true,
  history: ['k1', 'k2', 'k3', 'k4', 'k5'],
  uri: 'https://keyed.example.com',
  totp: 'JBSWY3DPEHPK3PXP',
});
await login('Local A', userKey, null, { uri: 'http://localhost:8765', totp: 'JBSWY3DPEHPK3PXP' });
await login('Local B', userKey, null, { uri: 'http://localhost:8765' });
