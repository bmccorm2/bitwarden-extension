// Read-only check against the server with the throwaway test account from .env.local.
// Usage: bun scripts/smoke.ts [--dump]
import * as api from '../src/lib/api';
import { decryptEnc, deriveMasterKey, serverHash, stretch, symKeyFromBytes } from '../src/lib/crypto';

const server = process.env.LW_SERVER ?? 'https://vault.mccormick.sh';
const email = process.env.LW_TEST_EMAIL ?? '';
const password = process.env.LW_TEST_PASSWORD ?? '';
if (!email || !password) throw new Error('LW_TEST_EMAIL / LW_TEST_PASSWORD missing in .env.local');
if (email.trim().toLowerCase() === 'bryan@mccormick.sh') throw new Error('Refusing to use the real account');

const pre = await api.prelogin(server, email);
const mk = await deriveMasterKey(password, email, pre.kdfIterations);
const tok = await api.login(server, email, await serverHash(mk, password), {
  identifier: '00000000-0000-4000-8000-00000000c11a',
  type: 2,
  name: 'chrome',
});
const userKey = symKeyFromBytes(await decryptEnc(tok.key!, await stretch(mk)));
const ctx: api.AuthCtx = { server, email, token: async () => tok.access_token, forceRefresh: async () => tok.access_token };
const s = await api.sync(ctx);
console.log('profile.email', s.profile.email.replace(/^(...).*@/, '$1***@'), 'ciphers', s.ciphers.length, 'folders', s.folders.length);
console.log('token keys', Object.keys(tok));
if (s.ciphers[0]) console.log('cipher keys', Object.keys(s.ciphers[0]));
if (process.argv.includes('--dump')) console.log(JSON.stringify(s.ciphers, null, 1));
void userKey;
