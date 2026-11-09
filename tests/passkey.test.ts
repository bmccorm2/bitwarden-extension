import { describe, expect, it } from 'vitest';
import {
  authenticatorData,
  checkRpId,
  clientDataJSON,
  fromB64url,
  matchPasskeys,
  rawCredentialId,
  rawToDer,
  signAssertion,
  toB64url,
  type PasskeyMeta,
} from '@/lib/passkey';

const td = new TextDecoder();
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('rawCredentialId', () => {
  it('GUID → 16 bytes in order', () => {
    expect(hex(rawCredentialId('01234567-89ab-cdef-0123-456789ABCDEF'))).toBe('0123456789abcdef0123456789abcdef');
  });
  it('b64. → decoded bytes', () => {
    expect([...rawCredentialId('b64.AQID_w')]).toEqual([1, 2, 3, 255]);
  });
  it('rejects anything else', () => {
    expect(() => rawCredentialId('nope')).toThrow();
  });
});

describe('checkRpId', () => {
  it('defaults to the frame host', () => {
    expect(checkRpId(undefined, 'https://login.example.com/x')).toBe('login.example.com');
  });
  it('allows the same host or a parent domain', () => {
    expect(checkRpId('login.example.com', 'https://login.example.com')).toBe('login.example.com');
    expect(checkRpId('example.com', 'https://a.login.example.com')).toBe('example.com');
    expect(checkRpId('example.co.uk', 'https://login.example.co.uk')).toBe('example.co.uk');
  });
  it('rejects public suffixes', () => {
    expect(() => checkRpId('com', 'https://example.com')).toThrow(/public suffix/);
    expect(() => checkRpId('co.uk', 'https://example.co.uk')).toThrow(/public suffix/);
    expect(() => checkRpId('github.io', 'https://me.github.io')).toThrow(/public suffix/);
  });
  it('rejects unrelated domains and lookalikes', () => {
    expect(() => checkRpId('evil.com', 'https://example.com')).toThrow(/does not match/);
    expect(() => checkRpId('ample.com', 'https://example.com')).toThrow(/does not match/);
    expect(() => checkRpId('a.example.com', 'https://example.com')).toThrow(/does not match/);
  });
  it('rejects http except localhost', () => {
    expect(() => checkRpId('example.com', 'http://example.com')).toThrow(/Insecure/);
    expect(() => checkRpId(undefined, 'about:blank')).toThrow();
    expect(checkRpId(undefined, 'http://localhost:8080/')).toBe('localhost');
  });
  it('throws a SecurityError', () => {
    try {
      checkRpId('evil.com', 'https://example.com');
    } catch (e) {
      expect((e as Error).name).toBe('SecurityError');
    }
  });
});

describe('clientDataJSON', () => {
  it('same-origin layout', () => {
    const s = td.decode(clientDataJSON({ challenge: 'abc', origin: 'https://a.com', crossOrigin: false, topOrigin: 'x' }));
    expect(s).toBe('{"type":"webauthn.get","challenge":"abc","origin":"https://a.com","crossOrigin":false}');
  });
  it('cross-origin iframe adds topOrigin', () => {
    const s = td.decode(
      clientDataJSON({ challenge: 'abc', origin: 'https://a.com', crossOrigin: true, topOrigin: 'https://b.com' }),
    );
    expect(s).toBe(
      '{"type":"webauthn.get","challenge":"abc","origin":"https://a.com","crossOrigin":true,"topOrigin":"https://b.com"}',
    );
  });
});

describe('authenticatorData', () => {
  it('37 bytes: rpIdHash, flags 0x1D, counter 0', async () => {
    const ad = await authenticatorData('example.com');
    expect(ad.length).toBe(37);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('example.com')));
    expect([...ad.subarray(0, 32)]).toEqual([...h]);
    expect(ad[32]).toBe(0x1d);
    expect([...ad.subarray(33)]).toEqual([0, 0, 0, 0]);
  });
});

