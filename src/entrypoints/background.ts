import { browser, type Browser } from 'wxt/browser';
import * as api from '@/lib/api';
import { countIcon, lockIcon } from '@/lib/badge';
import { emptyView } from '@/lib/cipher';
import type { FillMode } from '@/lib/fill';
import type { FormKind } from '@/lib/formfill';
import { generatePassword } from '@/lib/generator';
import { checkRpId, matchPasskeys, signAssertion, toB64url, usable, rawCredentialId } from '@/lib/passkey';
import { baseDomain, matches, matchingLogins } from '@/lib/match';
import {
  CONTENT_TYPES,
  type AnyApi,
  type FillReply,
  type PasskeyAssertion,
  type PasskeyList,
  type PendingInfo,
  type Req,
  type StateInfo,
  type ToContent,
} from '@/lib/messages';
import * as session from '@/lib/session';
import { generateTotp, parseTotp } from '@/lib/totp';
import { CipherType, type ListRow } from '@/lib/types';
import * as vault from '@/lib/vault';

type Sender = Browser.runtime.MessageSender;

const CYCLE_MS = 15_000;
const PENDING_MS = 60_000;

export default defineBackground(() => {
  void session.restrictSession();

  browser.runtime.onMessage.addListener((msg: unknown, sender: Sender, sendResponse: (r: unknown) => void) => {
    handle(msg as Req, sender).then(
      (data) => sendResponse({ ok: true, data }),
      (e) => sendResponse({ ok: false, error: (e as Error)?.message ?? String(e) }),
    );
    return true;
  });

  browser.commands.onCommand.addListener((command, tab) => {
    if (command === 'autofill') autofill(tab).catch((e) => console.warn('Lightwarden autofill:', (e as Error).message));
  });

  // For the e2e harness (commands can't be triggered from automation). Only extension contexts can reach this.
  (globalThis as Record<string, unknown>).lightwarden = { autofill, reloadCache: session.forgetCacheMemory };

  // Badge: number of logins matching each tab's page.
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url || info.status === 'complete') void updateBadge(tabId, tab.url).catch(() => {});
  });
  session.onCacheChange(refreshBadges);
  refreshBadges();

  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === AUTOLOCK) void doLock();
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    cycles.delete(tabId);
    void browser.storage.session.remove(`pending:${tabId}`);
  });
});

// ---------------------------------------------------------------------------
// Router

/** Extension pages (popup, or popup.html opened in a tab). Content scripts always report the web page URL. */
function fromExtensionPage(sender: Sender): boolean {
  return sender.id === browser.runtime.id && !!sender.url?.startsWith(browser.runtime.getURL('/'));
}

async function handle(msg: Req, sender: Sender): Promise<unknown> {
  if (sender.id !== browser.runtime.id) throw new Error('Unknown sender');
  if (CONTENT_TYPES.has(msg.type)) {
    if (!sender.tab?.id) throw new Error('Content message without a tab');
    return handleContent(msg, sender);
  }
  if (!fromExtensionPage(sender)) throw new Error('Not allowed from a web page');
  void touch();
  return handlePopup(msg);
}

const BADGE_REFRESH = new Set(['unlock', 'lock', 'logout', 'save', 'trash', 'restore', 'revert']);

async function handlePopup(msg: Req): Promise<unknown> {
  try {
    return await popupAction(msg);
  } finally {
    if (BADGE_REFRESH.has(msg.type)) refreshBadges();
  }
}

