<script lang="ts">
  import { LoaderCircle, Lock } from '@lucide/svelte';
  import { DEFAULT_SERVER } from '@/lib/session';
  import ConfirmButton from '../components/ConfirmButton.svelte';
  import { rpc } from '../rpc';
  import { app, loadList, sync } from '../store.svelte';

  const loggedOut = $derived(app.st?.state === 'loggedOut');
  let server = $state(app.st?.server || DEFAULT_SERVER);
  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(e: Event) {
    e.preventDefault();
    if (!password || busy) return;
    busy = true;
    error = '';
    try {
      const { autofill, ...st } = await rpc('unlock', loggedOut ? { password, email, server } : { password });
      password = '';
      if (autofill) return window.close();
      app.st = st;
      app.route = { name: 'list' };
      await loadList();
      // Background login + sync was started by unlock; pick up its result.
      setTimeout(() => sync(true), 1500);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function logout() {
    app.st = await rpc('logout');
  }
</script>

<form class="flex flex-1 flex-col gap-3 p-5 pt-10" onsubmit={submit}>
  <div class="mb-2 flex flex-col items-center gap-2">
    <Lock size={28} class="text-accent" />
    <div class="text-[16px] font-semibold">Lightwarden</div>
    {#if !loggedOut}<div class="text-dim">{app.st?.email}</div>{/if}
  </div>

  {#if loggedOut}
    <label class="flex flex-col gap-1">
      <span class="label">Server URL</span>
      <input class="input" type="url" bind:value={server} required />
    </label>
    <label class="flex flex-col gap-1">
      <span class="label">Email</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="input" type="email" bind:value={email} required autocomplete="username" autofocus />
    </label>
  {/if}
  <label class="flex flex-col gap-1">
    <span class="label">Master password</span>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="input"
      type="password"
      bind:value={password}
      required
      autocomplete="current-password"
      autofocus={!loggedOut}
    />
  </label>
  {#if error}<div class="text-error">{error}</div>{/if}
  <button class="btn btn-primary justify-center py-1.5" disabled={busy}>
    {#if busy}<LoaderCircle size={14} class="spin" />{/if}
    {loggedOut ? 'Log in' : 'Unlock'}
  </button>
  {#if !loggedOut}
    <div class="self-center">
      <ConfirmButton class="text-dim hover:text-accent" ask="Log out and delete the local cache?" onconfirm={logout}
        >Log out</ConfirmButton
      >
    </div>
  {/if}
</form>
