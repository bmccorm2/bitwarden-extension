import { browser } from 'wxt/browser';
import { captureFrom, detectMode, fillLogin, fillTotp } from '@/lib/fill';
import { countFormFields, fillForm } from '@/lib/formfill';
import type { ContentApi, FillReply, PasskeyAssertion, PasskeyOption, PendingInfo, PkToIsolated, PkToMain, Res, ToContent } from '@/lib/messages';
import { copyText, showBanner, showPicker, showToast, type PickerHandle, type PickerState } from '@/lib/page-ui';

const PENDING_MS = 60_000;

/**
 * False once the extension was reloaded or updated: this copy of the script is orphaned, and
 * `runtime.sendMessage` would throw "Extension context invalidated" synchronously.
 */
function alive(): boolean {
  try {
    return !!browser.runtime?.id;
  } catch {
    return false;
  }
}

function send<K extends keyof ContentApi>(type: K, body: ContentApi[K][0]): Promise<ContentApi[K][1] | null> {
  if (!alive()) return Promise.resolve(null);
  try {
    return (browser.runtime.sendMessage({ type, ...body }) as Promise<Res<ContentApi[K][1]>>)
      .then((r) => (r?.ok ? r.data : null))
      .catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    const isTop = window === window.top;

    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (r: unknown) => void) => {
      const msg = raw as ToContent;
      switch (msg.type) {
        case 'probe': {
          const mode = detectMode(document);
          if (mode || isTop) void send('probeResult', { requestId: msg.requestId, mode });
          return;
        }
        case 'probeForm':
          if (countFormFields(document, msg.kind)) void send('probeResult', { requestId: msg.requestId, mode: msg.kind });
          return;
        case 'fillForm':
          sendResponse(fillForm(document, msg.kind, msg.data));
          return;
        case 'fill': {
          const filled =
            msg.mode === 'totp'
              ? fillTotp(document, msg.totp ?? '')
              : fillLogin(document, { username: msg.username, password: msg.password, fields: msg.fields });
          if (!filled || !msg.copy) {
            sendResponse({ filled, copied: null } satisfies FillReply);
            return;
          }
          copyText(msg.copy).then((copied) => sendResponse({ filled, copied } satisfies FillReply));
          return true;
        }
        case 'toast':
          if (isTop) showToast(msg.text);
          return;
        case 'ping':
          if (isTop) sendResponse(true);
          return;
        case 'pendingReady':
          if (isTop) void checkPending();
          return;
      }
    });

    if (isTop) {
      void browser.storage.local.get('pendingAt').then((r) => {
        const at = r.pendingAt as number | undefined;
        if (at && Date.now() - at < PENDING_MS) void checkPending();
      });
    }

    // ---- passkey sign-in (M10). The main-world script is Chromium-only (todo.md task 37). ----
    if (!import.meta.env.FIREFOX) {
      window.addEventListener('message', (e) => {
        if (e.source !== window || !alive()) return;
        const m = parsePkMessage(e.data);
        if (m?.lw === 'pk-req') void passkeyRequest(m);
        else if (m?.lw === 'pk-abort' && active?.id === m.id) active.cancel();
      });
      toPage({ lw: 'pk-ready' });
    }

    // ---- capture (M7) ----
    let last = { key: '', at: 0 };
    const capture = (scope: ParentNode) => {
      if (!alive()) return;
      const c = captureFrom(scope);
      if (!c) return;
      const key = `${c.username}\n${c.password}\n${c.change}`;
      if (key === last.key && Date.now() - last.at < 3000) return;
      last = { key, at: Date.now() };
      void send('capture', { url: location.href, ...c }).then(() => {
        if (isTop) void checkPending();
      });
    };

    document.addEventListener(
      'submit',
      (e) => {
        if (e.target instanceof HTMLFormElement) capture(e.target);
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        const btn = (e.target as Element | null)?.closest?.('button, input[type=submit], [role=button]');
        if (!btn || !isSubmitLike(btn)) return;
        capture(btn.closest('form') ?? document);
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        const t = e.target;
        if (e.key === 'Enter' && t instanceof HTMLInputElement && t.type === 'password') capture(t.form ?? document);
      },
      true,
    );
  },
});

function isSubmitLike(el: Element): boolean {
  if (el instanceof HTMLInputElement) return el.type === 'submit';
  if (el instanceof HTMLButtonElement && el.type === 'submit' && el.form) return true;
  return /log ?in|sign ?in|continue|next|submit/i.test(el.textContent ?? '');
}