async function popupAction(msg: Req): Promise<unknown> {
  const m = msg as Req & Record<string, any>;
  switch (msg.type as keyof AnyApi) {
    case 'state':
      return stateInfo();
    case 'unlock': {
      await session.unlock({ password: m.password, email: m.email, server: m.server });
      vault.clearIndex();
      await touch();
      const tab = await takeAutofillAfterUnlock();
      // Give the popup time to close so the page has focus again (TOTP clipboard copy needs it).
      if (tab) setTimeout(() => autofill(tab).catch((e) => console.warn('Lightwarden autofill:', (e as Error).message)), 300);
      return { ...(await stateInfo()), autofill: !!tab };
    }
    case 'lock':
      await doLock();
      return stateInfo();
    case 'logout':
      await session.logout();
      vault.clearIndex();
      cycles.clear();
      await browser.alarms.clear(AUTOLOCK);
      return stateInfo();
    case 'sync': {
      const cache = await session.getCache();
      if (!m.ifStale || !cache || Date.now() - cache.lastSync > session.SYNC_STALE_MS) {
        await session.syncNow().catch(() => {});
      }
      return stateInfo();
    }
    case 'list': {
      const { rows, folders } = await vault.listRows();
      const siteIds = m.url ? (await mru(matchingLogins(m.url, rows))).map((r) => r.id) : [];
      return { rows, folders, siteIds };
    }
    case 'get':
      return { item: await vault.getItem(m.id), canRevert: !!(await vault.latestUndo(m.id)) };
    case 'save':
      return vault.save(m.view);
    case 'trash':
      await vault.trash(m.id);
      return null;
    case 'restore':
      return vault.restore(m.id);
    case 'revert':
      return vault.revert(m.id);
    case 'generate':
      return generatePassword(m.opts);
    case 'totp':
      return totpFor(m.id);
    case 'settings': {
      const acct = await session.getAccount();
      return {
        server: acct?.server ?? (await session.getServerSetting()),
        neverDomains: await neverDomains(),
        firefox: import.meta.env.FIREFOX === true,
        lockAfter: await lockAfter(),
      };
    }
    case 'setLockAfter':
      await session.setLocal('lockAfter', Math.max(0, Math.floor(Number(m.minutes) || 0)));
      await touch();
      return null;
    case 'fillForm':
      return fillFormItem(m.id);
    case 'removeNever': {
      const list = (await neverDomains()).filter((h) => h !== m.host);
      await session.setLocal('neverDomains', list);
      return list;
    }
    default:
      throw new Error(`Unknown message ${msg.type}`);
  }
}

async function stateInfo(): Promise<StateInfo> {
  const state = await session.getState();
  const cache = await session.getCache();
  const acct = await session.getAccount();
  return {
    state,
    email: acct?.email ?? null,
    server: acct?.server ?? (await session.getServerSetting()),
    lastSync: cache?.lastSync ?? null,
    syncing: session.isSyncing(),
    syncError: state === 'unlocked' ? await session.syncError() : null,
    writable: acct ? api.writesAllowedFor(acct.email) : false,
  };
}

async function totpFor(id: string) {
  const item = await vault.getItem(id);
  const spec = parseTotp(item.login?.totp);
  return spec ? generateTotp(spec, Date.now()) : null;
}

// ---------------------------------------------------------------------------
// Auto-lock after inactivity (Decision 6). Activity = popup use, the shortcut, or a banner click.

const AUTOLOCK = 'autolock';

async function lockAfter(): Promise<number> {
  return (await session.getLocal<number>('lockAfter')) ?? 0;
}

/** Restart the inactivity timer (or clear it when auto-lock is off or the vault is locked). */
async function touch(): Promise<void> {
  const mins = await lockAfter();
  if (mins > 0 && (await session.getState()) === 'unlocked') {
    await browser.alarms.create(AUTOLOCK, { delayInMinutes: mins });
  } else {
    await browser.alarms.clear(AUTOLOCK);
  }
}

async function doLock(): Promise<void> {
  await session.lock();
  vault.clearIndex();
  cycles.clear();
  await browser.alarms.clear(AUTOLOCK);
  refreshBadges();
}

async function neverDomains(): Promise<string[]> {
  return (await session.getLocal<string[]>('neverDomains')) ?? [];
}

async function mru<T extends ListRow>(rows: T[]): Promise<T[]> {
  const lu = (await session.getLocal<Record<string, number>>('lastUsed')) ?? {};
  return [...rows].sort((a, b) => (lu[b.id] ?? 0) - (lu[a.id] ?? 0) || a.name.localeCompare(b.name));
}

async function markUsed(id: string): Promise<void> {
  const lu = (await session.getLocal<Record<string, number>>('lastUsed')) ?? {};
  lu[id] = Date.now();
  await session.setLocal('lastUsed', lu);
}

// ---------------------------------------------------------------------------
// Toolbar icon: count of matching logins for the tab's page, or a padlock while locked

const iconUrl = (s: number) => browser.runtime.getURL(`/icon/${s}.png` as '/icon/16.png');

async function updateBadge(tabId: number, url?: string): Promise<void> {
  const state = await session.getState();
  let icon: object = { path: { 16: '/icon/16.png', 32: '/icon/32.png' } };
  if (state === 'locked') {
    icon = { imageData: await lockIcon(iconUrl) };
  } else if (state === 'unlocked' && url && /^https?:/.test(url)) {
    const n = matchingLogins(url, (await vault.listRows()).rows).length;
    if (n) icon = { imageData: await countIcon(n > 9 ? '9+' : String(n), iconUrl) };
  }
  await browser.action.setIcon({ tabId, ...icon } as Browser.action.TabIconDetails).catch(() => {});
}

