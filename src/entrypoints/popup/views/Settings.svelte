<script lang="ts">
  import { ArrowLeft, ExternalLink, Lock, LogOut, X } from '@lucide/svelte';
  import { browser } from 'wxt/browser';
  import ConfirmButton from '../components/ConfirmButton.svelte';
  import { rpc } from '../rpc';
  import { app, go } from '../store.svelte';

  let server = $state('');
  let never = $state<string[]>([]);
  let firefox = $state(false);
  let shortcut = $state('');
  let lockAfter = $state(0);

  const LOCK_OPTIONS = [
    [0, 'When the browser closes'],
    [1, '1 minute'],
    [5, '5 minutes'],
    [15, '15 minutes'],
    [30, '30 minutes'],
    [60, '1 hour'],
    [240, '4 hours'],
    [480, '8 hours'],
  ] as const;

  $effect(() => {
    void rpc('settings').then((s) => {
      server = s.server;
      never = s.neverDomains;
      firefox = s.firefox;
      lockAfter = s.lockAfter;
    });
    void browser.commands.getAll().then((cmds) => {
      shortcut = cmds.find((c) => c.name === 'autofill')?.shortcut || '';
    });
  });

  async function remove(host: string) {
    never = await rpc('removeNever', { host });
  }

  function openShortcuts() {
    void browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }

  async function lock() {
    app.st = await rpc('lock');
    app.rows = [];
  }

  async function logout() {
    app.st = await rpc('logout');
    app.rows = [];
  }
</script>

<header class="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-2">
  <button class="icon-btn" title="Back" onclick={() => go({ name: 'list' })}><ArrowLeft size={14} /></button>
  <span class="font-semibold">Settings</span>
</header>

<div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
  <section class="space-y-1">
    <div class="label">Account</div>
    <div>{app.st?.email}</div>
    <div class="text-dim">{server}</div>
    <div class="text-[12px] text-faint">Log out to change the server.</div>
    {#if !app.st?.writable}
      <div class="text-[12px] text-faint">Writes disabled for this account (dev write lock).</div>
    {/if}
  </section>

  <section class="space-y-1">
    <div class="label">Lock after inactivity</div>
    <select
      class="input"
      bind:value={lockAfter}
      onchange={() => void rpc('setLockAfter', { minutes: lockAfter })}
    >
      {#each LOCK_OPTIONS as [m, label] (m)}<option value={m}>{label}</option>{/each}
    </select>
    <div class="text-[12px] text-faint">Always locks when the browser closes.</div>
  </section>

  <section class="space-y-1">
    <div class="label">Autofill shortcut</div>
    <div>
      <span class="rounded-[4px] bg-elev px-1.5 py-px font-mono">{shortcut || 'not set'}</span>
      <span class="text-dim">: fill login, press again to cycle</span>
    </div>
    {#if firefox}
      <div class="text-dim">Change it in about:addons → gear menu → Manage Extension Shortcuts.</div>
    {:else}
      <button class="btn" onclick={openShortcuts}><ExternalLink size={14} />chrome://extensions/shortcuts</button>
      <div class="text-[12px] text-faint">In Arc: arc://extensions/shortcuts</div>
    {/if}
  </section>

  <section class="space-y-1">
    <div class="label">Never offer to save on</div>
    {#each never as host (host)}
      <div class="flex items-center gap-1 rounded-[6px] bg-elev px-2 py-0.5">
        <span class="flex-1 truncate">{host}</span>
        <button class="icon-btn" title="Remove" onclick={() => remove(host)}><X size={14} /></button>
      </div>
    {:else}
      <div class="text-dim">No sites</div>
    {/each}
  </section>

  <section class="flex gap-2">
    <button class="btn" onclick={lock}><Lock size={14} />Lock</button>
    <ConfirmButton ask="Log out and delete the local cache?" onconfirm={logout}><LogOut size={14} />Log out</ConfirmButton>
  </section>
</div>
