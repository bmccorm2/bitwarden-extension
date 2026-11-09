import { getDomain } from 'tldts';

export interface MatchUri {
  uri: string | null;
  match: number | null;
}

function parseHttp(u: string): URL | null {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Saved URIs without a scheme (e.g. "example.com") are treated as http(s). */
function parseSaved(u: string): URL | null {
  const t = u.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^:/]+:\d+(\/|$)/.test(t)) return parseHttp(t);
  return parseHttp(`https://${t}`);
}

export function baseDomain(host: string): string {
  return getDomain(host, { allowPrivateDomains: false }) ?? host;
}

export function matches(pageUrl: string, uri: MatchUri): boolean {
  const page = parseHttp(pageUrl);
  if (!page || !uri.uri) return false;
  const match = uri.match ?? 0;
  switch (match) {
    case 0: {
      const saved = parseSaved(uri.uri);
      return !!saved && baseDomain(saved.hostname) === baseDomain(page.hostname);
    }
    case 1: {
      const saved = parseSaved(uri.uri);
      return !!saved && saved.host === page.host;
    }
    case 2:
      return pageUrl.startsWith(uri.uri);
    case 3:
      return pageUrl === uri.uri;
    case 4:
      try {
        return new RegExp(uri.uri, 'i').test(pageUrl);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export interface Matchable {
  id: string;
  type: number;
  deleted: boolean;
  uris: MatchUri[];
}

export function matchingLogins<T extends Matchable>(pageUrl: string, ciphers: T[]): T[] {
  return ciphers.filter((c) => c.type === 1 && !c.deleted && c.uris.some((u) => matches(pageUrl, u)));
}