/** DER → raw r||s (independent parser for the tests). */
function derToRaw(der: Uint8Array): Uint8Array {
  expect(der[0]).toBe(0x30);
  expect(der[1]).toBe(der.length - 2);
  const out = new Uint8Array(64);
  let o = 2;
  for (const at of [0, 32]) {
    expect(der[o]).toBe(0x02);
    const len = der[o + 1]!;
    let v = der.subarray(o + 2, o + 2 + len);
    if (v.length > 1) expect(v[0] === 0 ? v[1]! & 0x80 : 1).toBeTruthy(); // minimal encoding
    if (v[0] === 0 && v.length > 1) v = v.subarray(1);
    out.set(v, at + 32 - v.length);
    o += 2 + len;
  }
  expect(o).toBe(der.length);
  return out;
}

describe('rawToDer', () => {
  it('high-bit r gets a 0x00 prefix', () => {
    const raw = new Uint8Array(64).fill(1);
    raw[0] = 0x80;
    const der = rawToDer(raw);
    expect([...der.subarray(0, 5)]).toEqual([0x30, 69, 0x02, 33, 0x00]);
    expect([...derToRaw(der)]).toEqual([...raw]);
  });
  it('short r has leading zeros stripped', () => {
    const raw = new Uint8Array(64).fill(1);
    raw[0] = 0;
    raw[1] = 0;
    raw[2] = 0x05;
    const der = rawToDer(raw);
    expect([...der.subarray(0, 5)]).toEqual([0x30, 66, 0x02, 30, 0x05]);
    expect([...derToRaw(der)]).toEqual([...raw]);
  });
  it('zero r stays one byte', () => {
    const raw = new Uint8Array(64);
    raw[63] = 1;
    expect([...rawToDer(raw)]).toEqual([0x30, 6, 0x02, 1, 0x00, 0x02, 1, 0x01]);
  });
});

describe('signAssertion', () => {
  it('produces a signature that verifies with Web Crypto', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pkcs8 = toB64url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)));
    const challenge = toB64url(crypto.getRandomValues(new Uint8Array(32)));
    for (let i = 0; i < 5; i++) {
      const a = await signAssertion(pkcs8, 'example.com', { challenge, origin: 'https://example.com', crossOrigin: false });
      const cdj = fromB64url(a.clientDataJSON);
      expect(JSON.parse(td.decode(cdj))).toEqual({
        type: 'webauthn.get',
        challenge,
        origin: 'https://example.com',
        crossOrigin: false,
      });
      const ad = fromB64url(a.authenticatorData);
      const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', cdj as Uint8Array<ArrayBuffer>));
      const data = new Uint8Array([...ad, ...cdHash]);
      const ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        kp.publicKey,
        derToRaw(fromB64url(a.signature)) as Uint8Array<ArrayBuffer>,
        data,
      );
      expect(ok).toBe(true);
    }
  });
});

describe('matchPasskeys', () => {
  const pk = (o: Partial<PasskeyMeta>): PasskeyMeta => ({
    cipherId: 'c',
    credIndex: 0,
    itemName: 'x',
    rpId: 'example.com',
    credentialId: '01234567-89ab-cdef-0123-456789abcdef',
    userName: 'u',
    discoverable: 'true',
    counter: '0',
    keyAlgorithm: 'ECDSA',
    keyCurve: 'P-256',
    ...o,
  });
  it('filters by rpId and discoverable when allow is empty', () => {
    const list = [pk({ cipherId: 'a' }), pk({ cipherId: 'b', rpId: 'other.com' }), pk({ cipherId: 'c', discoverable: 'false' })];
    expect(matchPasskeys(list, 'example.com', []).map((p) => p.cipherId)).toEqual(['a']);
  });
  it('filters by allowCredentials', () => {
    const list = [pk({ cipherId: 'a', discoverable: 'false' }), pk({ cipherId: 'b', credentialId: 'b64.AQID' })];
    const allow = [toB64url(rawCredentialId('01234567-89ab-cdef-0123-456789abcdef'))];
    expect(matchPasskeys(list, 'example.com', allow).map((p) => p.cipherId)).toEqual(['a']);
  });
  it('skips non-P-256 keys', () => {
    expect(matchPasskeys([pk({ keyCurve: 'P-384' })], 'example.com', [])).toEqual([]);
  });
});
