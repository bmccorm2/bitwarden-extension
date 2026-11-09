<script lang="ts">
  import { Copy, Lock, Plus, RefreshCw, Search, Settings, Star } from '@lucide/svelte';
  import { emptyView } from '@/lib/cipher';
  import type { ListRow } from '@/lib/types';
  import TypeIcon from '../components/TypeIcon.svelte';
  import { copy, rpc } from '../rpc';
  import { app, flash, go, sync } from '../store.svelte';

  const FILTERS = [
    ['all', 'All'],
    ['login', 'Logins'],
    ['card', 'Cards'],
    ['identity', 'IDs'],
    ['note', 'Notes'],
    ['trash', 'Trash'],
  ] as const;
  const TYPE_OF: Record<string, number> = { login: 1, note: 2, card: 3, identity: 4 };
  const NEW_TYPES = [
    [1, 'Login'],
    [3, 'Card'],
    [4, 'Identity'],
    [2, 'Secure note'],
  ] as const;

  let showNew = $state(false);
  /** Copy menu for a login row: which row, and where to draw it (fixed, so the list can't clip it). */
  let menu = $state<{ row: ListRow; x: number; y: number; up: boolean } | null>(null);

  function openMenu(e: MouseEvent, r: ListRow) {
    e.stopPropagation();
    if (menu?.row.id === r.id) {
      menu = null;
      return;
    }
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const up = window.innerHeight - b.bottom < 100;
    menu = { row: r, x: window.innerWidth - b.right, y: up ? window.innerHeight - b.top : b.bottom, up };
  }

  async function copyField(r: ListRow, what: 'username' | 'password' | 'totp') {
    menu = null;
    try {
      let value = '';
      if (what === 'username') value = r.username;
      else if (what === 'password') value = (await rpc('get', { id: r.id })).item.login?.password ?? '';
      else value = (await rpc('totp', { id: r.id }))?.code ?? '';
      if (!value) return flash(`No ${what === 'totp' ? 'TOTP' : what}`, true);
      await copy(value);
      flash(`Copied ${what === 'totp' ? 'TOTP' : what}`);
    } catch (e) {
      flash(`Copy failed: ${(e as Error).message}`, true);
    }
  }
  let listEl: HTMLElement | undefined = $state();

  const q = $derived(app.search.trim().toLowerCase());

  const filtered = $derived.by(() => {
    const t = TYPE_OF[app.filter];
    const out = app.rows.filter((r) => {
      if (app.filter === 'trash' ? !r.deleted : r.deleted) return false;
      if (t && r.type !== t) return false;
      if (app.folder === '__none' ? r.folderId : app.folder && r.folderId !== app.folder) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.username.toLowerCase().includes(q) ||
        r.subtitle.toLowerCase().includes(q) ||
        r.uris.some((u) => u.uri.toLowerCase().includes(q))
      );
    });
    // Favorites first; the background already sorted by name.
    return [...out.filter((r) => r.favorite), ...out.filter((r) => !r.favorite)];
  });

  const site = $derived.by(() => {
    if (q || app.folder || !(app.filter === 'all' || app.filter === 'login')) return [];
    const byId = new Map(app.rows.map((r) => [r.id, r]));
    return app.siteIds.map((id) => byId.get(id)).filter((r): r is ListRow => !!r && !r.deleted);
  });

  const flat = $derived([...site, ...filtered]);

  /** List sections: matches for this site, starred, everything else. Headers only when there's more than one. */
  const sections = $derived.by(() => {
    const starred = filtered.filter((r) => r.favorite);
    const rest = filtered.filter((r) => !r.favorite);
    const all = [
      { label: 'This site', rows: site, start: 0 },
      { label: 'Starred', rows: starred, start: site.length },
      { label: app.filter === 'login' ? 'Logins' : 'All items', rows: rest, start: site.length + starred.length },
    ];
    return all.filter((sec) => sec.rows.length);
  });

  $effect(() => {
    if (app.selected >= flat.length) app.selected = Math.max(0, flat.length - 1);
  });

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      app.selected = Math.min(flat.length - 1, Math.max(0, app.selected + d));
      queueMicrotask(() => listEl?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' }));
    } else if (e.key === 'Enter') {
      const r = flat[app.selected];
      if (r) go({ name: 'item', id: r.id });
    }
  }

  async function lock() {
    app.st = await rpc('lock');
    app.rows = [];
  }

  function newItem(type: number) {
    showNew = false;
    const item = emptyView(type);
    if (app.folder && app.folder !== '__none') item.folderId = app.folder;
    go({ name: 'edit', item });
  }
</script>

