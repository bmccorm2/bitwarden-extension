// RFC 6238 TOTP + otpauth:// parsing.

export interface TotpSpec {
  secret: Uint8Array;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
  digits: number;
  period: number;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s: string): Uint8Array | null {
  const clean = s.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function parseTotp(s: string | null | undefined): TotpSpec | null {
  if (!s) return null;
  const t = s.trim();
  if (/^steam:\/\//i.test(t)) return null;
  if (/^otpauth:\/\//i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      return null;
    }
    if (url.host.toLowerCase() !== 'totp') return null;
    const p = url.searchParams;
    const secret = base32Decode(p.get('secret') ?? '');
    if (!secret) return null;
    const alg = (p.get('algorithm') ?? 'SHA1').toUpperCase().replace('-', '');
    const algorithm = alg === 'SHA256' ? 'SHA-256' : alg === 'SHA512' ? 'SHA-512' : 'SHA-1';
    const digits = Number(p.get('digits') ?? 6);
    const period = Number(p.get('period') ?? 30);
    return {
      secret,
      algorithm,
      digits: Number.isInteger(digits) && digits >= 1 && digits <= 10 ? digits : 6,
      period: Number.isInteger(period) && period > 0 ? period : 30,
    };
  }
  const secret = base32Decode(t);
  return secret ? { secret, algorithm: 'SHA-1', digits: 6, period: 30 } : null;
}

export async function generateTotp(spec: TotpSpec, nowMs: number): Promise<{ code: string; remaining: number }> {
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / spec.period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(spec.secret),
    { name: 'HMAC', hash: spec.algorithm },
    false,
    ['sign'],
  );
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  const code = String(bin % 10 ** spec.digits).padStart(spec.digits, '0');
  return { code, remaining: spec.period - (seconds % spec.period) };
}