let badgeTimer: ReturnType<typeof setTimeout> | undefined;
/** Recompute every tab's icon (debounced; after unlock/lock, sync, or a write). */
function refreshBadges(): void {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    const tabs = await browser.tabs.query({});
    for (const t of tabs) if (t.id) await updateBadge(t.id, t.url).catch(() => {});
  }, 100);
}

// ---------------------------------------------------------------------------
// Autofill command (Decision 8)

interface Cycle {
  origin: string;
  mode: FillMode;
  ids: string[];
  index: number;
  at: number;
}
const cycles = new Map<number, Cycle>();

interface FrameInfo<M = FillMode> {
  frameId: number;
  url: string;
  mode: M;
}
const probes = new Map<string, { tabId: number; frames: FrameInfo<FillMode | FormKind>[]; onTop: () => void }>();

function sendTo<T>(tabId: number, msg: ToContent, frameId = 0): Promise<T | undefined> {
  return browser.tabs.sendMessage(tabId, msg, { frameId }).catch(() => undefined) as Promise<T | undefined>;
}

const toast = (tabId: number, text: string) => sendTo(tabId, { type: 'toast', text });

/** Ask every frame which fill mode it supports; returns same-site frames, top frame first. */
async function probe(tabId: number, topUrl: string): Promise<FrameInfo[]> {
  const frames = await collect(tabId, { type: 'probe', requestId: '' }, true);
  return sameSite(frames, topUrl) as FrameInfo[];
}

/** Send a probe to every frame; each replies with a probeResult message. */
async function collect(tabId: number, msg: ToContent & { requestId: string }, topWins: boolean) {
  const requestId = crypto.randomUUID();
  const frames: FrameInfo<FillMode | FormKind>[] = [];
  let onTop = () => {};
  const topSeen = new Promise<void>((r) => (onTop = r));
  probes.set(requestId, { tabId, frames, onTop: topWins ? onTop : () => {} });
  // No frameId: delivered to every frame.
  browser.tabs.sendMessage(tabId, { ...msg, requestId }).catch(() => {});
  await Promise.race([topSeen, new Promise((r) => setTimeout(r, 250))]);
  probes.delete(requestId);
  return frames;
}

function sameSite<T extends { url: string; frameId: number }>(frames: T[], topUrl: string): T[] {
  const site = baseDomain(new URL(topUrl).hostname);
  return frames
    .filter((f) => {
      try {
        return baseDomain(new URL(f.url).hostname) === site;
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0));
}

/**
 * Popup "Fill" button for cards and identities. Identities go to same-site frames only; cards also go to
 * cross-site frames, since payment fields usually live in a processor's iframe (Stripe, Braintree, Adyen).
 */
async function fillFormItem(id: string): Promise<number> {
  const win = await browser.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
  const tab = win.tabs?.find((t) => t.active);
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error('Open a web page to fill');
  const tabId = tab.id;
  const item = await vault.getItem(id);
  const kind: FormKind | null = item.card ? 'card' : item.identity ? 'identity' : null;
  const data = item.card ?? item.identity;
  if (!kind || !data || item.deletedDate) throw new Error('Only cards and identities can be filled');
  await ensureContent(tabId);
  let frames = await collect(tabId, { type: 'probeForm', requestId: '', kind }, false);
  if (kind === 'identity') frames = sameSite(frames, tab.url);
  let n = 0;
  for (const f of frames) n += (await sendTo<number>(tabId, { type: 'fillForm', kind, data }, f.frameId)) ?? 0;
  if (!n) throw new Error(`No ${kind} fields on this page`);
  await markUsed(id);
  await toast(tabId, `${item.name}: filled ${n} field${n === 1 ? '' : 's'}`);
  return n;
}

/**
 * Tabs opened before the extension was (re)loaded have no live content script, so the shortcut would
 * silently do nothing. Inject it into every frame if the top frame doesn't answer.
 */
async function ensureContent(tabId: number): Promise<void> {
  if (await sendTo<boolean>(tabId, { type: 'ping' })) return;
  await browser.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ['/content-scripts/content.js'] })
    .catch((e) => console.warn('Lightwarden inject:', (e as Error).message));
}

