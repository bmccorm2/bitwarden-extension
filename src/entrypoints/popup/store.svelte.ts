import type { StateInfo } from '@/lib/messages';
import type { CipherView, FolderView, ListRow } from '@/lib/types';
import { activeTabUrl, rpc } from './rpc';

export type Route =
  | { name: 'list' }
  | { name: 'item'; id: string }
  | { name: 'edit'; item: CipherView }
  | { name: 'settings' };

export const app = $state({
  st: null as StateInfo | null,
  route: { name: 'list' } as Route,
  rows: [] as ListRow[],
  folders: [] as FolderView[],
  siteIds: [] as string[],
  syncing: false,
  flash: '' as string,
  flashError: false,
  // List UI state survives navigating to an item and back.
  search: '',
  filter: 'all' as 'all' | 'login' | 'card' | 'identity' | 'note' | 'trash',
  folder: '' as string,
  selected: 0,
});

let flashTimer: ReturnType<typeof setTimeout> | undefined;
export function flash(msg: string, error = false): void {
  app.flash = msg;
  app.flashError = error;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (app.flash = ''), error ? 6000 : 1800);
}

export async function loadList(): Promise<void> {
  const r = await rpc('list', { url: await activeTabUrl() });
  app.rows = r.rows;
  app.folders = r.folders;
  app.siteIds = r.siteIds;
}

export async function sync(ifStale = false): Promise<void> {
  if (app.syncing) return;
  app.syncing = true;
  try {
    const before = app.st?.lastSync;
    app.st = await rpc('sync', { ifStale });
    if (app.st.syncError) flash(`Sync failed: ${app.st.syncError}`, true);
    if (app.st.lastSync !== before) await loadList();
  } catch (e) {
    flash((e as Error).message, true);
  } finally {
    app.syncing = false;
  }
}

export function go(route: Route): void {
  app.route = route;
}
