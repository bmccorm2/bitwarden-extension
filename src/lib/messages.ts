// Typed message contracts between popup / content scripts and the background.

import type { FillMode } from './fill';
import type { GenOptions } from './generator';
import type { LockState } from './session';
import type { CipherView, FolderView, ListRow } from './types';

export interface StateInfo {
  state: LockState;
  email: string | null;
  server: string;
  lastSync: number | null;
  syncing: boolean;
  syncError: string | null;
  writable: boolean;
}

export interface PendingInfo {
  kind: 'save' | 'update';
  host: string;
  username: string;
}

/** Popup → background. Map of request type → [request, response]. */
export interface PopupApi {
  state: [{}, StateInfo];
  unlock: [{ password: string; email?: string; server?: string }, StateInfo];
  lock: [{}, StateInfo];
  logout: [{}, StateInfo];
  sync: [{ ifStale?: boolean }, StateInfo];
  list: [{ url?: string }, { rows: ListRow[]; folders: FolderView[]; siteIds: string[] }];
  get: [{ id: string }, { item: CipherView; canRevert: boolean }];
  save: [{ view: CipherView }, CipherView];
  trash: [{ id: string }, null];
  restore: [{ id: string }, CipherView];
  revert: [{ id: string }, CipherView];
  generate: [{ opts?: Partial<GenOptions> }, string];
  totp: [{ id: string }, { code: string; remaining: number } | null];
  settings: [{}, { server: string; neverDomains: string[]; firefox: boolean; lockAfter: number }];
  /** Minutes of inactivity before auto-lock; 0 = only when the browser closes. */
  setLockAfter: [{ minutes: number }, null];
  removeNever: [{ host: string }, string[]];
}

/** A page's `navigator.credentials.get` request, as forwarded by the content script (base64url IDs). */
export interface PasskeyRequest {
  rpId: string | null;
  allow: string[];
}

export interface PasskeyOption {
  cipherId: string;
  credIndex: number;
  itemName: string;
  userName: string;
  /** Counter-based passkey: listed but not usable. */
  disabled: boolean;
}

export type PasskeyList =
  | { status: 'ok'; rpId: string; items: PasskeyOption[] }
  | { status: 'locked'; rpId: string }
  | { status: 'error'; name: string };

/** All base64url. */
export interface PasskeyAssertion {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
}

/** Page ↔ isolated content script messages (window.postMessage, `lw` tag). */
export type PkToIsolated =
  | { lw: 'pk-req'; id: string; rpId: string | null; challenge: string; allow: string[]; userVerification: string }
  | { lw: 'pk-abort'; id: string };
export type PkToMain =
  | { lw: 'pk-ready' }
  | { lw: 'pk-ack'; id: string }
  | { lw: 'pk-res'; id: string; cred: PasskeyAssertion }
  | { lw: 'pk-res'; id: string; error: string }
  | { lw: 'pk-res'; id: string; fallback: true };

/** Content script → background. */
export interface ContentApi {
  capture: [{ url: string; username: string; password: string; change: boolean }, null];
  getPending: [{}, PendingInfo | null];
  bannerAction: [{ action: 'save' | 'update' | 'never' | 'dismiss' }, { toast: string }];
  probeResult: [{ requestId: string; mode: FillMode | null }, null];
  passkeyGet: [PasskeyRequest, PasskeyList];
  passkeySign: [PasskeyRequest & { challenge: string; cipherId: string; credIndex: number }, PasskeyAssertion];
  openUnlock: [{}, null];
}

export type AnyApi = PopupApi & ContentApi;
export type Req<K extends keyof AnyApi = keyof AnyApi> = { type: K } & AnyApi[K][0];
export type Res<T> = { ok: true; data: T } | { ok: false; error: string };

export const CONTENT_TYPES: ReadonlySet<string> = new Set<keyof ContentApi>([
  'capture',
  'getPending',
  'bannerAction',
  'probeResult',
  'passkeyGet',
  'passkeySign',
  'openUnlock',
]);

/** Background → content script. */
export type ToContent =
  | { type: 'probe'; requestId: string }
  | {
      type: 'fill';
      mode: FillMode;
      username: string;
      password: string;
      fields: { name: string; value: string }[];
      totp: string | null;
      /** Copy this TOTP code to the clipboard after filling a login. */
      copy: string | null;
    }
  | { type: 'toast'; text: string }
  | { type: 'pendingReady' }
  | { type: 'ping' };

export interface FillReply {
  filled: boolean;
  copied: boolean | null;
}