{#snippet row(r: ListRow, i: number, sectionEnd = false)}
  <div
    data-sel={i === app.selected}
    class="flex items-center border-b pr-1.5 hover:bg-elev {sectionEnd ? 'border-line' : 'border-hairline'}"
    class:row-sel={i === app.selected}
  >
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2.5 py-[5px] pl-3 text-left"
      onclick={() => go({ name: 'item', id: r.id })}
    >
      <TypeIcon type={r.type} class="shrink-0 text-dim" />
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1">
          <span class="truncate">{r.name}</span>
          {#if r.favorite}<Star size={11} class="shrink-0 text-accent" />{/if}
        </span>
        {#if r.subtitle}<span class="block truncate text-[13px] text-dim">{r.subtitle}</span>{/if}
      </span>
    </button>
    {#if r.type === 1 && !r.deleted}
      <button type="button" class="icon-btn shrink-0" title="Copy…" aria-label="Copy menu" onclick={(e) => openMenu(e, r)}
        ><Copy size={14} /></button
      >
    {/if}
  </div>
{/snippet}

<svelte:window onclick={() => (menu = null)} onkeydown={(e) => e.key === 'Escape' && menu && (menu = null)} />

<header class="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-2">
  <div class="relative flex-1">
    <Search size={14} class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="input py-1 pl-7"
      placeholder="Search vault"
      bind:value={app.search}
      oninput={() => (app.selected = 0)}
      {onkeydown}
      autofocus
    />
  </div>
  <button class="icon-btn" title="Sync" onclick={() => sync()} disabled={app.syncing}>
    <RefreshCw size={14} class={app.syncing ? 'spin text-running' : ''} />
  </button>
  <div class="relative">
    <button class="icon-btn" title="New item" onclick={() => (showNew = !showNew)}><Plus size={14} /></button>
    {#if showNew}
      <div class="absolute top-7 right-0 z-10 w-32 rounded-[8px] border border-line bg-sidebar py-1 shadow-popover">
        {#each NEW_TYPES as [t, label] (t)}
          <button class="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-elev" onclick={() => newItem(t)}>
            <TypeIcon type={t} class="text-dim" />{label}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <button class="icon-btn" title="Lock" onclick={lock}><Lock size={14} /></button>
  <button class="icon-btn" title="Settings" onclick={() => go({ name: 'settings' })}><Settings size={14} /></button>
</header>

<div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
  {#each FILTERS as [key, label] (key)}
    <button
      class="chip"
      class:chip-on={app.filter === key}
      onclick={() => {
        app.filter = key;
        app.selected = 0;
      }}>{label}</button
    >
  {/each}
  <select
    class="ml-auto max-w-[84px] rounded-[5px] border border-line bg-elev px-1 py-px text-[13px] text-dim"
    bind:value={app.folder}
    onchange={() => (app.selected = 0)}
    title="Folder"
  >
    <option value="">All folders</option>
    {#each app.folders as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
    <option value="__none">No folder</option>
  </select>
</div>

<div class="min-h-0 flex-1 overflow-y-auto" bind:this={listEl}>
  {#each sections as sec, n (sec.label)}
    {#if sections.length > 1}
      <div class="label px-3 pt-2 pb-1">{sec.label}</div>
    {/if}
    {#each sec.rows as r, i (r.id)}{@render row(r, sec.start + i, n < sections.length - 1 && i === sec.rows.length - 1)}{/each}
  {/each}
  {#if !flat.length}
    <div class="p-6 text-center text-dim">{app.rows.length ? 'No matching items' : 'Vault is empty'}</div>
  {/if}
</div>

{#if menu}
  {@const r = menu.row}
  <div
    class="fixed z-20 w-36 rounded-[8px] border border-line bg-sidebar py-1 shadow-popover"
    style="right:{menu.x}px;{menu.up ? 'bottom' : 'top'}:{menu.y}px"
  >
    {#each [['username', 'Copy username', !!r.username], ['password', 'Copy password', true], ['totp', 'Copy TOTP', r.hasTotp]] as const as [what, label, on] (what)}
      {#if on}
        <button
          class="flex w-full px-3 py-1 text-left hover:bg-elev"
          onclick={(e) => {
            e.stopPropagation();
            void copyField(r, what);
          }}>{label}</button
        >
      {/if}
    {/each}
  </div>
{/if}

<footer class="flex h-6 shrink-0 items-center justify-between border-t border-line bg-sidebar px-3 text-[12px] text-faint">
  <span>{filtered.length} items</span>
  {#if app.st?.lastSync}<span>Synced {new Date(app.st.lastSync).toLocaleTimeString()}</span>{/if}
</footer>
