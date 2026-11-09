import { describe, expect, it } from 'vitest';
import { generateTotp, parseTotp, type TotpSpec } from '../src/lib/totp';

const te = new TextEncoder();
const spec = (secret: string, algorithm: TotpSpec['algorithm']): TotpSpec => ({
  secret: te.encode(secret),
  algorithm,
  digits: 8,
  period: 30,
});

// RFC 6238 Appendix B.
const s1 = '12345678901234567890';
const s256 = '12345678901234567890123456789012';
const s512 = '1234567890123456789012345678901234567890123456789012345678901234';

describe('totp', () => {
  it('RFC 6238 vectors', async () => {
    expect((await generateTotp(spec(s1, 'SHA-1'), 59_000)).code).toBe('94287082');
    expect((await generateTotp(spec(s256, 'SHA-256'), 59_000)).code).toBe('46119246');
    expect((await generateTotp(spec(s512, 'SHA-512'), 59_000)).code).toBe('90693936');
    expect((await generateTotp(spec(s1, 'SHA-1'), 1111111109_000)).code).toBe('07081804');
    expect((await generateTotp(spec(s1, 'SHA-1'), 20000000000_000)).code).toBe('65353130');
  });

  it('remaining seconds', async () => {
    expect((await generateTotp(spec(s1, 'SHA-1'), 59_000)).remaining).toBe(1);
    expect((await generateTotp(spec(s1, 'SHA-1'), 60_000)).remaining).toBe(30);
  });

  it('parses raw base32 with spaces, lowercase', async () => {
    // base32("12345678901234567890")
    const p = parseTotp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq');
    expect(p).not.toBeNull();
    expect(new TextDecoder().decode(p!.secret)).toBe(s1);
    expect(p!.digits).toBe(6);
    expect(p!.period).toBe(30);
    expect((await generateTotp(p!, 59_000)).code).toBe('287082');
  });

  it('parses otpauth URIs', () => {
    const p = parseTotp(
      'otpauth://totp/ACME:bob?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60',
    );
    expect(p).toMatchObject({ algorithm: 'SHA-256', digits: 8, period: 60 });
    expect(parseTotp('otpauth://totp/x?secret=GEZDGNBV')).toMatchObject({ algorithm: 'SHA-1', digits: 6 });
    expect(parseTotp('otpauth://hotp/x?secret=GEZDGNBV')).toBeNull();
  });

  it('rejects steam and garbage', () => {
    expect(parseTotp('steam://ABCDEF')).toBeNull();
    expect(parseTotp('not base32!')).toBeNull();
    expect(parseTotp('')).toBeNull();
    expect(parseTotp(null)).toBeNull();
  });
});
