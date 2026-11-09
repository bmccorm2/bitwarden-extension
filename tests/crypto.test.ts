import { describe, expect, it } from 'vitest';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import {
  b64decode,
  b64encode,
  decryptEnc,
  decryptStr,
  deriveMasterKey,
  encryptBytes,
  encryptStr,
  serverHash,
  stretch,
  symKeyFromBytes,
} from '../src/lib/crypto';

const key = symKeyFromBytes(new Uint8Array(64).map((_, i) => i));

describe('crypto', () => {
  it('round-trips strings and bytes', async () => {
    const enc = await encryptStr('héllo wörld 🔐', key);
    expect(enc.startsWith('2.')).toBe(true);
    expect(await decryptStr(enc, key)).toBe('héllo wörld 🔐');
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    expect(await decryptEnc(await encryptBytes(bytes, key), key)).toEqual(bytes);
    expect(await decryptStr(await encryptStr('', key), key)).toBe('');
  });

  it('throws on tampered MAC', async () => {
    const enc = await encryptStr('secret', key);
    const [head, ct, mac] = enc.split('|') as [string, string, string];
    const m = b64decode(mac);
    m[0]! ^= 1;
    await expect(decryptStr(`${head}|${ct}|${b64encode(m)}`, key)).rejects.toThrow(/MAC/);
  });

  it('throws on tampered ciphertext', async () => {
    const enc = await encryptStr('secret', key);
    const [head, ct, mac] = enc.split('|') as [string, string, string];
    const c = b64decode(ct);
    c[0]! ^= 1;
    await expect(decryptStr(`${head}|${b64encode(c)}|${mac}`, key)).rejects.toThrow(/MAC/);
  });

  it('throws on wrong type prefix', async () => {
    const enc = await encryptStr('secret', key);
    await expect(decryptStr('0' + enc.slice(1), key)).rejects.toThrow(/type/);
    await expect(decryptStr('4' + enc.slice(1), key)).rejects.toThrow(/type/);
    await expect(decryptStr('nodot', key)).rejects.toThrow();
  });

  it('wrong key fails', async () => {
    const enc = await encryptStr('secret', key);
    const other = symKeyFromBytes(new Uint8Array(64).fill(7));
    await expect(decryptStr(enc, other)).rejects.toThrow(/MAC/);
  });

  it('stretch matches manual HKDF-Expand', async () => {
    const mk = new Uint8Array(32).map((_, i) => i * 3);
    const s = await stretch(mk);
    const manual = (info: string) =>
      new Uint8Array(createHmac('sha256', mk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest());
    expect(s.enc).toEqual(manual('enc'));
    expect(s.mac).toEqual(manual('mac'));
  });

  it('PBKDF2 master key and server hash match node', async () => {
    const mk = await deriveMasterKey('correct horse', '  Test@Example.COM ', 5000);
    const expected = pbkdf2Sync('correct horse', 'test@example.com', 5000, 32, 'sha256');
    expect(mk).toEqual(new Uint8Array(expected));
    const hash = await serverHash(mk, 'correct horse');
    expect(hash).toBe(pbkdf2Sync(expected, 'correct horse', 1, 32, 'sha256').toString('base64'));
  });

  it('symKeyFromBytes rejects wrong length', () => {
    expect(() => symKeyFromBytes(new Uint8Array(32))).toThrow();
  });
});
