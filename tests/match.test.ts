import { describe, expect, it } from 'vitest';
import { matches, matchingLogins } from '../src/lib/match';

const m = (uri: string, match: number | null) => ({ uri, match });

describe('matches', () => {
  it('base domain (default null and 0)', () => {
    expect(matches('https://login.example.co.uk/a', m('https://example.co.uk', null))).toBe(true);
    expect(matches('https://login.example.co.uk/a', m('https://www.example.co.uk/x', 0))).toBe(true);
    expect(matches('https://example.co.uk', m('example.co.uk', null))).toBe(true);
    expect(matches('https://evil.co.uk', m('https://example.co.uk', null))).toBe(false);
    expect(matches('https://example.com.evil.net', m('https://example.com', null))).toBe(false);
    expect(matches('http://a.github.com:8080', m('https://github.com', null))).toBe(true);
  });

  it('host with port', () => {
    expect(matches('https://app.example.com/x', m('https://app.example.com', 1))).toBe(true);
    expect(matches('https://other.example.com/x', m('https://app.example.com', 1))).toBe(false);
    expect(matches('https://app.example.com:8443/x', m('https://app.example.com', 1))).toBe(false);
    expect(matches('https://app.example.com:8443/x', m('https://app.example.com:8443', 1))).toBe(true);
    expect(matches('https://app.example.com/x', m('app.example.com', 1))).toBe(true);
    expect(matches('http://localhost:3000/', m('localhost:3000', 1))).toBe(true);
  });

  it('starts with', () => {
    expect(matches('https://example.com/app/login', m('https://example.com/app', 2))).toBe(true);
    expect(matches('https://example.com/other', m('https://example.com/app', 2))).toBe(false);
  });

  it('exact', () => {
    expect(matches('https://example.com/login', m('https://example.com/login', 3))).toBe(true);
    expect(matches('https://example.com/login?x', m('https://example.com/login', 3))).toBe(false);
  });

  it('regex', () => {
    expect(matches('https://foo.example.com/', m('^https://[a-z]+\\.example\\.com/', 4))).toBe(true);
    expect(matches('https://example.org/', m('^https://[a-z]+\\.example\\.com/', 4))).toBe(false);
    expect(matches('https://example.com/', m('([', 4))).toBe(false);
  });

  it('never', () => {
    expect(matches('https://example.com/', m('https://example.com/', 5))).toBe(false);
  });

  it('ignores non-http', () => {
    expect(matches('https://example.com/', m('androidapp://com.example', null))).toBe(false);
    expect(matches('chrome://settings', m('chrome://settings', 3))).toBe(false);
    expect(matches('https://example.com/', m('', null))).toBe(false);
  });
});

describe('matchingLogins', () => {
  const base = { type: 1, deleted: false, uris: [m('https://example.com', null)] };
  it('excludes trash and non-logins', () => {
    const list = [
      { ...base, id: 'a' },
      { ...base, id: 'b', deleted: true },
      { ...base, id: 'c', type: 2 },
      { ...base, id: 'd', uris: [m('https://other.com', null)] },
    ];
    expect(matchingLogins('https://www.example.com/login', list).map((c) => c.id)).toEqual(['a']);
  });
});