let checking = false;
async function checkPending() {
  if (checking) return;
  checking = true;
  try {
    const p = (await send('getPending', {})) as PendingInfo | null;
    if (p) {
      showBanner(p, async (action) => {
        const r = await send('bannerAction', { action });
        if (r?.toast) showToast(r.toast);
      });
    }
  } finally {
    checking = false;
  }
}

// ---------------------------------------------------------------------------
// Passkey picker flow (Decision 20)

const UNLOCK_POLL_MS = 1000;
const UNLOCK_WAIT_MS = 120_000;
const B64URL = /^[A-Za-z0-9_-]*$/;

const toPage = (m: PkToMain) => window.postMessage(m, '*');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Only well-formed messages from our own main-world script's shape. The page can forge these; that's fine. */
function parsePkMessage(d: unknown): PkToIsolated | null {
  if (!d || typeof d !== 'object') return null;
  const m = d as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length > 64) return null;
  if (m.lw === 'pk-abort') return { lw: 'pk-abort', id: m.id };
  if (m.lw !== 'pk-req') return null;
  const { rpId, challenge, allow } = m;
  if (rpId !== null && (typeof rpId !== 'string' || rpId.length > 253)) return null;
  if (typeof challenge !== 'string' || !challenge || challenge.length > 4096 || !B64URL.test(challenge)) return null;
  if (!Array.isArray(allow) || allow.length > 256) return null;
  if (!allow.every((a) => typeof a === 'string' && a.length <= 1400 && B64URL.test(a))) return null;
  return { lw: 'pk-req', id: m.id, rpId, challenge, allow, userVerification: String(m.userVerification ?? '') };
}

let active: { id: string; cancel(): void } | null = null;

type PkResult = { cred: PasskeyAssertion } | { error: string } | { fallback: true };

async function passkeyRequest(req: PkToIsolated & { lw: 'pk-req' }) {
  toPage({ lw: 'pk-ack', id: req.id });
  // A newer request replaces an open picker (browsers allow one ceremony at a time).
  if (active) {
    const prev = active;
    prev.cancel();
    toPage({ lw: 'pk-res', id: prev.id, error: 'NotAllowedError' });
  }
  let picker: PickerHandle | null = null;
  let done = false;
  const me = {
    id: req.id,
    cancel() {
      done = true;
      picker?.close();
      if (active === me) active = null;
    },
  };
  active = me;
  const finish = (r: PkResult) => {
    if (done) return;
    me.cancel();
    toPage({ lw: 'pk-res', id: req.id, ...r } as PkToMain);
  };

  const body = { rpId: req.rpId, allow: req.allow };
  const list = await send('passkeyGet', body);
  if (done) return;
  if (!list) return finish({ fallback: true });
  if (list.status === 'error') return finish({ error: list.name });
  if (list.status === 'ok' && !list.items.length) return finish({ fallback: true });

  let items: PasskeyOption[] = list.status === 'ok' ? list.items : [];
  const listState = (): PickerState => ({
    kind: 'list',
    rows: items.map((i) => ({ label: `${i.userName || '(no username)'} · ${i.itemName}`, disabled: i.disabled })),
  });

  let polling = false;
  const pollUnlocked = async () => {
    if (polling) return;
    polling = true;
    const end = Date.now() + UNLOCK_WAIT_MS;
    while (!done && Date.now() < end) {
      await sleep(UNLOCK_POLL_MS);
      const l = await send('passkeyGet', body);
      if (done) return;
      if (!l || l.status === 'error') return finish(l ? { error: l.name } : { fallback: true });
      if (l.status === 'ok') {
        if (!l.items.length) return finish({ fallback: true });
        items = l.items;
        picker?.update(listState());
        return;
      }
    }
    polling = false;
  };

  picker = showPicker(list.rpId, list.status === 'locked' ? { kind: 'locked' } : listState(), {
    fallback: () => finish({ fallback: true }),
    unlock: () => {
      void send('openUnlock', {});
      void pollUnlocked();
    },
    pick: async (i) => {
      const it = items[i];
      if (!it || it.disabled) return finish({ fallback: true });
      const cred = await send('passkeySign', { ...body, challenge: req.challenge, cipherId: it.cipherId, credIndex: it.credIndex });
      finish(cred ? { cred } : { fallback: true });
    },
  });
}
