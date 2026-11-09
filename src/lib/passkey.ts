// Passkey sign-in (Decision 20): pure WebAuthn assertion helpers. No vault writes, counter always 0.

import { getDomain } from 'tldts';

const te = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;
const buf = (u: Uint8Array): Bytes => new Uint8Array(u) as Bytes;

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const GUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Raw credential ID: a GUID's 16 bytes in order, or the bytes of `b64.<base64url>`. */
export function rawCredentialId(credentialId: string): Uint8Array {
  if (credentialId.startsWith('b64.')) return fromB64url(credentialId.slice(4));
  if (!GUID.test(credentialId)) throw new Error('Unsupported credential ID');
  const hex = credentialId.replace(/-/g, '');
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

export class SecurityError extends Error {
  override name = 'SecurityError';
}

/**
 * Effective rpId for a request from `frameUrl`, or throws SecurityError. The frame must be https (or
 * http://localhost); the rpId must be its host or a parent domain, and not a public suffix.
 */
export function checkRpId(rpId: string | null | undefined, frameUrl: string): string {
  let url: URL;
  try {
    url = new URL(frameUrl);
  } catch {
    throw new SecurityError('Invalid frame URL');
  }
  const host = url.hostname;
  const localhost = host === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) throw new SecurityError('Insecure origin');
  const rp = rpId ?? host;
  if (rp !== host && !host.endsWith(`.${rp}`)) throw new SecurityError('rpId does not match the origin');
  if (!(localhost && rp === host) && getDomain(rp, { allowPrivateDomains: true }) === null) {
    throw new SecurityError('rpId is a public suffix');
  }
  return rp;
}

export interface ClientDataArgs {
  challenge: string; // base64url
  origin: string;
  crossOrigin: boolean;
  topOrigin?: string;
}

/** clientDataJSON bytes, keys in the spec's order. `topOrigin` only for cross-origin frames. */
export function clientDataJSON(a: ClientDataArgs): Uint8Array {
  const o: Record<string, unknown> = {
    type: 'webauthn.get',
    challenge: a.challenge,
    origin: a.origin,
    crossOrigin: a.crossOrigin,
  };
  if (a.crossOrigin && a.topOrigin) o.topOrigin = a.topOrigin;
  return te.encode(JSON.stringify(o));
}

/** rpIdHash (32) || flags 0x1D (UP|UV|BE|BS) || counter 0 (4, big-endian). */
export async function authenticatorData(rpId: string): Promise<Uint8Array> {
  const out = new Uint8Array(37);
  out.set(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(rpId))), 0);
  out[32] = 0x1d;
  return out;
}

function derInt(x: Uint8Array): Uint8Array {
  let i = 0;
  while (i < x.length - 1 && x[i] === 0) i++;
  const v = x.subarray(i);
  const pad = v[0]! & 0x80 ? 1 : 0;
  const out = new Uint8Array(2 + pad + v.length);
  out[0] = 0x02;
  out[1] = pad + v.length;
  out.set(v, 2 + pad);
  return out;
}

/** Web Crypto's raw r||s (64 bytes) → ASN.1 DER ECDSA-Sig-Value. */
export function rawToDer(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) throw new Error('Expected a 64-byte P-256 signature');
  const r = derInt(sig.subarray(0, 32));
  const s = derInt(sig.subarray(32));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

export interface Assertion {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** Sign an assertion with a base64url PKCS#8 P-256 private key. All outputs are base64url. */
export async function signAssertion(keyValue: string, rpId: string, client: ClientDataArgs): Promise<Assertion> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    buf(fromB64url(keyValue)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const cdj = clientDataJSON(client);
  const ad = await authenticatorData(rpId);
  const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(cdj)));
  const data = new Uint8Array(ad.length + 32);
  data.set(ad);
  data.set(cdHash, ad.length);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data));
  return { clientDataJSON: toB64url(cdj), authenticatorData: toB64url(ad), signature: toB64url(rawToDer(sig)) };
}

/** Decrypted passkey metadata (no private key). */
export interface PasskeyMeta {
  cipherId: string;
  credIndex: number;
  itemName: string;
  rpId: string;
  credentialId: string;
  userName: string;
  discoverable: string;
  counter: string;
  keyAlgorithm: string;
  keyCurve: string;
}

/** Counter-based passkeys would need a vault write to stay valid; only counter 0 is usable. */
export const usable = (p: PasskeyMeta) => Number(p.counter || '0') === 0;

/** Passkeys for `rpId`: in `allow` (base64url raw IDs) if non-empty, else discoverable only. ECDSA P-256 only. */
export function matchPasskeys(list: PasskeyMeta[], rpId: string, allow: string[]): PasskeyMeta[] {
  const allowed = new Set(allow);
  return list.filter((p) => {
    if (p.rpId !== rpId || p.keyAlgorithm !== 'ECDSA' || p.keyCurve !== 'P-256') return false;
    if (!allowed.size) return p.discoverable === 'true';
    try {
      return allowed.has(toB64url(rawCredentialId(p.credentialId)));
    } catch {
      return false;
    }
  });
}
