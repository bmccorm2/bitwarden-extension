import { browser } from 'wxt/browser';
import type { PopupApi, Res } from '@/lib/messages';

export async function rpc<K extends keyof PopupApi>(type: K, body?: PopupApi[K][0]): Promise<PopupApi[K][1]> {
  const r = (await browser.runtime.sendMessage({ type, ...(body ?? {}) })) as Res<PopupApi[K][1]> | undefined;
  if (!r) throw new Error('No response from the background worker');
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** True when the UI runs in its own window (opened with `?popout`) instead of the toolbar popup. */
export const popout = new URLSearchParams(location.search).has('popout');

/** Active tab of the last focused browser window. Works from the toolbar popup and the pop-out window. */
export async function activeTabUrl(): Promise<string | undefined> {
  const win = await browser.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
  return win.tabs?.find((t) => t.active)?.url;
}

/** Reopens the UI in a separate window that stays open when it loses focus. */
export async function openPopout(): Promise<void> {
  await browser.windows.create({ url: browser.runtime.getURL('/popup.html?popout'), type: 'popup', width: 420, height: 600 });
  window.close();
}
