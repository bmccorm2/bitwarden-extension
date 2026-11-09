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

export async function activeTabUrl(): Promise<string | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url;
}
