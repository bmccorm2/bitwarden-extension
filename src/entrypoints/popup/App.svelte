<script lang="ts">
  import { onMount } from 'svelte';
  import Edit from './views/Edit.svelte';
  import Item from './views/Item.svelte';
  import List from './views/List.svelte';
  import Settings from './views/Settings.svelte';
  import Unlock from './views/Unlock.svelte';
  import { rpc } from './rpc';
  import { app, loadList, sync } from './store.svelte';

  let error = $state('');

  onMount(async () => {
    try {
      app.st = await rpc('state');
      if (app.st.state === 'unlocked') {
        await loadList();
        void sync(true);
      }
    } catch (e) {
      error = (e as Error).message;
    }
  });
</script>

<main class="relative flex h-[560px] w-[420px] flex-col overflow-hidden bg-bg text-fg">
  {#if error}
    <div class="p-4 text-error">{error}</div>
  {:else if !app.st}
    <div class="flex flex-1 items-center justify-center text-dim">Loading…</div>
  {:else if app.st.state !== 'unlocked'}
    <Unlock />
  {:else if app.route.name === 'item'}
    {#key app.route.id}<Item id={app.route.id} />{/key}
  {:else if app.route.name === 'edit'}
    <Edit item={app.route.item} />
  {:else if app.route.name === 'settings'}
    <Settings />
  {:else}
    <List />
  {/if}

  {#if app.flash}
    <div
      class="absolute right-3 bottom-8 left-3 rounded-[8px] border bg-elev px-3 py-2 shadow-popover"
      class:border-error-border={app.flashError}
      class:text-error={app.flashError}
      class:border-line={!app.flashError}
      role="status"
    >
      {app.flash}
    </div>
  {/if}
</main>