/** Shortcut while locked: show the popup (unlock screen); if the browser won't, open it in a small window. */
async function openUnlock(): Promise<void> {
  try {
    await browser.action.openPopup();
  } catch {
    await browser.windows.create({ url: browser.runtime.getURL('/popup.html?popout'), type: 'popup', width: 420, height: 600 });
  }
}

/** Shortcut pressed while locked on a web page: remember it so a successful unlock fills and closes the popup. */
const AFTER_UNLOCK = 'autofillAfterUnlock';

async function takeAutofillAfterUnlock(): Promise<Browser.tabs.Tab | null> {
  const p = (await browser.storage.session.get(AFTER_UNLOCK))[AFTER_UNLOCK] as
    | { tabId: number; origin: string; at: number }
    | undefined;
  if (!p) return null;
  await browser.storage.session.remove(AFTER_UNLOCK);
  if (Date.now() - p.at > PENDING_MS) return null;
  const tab = await browser.tabs.get(p.tabId).catch(() => null);
  if (!tab?.active || !tab.url || !/^https?:/.test(tab.url) || new URL(tab.url).origin !== p.origin) return null;
  return tab;
}

async function autofill(tab?: Browser.tabs.Tab): Promise<void> {
  if (!tab?.id || !tab.url) [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if ((await session.getState()) !== 'unlocked') {
    if (tab?.id && tab.url && /^https?:/.test(tab.url)) {
      await browser.storage.session.set({
        [AFTER_UNLOCK]: { tabId: tab.id, origin: new URL(tab.url).origin, at: Date.now() },
      });
    }
    await openUnlock();
    return;
  }
  await touch();
  const tabId = tab?.id;
  const url = tab?.url;
  if (!tabId || !url || !/^https?:/.test(url)) return;
  const pageUrl = new URL(url);
  await ensureContent(tabId);

  const { rows } = await vault.listRows();
  const all = await mru(matchingLogins(url, rows));
  if (!all.length) {
    await toast(tabId, `No logins for ${pageUrl.host}`);
    return;
  }
  const frames = await probe(tabId, url);
  const first = frames[0];
  if (!first) {
    await toast(tabId, 'No fillable fields');
    return;
  }
  const mode = first.mode;
  const candidates = mode === 'totp' ? all.filter((r) => r.hasTotp) : all;
  if (!candidates.length) {
    await toast(tabId, `No TOTP for ${pageUrl.host}`);
    return;
  }

  // Cycling: same tab + origin + mode within 15 s → next item in the original MRU order.
  const now = Date.now();
  const prev = cycles.get(tabId);
  let cycle: Cycle;
  if (prev && prev.origin === pageUrl.origin && prev.mode === mode && now - prev.at < CYCLE_MS) {
    const ids = prev.ids.filter((id) => candidates.some((c) => c.id === id));
    cycle = { ...prev, ids, index: ids.length ? (prev.index + 1) % ids.length : 0, at: now };
  } else {
    cycle = { origin: pageUrl.origin, mode, ids: candidates.map((c) => c.id), index: 0, at: now };
  }
  cycles.set(tabId, cycle);
  const row = candidates.find((c) => c.id === cycle.ids[cycle.index]) ?? candidates[0]!;
  const n = cycle.ids.length;
  const pos = `(${cycle.index + 1}/${n})`;

  const item = await vault.getItem(row.id);
  const spec = parseTotp(item.login?.totp);
  const code = spec ? (await generateTotp(spec, now)).code : null;
  const frame = frames.find((f) => f.mode === mode && row.uris.some((u) => matches(f.url, u)));
  if (!frame) {
    await toast(tabId, 'No fillable fields');
    return;
  }
  if (mode === 'totp' && !code) {
    await toast(tabId, `${row.name}: TOTP unsupported`);
    return;
  }
  const reply = await sendTo<FillReply>(
    tabId,
    {
      type: 'fill',
      mode,
      username: mode === 'login' ? item.login?.username ?? '' : '',
      password: mode === 'login' ? item.login?.password ?? '' : '',
      fields:
        mode === 'login'
          ? item.fields.filter((f) => f.type === 0 || f.type === 1).map((f) => ({ name: f.name, value: f.value }))
          : [],
      totp: mode === 'totp' ? code : null,
      copy: mode === 'login' ? code : null,
    },
    frame.frameId,
  );
  if (!reply?.filled) {
    await toast(tabId, 'No fillable fields');
    return;
  }
  await markUsed(row.id);
  const spaced = code ? code.replace(/^(\d{3})(\d{3})$/, '$1 $2') : '';
  let text = mode === 'totp' ? `${row.name} TOTP ${pos}` : `${row.name} ${pos}`;
  if (mode === 'login' && code) text = reply.copied ? `${text} · TOTP copied` : `TOTP: ${spaced} (copy failed)`;
  await toast(tabId, text);
}

// ---------------------------------------------------------------------------
// Content messages: probe results, capture → pending → banner (Decision 11)

interface Pending {
  kind: 'save' | 'update';
  url: string;
  host: string;
  username: string;
  password: string;
  cipherId: string | null;
  at: number;
}

const pendingKey = (tabId: number) => `pending:${tabId}`;

async function getPendingFor(tabId: number): Promise<Pending | null> {
  const p = (await browser.storage.session.get(pendingKey(tabId)))[pendingKey(tabId)] as Pending | undefined;
  return p && Date.now() - p.at < PENDING_MS ? p : null;
}

async function handleContent(msg: Req, sender: Sender): Promise<unknown> {
  const tabId = sender.tab!.id!;
  const m = msg as Req & Record<string, any>;
  switch (msg.type as keyof AnyApi) {
    case 'probeResult': {
      const p = probes.get(m.requestId);
      if (p && p.tabId === tabId && sender.frameId !== undefined && sender.url) {
        if (m.mode) p.frames.push({ frameId: sender.frameId, url: sender.url, mode: m.mode });
        // A top frame with fields wins outright; otherwise wait for iframes.
        if (sender.frameId === 0 && m.mode) p.onTop();
      }
      return null;
    }
    case 'capture':
      await onCapture(tabId, sender.url ?? m.url, m.username, m.password, !!m.change);
      return null;
    case 'getPending': {
      if ((await session.getState()) !== 'unlocked') return null;
      const p = await getPendingFor(tabId);
      return p ? ({ kind: p.kind, host: p.host, username: p.username } satisfies PendingInfo) : null;
    }
    case 'bannerAction':
      await touch();
      return { toast: await bannerAction(tabId, m.action) };
    case 'passkeyGet':
      return passkeyGet(sender, m.rpId ?? null, strings(m.allow));
    case 'passkeySign':
      return passkeySign(sender, m.rpId ?? null, strings(m.allow), String(m.challenge), String(m.cipherId), Number(m.credIndex));
    case 'openUnlock':
      await openUnlock();
      return null;
    default:
      throw new Error('Unknown message');
  }
}

// ---------------------------------------------------------------------------
// Passkey sign-in (Decision 20). The origin comes from `sender`, never from page data.

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

interface PasskeyFrame {
  rpId: string;
  origin: string;
  crossOrigin: boolean;
  topOrigin: string;
}

/** Frame origin + checked rpId. Throws a SecurityError for a bad rpId, a plain Error for non-web frames. */
function passkeyFrame(sender: Sender, rpId: string | null): PasskeyFrame {
  const frameUrl = sender.url ?? '';
  if (!/^https?:/.test(frameUrl)) throw new Error('Not a web frame');
  const checked = checkRpId(rpId, frameUrl);
  const origin = new URL(frameUrl).origin;
  let topOrigin = origin;
  if (sender.frameId !== 0) {
    try {
      topOrigin = new URL(sender.tab?.url ?? '').origin;
    } catch {
      throw new Error('Unknown top frame');
    }
  }
  return { rpId: checked, origin, crossOrigin: topOrigin !== origin, topOrigin };
}

async function passkeyGet(sender: Sender, rpId: string | null, allow: string[]): Promise<PasskeyList> {
  let frame: PasskeyFrame;
  try {
    frame = passkeyFrame(sender, rpId);
  } catch (e) {
    if ((e as Error).name === 'SecurityError') return { status: 'error', name: 'SecurityError' };
    throw e;
  }
  if ((await session.getState()) !== 'unlocked') return { status: 'locked', rpId: frame.rpId };
  const items = (await mruPasskeys(matchPasskeys(await vault.passkeyMetas(), frame.rpId, allow))).map((p) => ({
    cipherId: p.cipherId,
    credIndex: p.credIndex,
    itemName: p.itemName,
    userName: p.userName,
    disabled: !usable(p),
  }));
  items.sort((a, b) => Number(a.disabled) - Number(b.disabled));
  return { status: 'ok', rpId: frame.rpId, items };
}

async function mruPasskeys<T extends { cipherId: string; itemName: string }>(list: T[]): Promise<T[]> {
  const lu = (await session.getLocal<Record<string, number>>('lastUsed')) ?? {};
  return [...list].sort((a, b) => (lu[b.cipherId] ?? 0) - (lu[a.cipherId] ?? 0) || a.itemName.localeCompare(b.itemName));
}

async function passkeySign(
  sender: Sender,
  rpId: string | null,
  allow: string[],
  challenge: string,
  cipherId: string,
  credIndex: number,
): Promise<PasskeyAssertion> {
  const frame = passkeyFrame(sender, rpId);
  if ((await session.getState()) !== 'unlocked') throw new Error('Vault is locked');
  if (!/^[A-Za-z0-9_-]*$/.test(challenge)) throw new Error('Bad challenge');
  // Re-run the match: the content script may only sign with a passkey offered for this rpId.
  const meta = matchPasskeys(await vault.passkeyMetas(), frame.rpId, allow).find(
    (p) => p.cipherId === cipherId && p.credIndex === credIndex,
  );
  if (!meta) throw new Error('Passkey not available for this site');
  if (!usable(meta)) throw new Error('Counter-based passkey not supported');
  const secret = await vault.passkeySecret(cipherId, credIndex);
  const a = await signAssertion(secret.keyValue, frame.rpId, {
    challenge,
    origin: frame.origin,
    crossOrigin: frame.crossOrigin,
    topOrigin: frame.topOrigin,
  });
  await markUsed(cipherId);
  await touch();
  return { id: toB64url(rawCredentialId(meta.credentialId)), ...a, userHandle: secret.userHandle || null };
}

async function onCapture(tabId: number, url: string, username: string, password: string, change: boolean) {
  if (!password || !/^https?:/.test(url)) return;
  if ((await session.getState()) !== 'unlocked') return;
  const host = new URL(url).hostname;
  if ((await neverDomains()).includes(host)) return;

  const { rows } = await vault.listRows();
  const found = await mru(matchingLogins(url, rows));
  const items = await Promise.all(found.map((r) => vault.getItem(r.id)));
  const user = username.trim();
  const sameUser = (u: string) => u.trim().toLowerCase() === user.toLowerCase();

  let kind: Pending['kind'] | null = null;
  let target: (typeof items)[number] | undefined;
  if (change) {
    target = (user && items.find((i) => sameUser(i.login!.username))) || items[0];
    if (target && target.login!.password !== password) kind = 'update';
  } else if (!user && items.some((i) => i.login!.password === password)) {
    kind = null;
  } else {
    target = items.find((i) => sameUser(i.login!.username)) ?? (!user && items.length === 1 ? items[0] : undefined);
    if (target) kind = target.login!.password === password ? null : 'update';
    else kind = 'save';
  }
  if (!kind) return;
  const pending: Pending = {
    kind,
    url,
    host,
    username: kind === 'update' ? target!.login!.username : user,
    password,
    cipherId: kind === 'update' ? target!.id : null,
    at: Date.now(),
  };
  await browser.storage.session.set({ [pendingKey(tabId)]: pending });
  await session.setLocal('pendingAt', pending.at);
  void sendTo(tabId, { type: 'pendingReady' });
}

async function bannerAction(tabId: number, action: 'save' | 'update' | 'never' | 'dismiss'): Promise<string> {
  const p = await getPendingFor(tabId);
  await browser.storage.session.remove(pendingKey(tabId));
  if (!p || action === 'dismiss') return '';
  if (action === 'never') {
    const list = await neverDomains();
    if (!list.includes(p.host)) await session.setLocal('neverDomains', [...list, p.host]);
    return `Won't offer to save on ${p.host}`;
  }
  try {
    if (action === 'save' && p.kind === 'save') {
      const v = emptyView(CipherType.Login);
      v.name = p.host.replace(/^www\./, '');
      v.login!.username = p.username;
      v.login!.password = p.password;
      v.login!.uris = [{ uri: `https://${p.host}`, match: null }];
      const saved = await vault.save(v);
      if (saved.id) await markUsed(saved.id);
      refreshBadges();
      return `Saved ${v.name}`;
    }
    if (action === 'update' && p.kind === 'update' && p.cipherId) {
      const v = await vault.getItem(p.cipherId);
      v.login!.password = p.password;
      await vault.save(v);
      await markUsed(p.cipherId);
      return `Updated ${v.name}`;
    }
    return '';
  } catch (e) {
    return `Lightwarden: ${(e as Error).message}`;
  }
}
