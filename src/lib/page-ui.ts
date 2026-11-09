// In-page toast + save/update banner, in a closed shadow root. Themed with the dark-theme tokens.

import type { PendingInfo } from './messages';

const CSS = `
:host { all: initial; }
.root {
  color-scheme: light dark;
  --bg: light-dark(#ffffff, #1f2227);
  --bg-sidebar: light-dark(#f4f5f7, #282b32);
  --bg-elev: light-dark(#e9ebef, #30333b);
  --border: light-dark(#d5d8de, #393d47);
  --text: light-dark(#1f2227, #ffffff);
  --text-dim: light-dark(#5f636b, #9c9ea3);
  --accent: light-dark(#c45500, #f06c00);
  --on-accent: #ffffff;
  --shadow-popover: 0 6px 20px light-dark(rgb(0 0 0 / 0.12), rgb(0 0 0 / 0.4));
  position: fixed; top: 12px; right: 12px; z-index: 2147483647;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  font: 13px/1.4 "Open Sans Variable", -apple-system, BlinkMacSystemFont, sans-serif;
  color: var(--text);
  pointer-events: none;
}
.toast, .banner {
  pointer-events: auto;
  background: var(--bg-sidebar); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-popover);
  max-width: 340px;
}
.toast { padding: 8px 12px; background: var(--bg-elev); }
.banner { padding: 10px 12px 12px; width: 320px; box-sizing: border-box; }
.head { display: flex; align-items: center; gap: 8px; }
.title { font-weight: 600; flex: 1; }
.brand { color: var(--accent); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.sub { color: var(--text-dim); margin: 4px 0 10px; overflow-wrap: anywhere; }
.row { display: flex; gap: 6px; }
button {
  font: inherit; color: var(--text); background: var(--bg-elev);
  border: 1px solid var(--border); border-radius: 5px; padding: 3px 10px; cursor: pointer;
}
button:hover, button:focus-visible { border-color: var(--accent); outline: none; }
button.primary { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
button.x { background: none; border: 0; color: var(--text-dim); padding: 0 4px; font-size: 16px; line-height: 1; }
button.x:hover { color: var(--text); }
textarea { position: absolute; opacity: 0; width: 1px; height: 1px; }
.overlay {
  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  pointer-events: auto; background: light-dark(rgb(0 0 0 / 0.15), rgb(0 0 0 / 0.35));
}
.picker { width: 360px; max-height: 70vh; display: flex; flex-direction: column; }
.list { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; margin: 8px 0 10px; }
.list button { text-align: left; padding: 6px 10px; overflow-wrap: anywhere; }
.list button:disabled { cursor: default; color: var(--text-dim); border-color: var(--border); }
.note { display: block; font-size: 11px; color: var(--text-dim); }
`;

let root: HTMLElement | null = null;

function container(): HTMLElement {
  if (root && root.isConnected) return root;
  const host = document.createElement('lightwarden-ui');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root = document.createElement('div');
  root.className = 'root';
  shadow.append(style, root);
  document.documentElement.append(host);
  return root;
}

export function showToast(text: string, ms = 2500): void {
  if (!text) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  container().append(el);
  setTimeout(() => el.remove(), ms);
}

let banner: HTMLElement | null = null;

export function showBanner(p: PendingInfo, act: (a: 'save' | 'update' | 'never' | 'dismiss') => void): void {
  banner?.remove();
  const el = document.createElement('div');
  el.className = 'banner';
  el.setAttribute('role', 'dialog');
  const head = document.createElement('div');
  head.className = 'head';
  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = 'Lightwarden';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = p.kind === 'save' ? 'Save login?' : 'Update password?';
  const close = document.createElement('button');
  close.className = 'x';
  close.title = 'Dismiss';
  close.textContent = '×';
  head.append(brand, title, close);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${p.username || '(no username)'} on ${p.host}`;
  const row = document.createElement('div');
  row.className = 'row';
  const main = document.createElement('button');
  main.className = 'primary';
  main.textContent = p.kind === 'save' ? 'Save' : 'Update';
  const never = document.createElement('button');
  never.textContent = 'Never for this site';
  row.append(main, never);
  el.append(head, sub, row);
  const done = (a: 'save' | 'update' | 'never' | 'dismiss') => {
    el.remove();
    if (banner === el) banner = null;
    act(a);
  };
  main.addEventListener('click', () => done(p.kind));
  never.addEventListener('click', () => done('never'));
  close.addEventListener('click', () => done('dismiss'));
  banner = el;
  container().prepend(el);
}

// ---- passkey picker (Decision 20) ----

export interface PickerRow {
  label: string;
  disabled: boolean;
}
export type PickerState = { kind: 'locked' } | { kind: 'list'; rows: PickerRow[] };
export interface PickerHandle {
  update(s: PickerState): void;
  close(): void;
}

/**
 * Centred modal. Only trusted (real user) clicks and key presses count. Esc, × and
 * "Use browser passkey" call `fallback`.
 */
export function showPicker(
  rpId: string,
  state: PickerState,
  on: { pick(i: number): void; unlock(): void; fallback(): void },
): PickerHandle {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const el = document.createElement('div');
  el.className = 'banner picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  overlay.append(el);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const trusted = (fn: () => void) => (e: Event) => {
    if (!e.isTrusted || closed) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  const finish = (fn: () => void) => trusted(() => (close(), fn()));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') finish(on.fallback)(e);
  };
  document.addEventListener('keydown', onKey, true);

  const button = (text: string, cls = '') => {
    const b = document.createElement('button');
    b.textContent = text;
    if (cls) b.className = cls;
    return b;
  };

  const render = (s: PickerState) => {
    const head = document.createElement('div');
    head.className = 'head';
    const brand = document.createElement('span');
    brand.className = 'brand';
    brand.textContent = 'Lightwarden';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = `Sign in with a passkey · ${rpId}`;
    const x = button('×', 'x');
    x.title = 'Use browser passkey';
    x.addEventListener('click', finish(on.fallback));
    head.append(brand, title, x);

    const list = document.createElement('div');
    list.className = 'list';
    const row = document.createElement('div');
    row.className = 'row';
    const browserBtn = button('Use browser passkey');
    browserBtn.addEventListener('click', finish(on.fallback));

    if (s.kind === 'locked') {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = 'Lightwarden is locked';
      const unlock = button('Unlock', 'primary');
      unlock.addEventListener('click', trusted(on.unlock));
      row.append(unlock, browserBtn);
      el.replaceChildren(head, sub, row);
      unlock.focus();
      return;
    }
    s.rows.forEach((r, i) => {
      const b = button(r.label);
      if (r.disabled) {
        b.disabled = true;
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = 'Counter-based passkey not supported';
        b.append(note);
      } else b.addEventListener('click', finish(() => on.pick(i)));
      list.append(b);
    });
    row.append(browserBtn);
    el.replaceChildren(head, list, row);
    (list.querySelector('button:not(:disabled)') as HTMLElement | null ?? browserBtn).focus();
  };

  container().append(overlay);
  render(state);
  return { update: (s) => !closed && render(s), close };
}

/** Clipboard write; falls back to execCommand with a textarea inside our shadow root. */
export async function copyText(text: string): Promise<boolean> {
  const active = document.activeElement as HTMLElement | null;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      container().append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    } finally {
      active?.focus?.();
    }
  }
}
