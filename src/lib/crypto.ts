// Bitwarden key derivation and EncString type 2 (AesCbc256_HmacSha256_B64). Web Crypto only.

export interface SymKey {
  enc: Uint8Array;
  mac: Uint8Array;
}

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

type Bytes = Uint8Array<ArrayBuffer>;
const buf = (u: Uint8Array): Bytes => new Uint8Array(u) as Bytes;

export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(s: string): string {
  return b64encode(te.encode(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', buf(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hmac(key: Uint8Array, data: Uint8Array, hash = 'SHA-256'): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, buf(data)));
}

// Imported CryptoKeys, cached per raw key array (decrypting a vault does thousands of operations).
const macKeys = new WeakMap<Uint8Array, Promise<CryptoKey>>();
const aesKeys = new WeakMap<Uint8Array, Promise<CryptoKey>>();

function macKey(raw: Uint8Array): Promise<CryptoKey> {
  let k = macKeys.get(raw);
  if (!k) macKeys.set(raw, (k = subtle().importKey('raw', buf(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])));
  return k;
}

function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  let k = aesKeys.get(raw);
  if (!k) aesKeys.set(raw, (k = subtle().importKey('raw', buf(raw), 'AES-CBC', false, ['encrypt', 'decrypt'])));
  return k;
}

async function mac(key: SymKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign('HMAC', await macKey(key.mac), buf(data)));
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function deriveMasterKey(password: string, email: string, iterations: number): Promise<Uint8Array> {
  return pbkdf2(te.encode(password), te.encode(normalizeEmail(email)), iterations);
}

export async function serverHash(masterKey: Uint8Array, password: string): Promise<string> {
  return b64encode(await pbkdf2(masterKey, te.encode(password), 1));
}

/** HKDF-Expand only (no extract), 32 bytes each: T(1) = HMAC(prk, info || 0x01). */
export async function stretch(masterKey: Uint8Array): Promise<SymKey> {
  const expand = (info: string) => hmac(masterKey, concat(te.encode(info), new Uint8Array([1])));
  return { enc: await expand('enc'), mac: await expand('mac') };
}

export function symKeyFromBytes(bytes: Uint8Array): SymKey {
  if (bytes.length !== 64) throw new Error(`Expected 64-byte key, got ${bytes.length}`);
  return { enc: bytes.slice(0, 32), mac: bytes.slice(32, 64) };
}

export function symKeyToBytes(key: SymKey): Uint8Array {
  return concat(key.enc, key.mac);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function decryptEnc(enc: string, key: SymKey): Promise<Uint8Array> {
  const dot = enc.indexOf('.');
  if (dot < 0 || enc.slice(0, dot) !== '2') throw new Error('Unsupported EncString type');
  const parts = enc.slice(dot + 1).split('|');
  if (parts.length !== 3) throw new Error('Malformed EncString');
  const [iv, ct, tag] = parts.map(b64decode) as [Uint8Array, Uint8Array, Uint8Array];
  const expected = await mac(key, concat(iv, ct));
  if (!constantTimeEqual(expected, tag)) throw new Error('EncString MAC mismatch');
  return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv: buf(iv) }, await aesKey(key.enc), buf(ct)));
}

export async function decryptStr(enc: string, key: SymKey): Promise<string> {
  return td.decode(await decryptEnc(enc, key));
}

export async function encryptBytes(bytes: Uint8Array, key: SymKey): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv }, await aesKey(key.enc), buf(bytes)));
  const tag = await mac(key, concat(iv, ct));
  return `2.${b64encode(iv)}|${b64encode(ct)}|${b64encode(tag)}`;
}

export async function sha256B64(s: string): Promise<string> {
  return b64encode(new Uint8Array(await subtle().digest('SHA-256', te.encode(s))));
}

export function encryptStr(plain: string, key: SymKey): Promise<string> {
  return encryptBytes(te.encode(plain), key);
}
