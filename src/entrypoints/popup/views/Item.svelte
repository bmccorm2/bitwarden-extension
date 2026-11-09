<script lang="ts">
  import { ArrowLeft, ExternalLink, LoaderCircle, Pencil, RotateCcw, Star, Trash, Undo2 } from '@lucide/svelte';
  import { CARD_FIELDS, IDENTITY_FIELDS, type CipherView } from '@/lib/types';
  import CopyButton from '../components/CopyButton.svelte';
  import Field from '../components/Field.svelte';
  import Totp from '../components/Totp.svelte';
  import TypeIcon from '../components/TypeIcon.svelte';
  import { rpc } from '../rpc';
  import { app, flash, go, loadList } from '../store.svelte';

  let { id }: { id: string } = $props();
  let item = $state<CipherView | null>(null);
  let canRevert = $state(false);
  let error = $state('');
  let busy = $state(false);
  let showHistory = $state(false);

  const LABELS: Record<string, string> = {
    cardholderName: 'Cardholder name',
    brand: 'Brand',
    number: 'Number',
    expMonth: 'Expiry month',
    expYear: 'Expiry year',
    code: 'Security code',
    title: 'Title',
    firstName: 'First name',
    middleName: 'Middle name',
    lastName: 'Last name',
    address1: 'Address 1',
    address2: 'Address 2',
    address3: 'Address 3',
    city: 'City',
    state: 'State',
    postalCode: 'Postal code',
    country: 'Country',
    company: 'Company',
    email: 'Email',
    phone: 'Phone',
    ssn: 'SSN',
    username: 'Username',
    passportNumber: 'Passport number',
    licenseNumber: 'License number',
  };
  const SECRET = new Set(['number', 'code', 'ssn', 'passportNumber', 'licenseNumber']);

  /** Group card digits: Amex 4-6-5, everything else in fours. */
  function fmtCard(n: string) {
    const d = n.replace(/[\s-]/g, '');
    if (!/^\d+$/.test(d)) return n;
    if (/^3[47]\d{13}$/.test(d)) return `${d.slice(0, 4)} ${d.slice(4, 10)} ${d.slice(10)}`;
    return d.replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  async function load() {
    try {
      const r = await rpc('get', { id });
      item = r.item;
      canRevert = r.canRevert;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void id;
    void load();
  });

  const folderName = $derived(app.folders.find((f) => f.id === item?.folderId)?.name ?? 'No folder');
  const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '');
  const isHttp = (u: string) => /^https?:\/\//i.test(u);

  async function act(kind: 'trash' | 'restore' | 'revert') {
    const ask = {
      trash: 'Move this item to the trash?',
      restore: 'Restore this item from the trash?',
      revert: 'Write the previous version of this item back to the server?',
    }[kind];
    if (!confirm(ask)) return;
    busy = true;
    try {
      if (kind === 'trash') {
        await rpc('trash', { id });
        flash('Moved to trash');
      } else {
        await rpc(kind, { id });
        flash(kind === 'restore' ? 'Restored' : 'Reverted');
      }
      await loadList();
      await load();
    } catch (e) {
      flash((e as Error).message, true);
      await loadList().catch(() => {});
      await load();
    } finally {
      busy = false;
    }
  }
</script>

<header class="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-2">
  <button class="icon-btn" title="Back" onclick={() => go({ name: 'list' })}><ArrowLeft size={14} /></button>
  {#if item}
    <TypeIcon type={item.type} class="ml-1 shrink-0 text-dim" />
    <span class="min-w-0 flex-1 truncate font-semibold">{item.name}</span>
    {#if item.favorite}<Star size={12} class="text-accent" />{/if}
    {#if busy}<LoaderCircle size={14} class="spin text-running" />{/if}
    {#if item.type !== 5}
      {#if item.deletedDate}
        <button class="btn" disabled={busy} onclick={() => act('restore')}><RotateCcw size={14} />Restore</button>
      {:else}
        <button class="icon-btn" title="Edit" disabled={busy} onclick={() => go({ name: 'edit', item: $state.snapshot(item!) })}
          ><Pencil size={14} /></button
        >
        <button class="icon-btn" title="Move to trash" disabled={busy} onclick={() => act('trash')}
          ><Trash size={14} /></button
        >
      {/if}
    {/if}
  {:else}
    <span class="flex-1"></span>
  {/if}
</header>

<div class="min-h-0 flex-1 overflow-y-auto pb-3">
  {#if error}
    <div class="p-4 text-error">{error}</div>
  {:else if item}
    {#if item.deletedDate}
      <div class="border-b border-line bg-elev px-3 py-1.5 text-dim">In trash since {fmt(item.deletedDate)}</div>
    {/if}
    {#if item.login}
      {@const l = item.login}
      {#if l.username}<Field label="Username" value={l.username} />{/if}
      {#if l.password}<Field label="Password" value={l.password} secret />{/if}
      {#if l.totp}
        <Field label="TOTP"><Totp secret={l.totp} /></Field>
      {/if}
      {#each l.uris as u, i (i)}
        {#if u.uri}
          <Field label={l.uris.length > 1 ? `Website ${i + 1}` : 'Website'}>
            <div class="flex items-center gap-1">
              {#if isHttp(u.uri)}
                <a class="min-w-0 flex-1 truncate text-accent hover:underline" href={u.uri} target="_blank" rel="noreferrer"
                  >{u.uri}</a
                >
                <ExternalLink size={12} class="text-faint" />
              {:else}
                <span class="min-w-0 flex-1 truncate">{u.uri}</span>
              {/if}
              <CopyButton value={u.uri} label="Copy URL" />
            </div>
          </Field>
        {/if}
      {/each}
      {#each l.passkeys as created, i (i)}
        <Field label="Passkey"><span>yes (created {fmt(created) || 'unknown'})</span></Field>
      {/each}
    {/if}
    {#if item.card}
      {@const c = item.card as Record<string, string>}
      {#each CARD_FIELDS as k (k)}
        {#if c[k]}<Field
            label={LABELS[k]!}
            value={c[k]}
            secret={SECRET.has(k)}
            display={k === 'number' ? fmtCard(c[k]) : undefined}
          />{/if}
      {/each}
    {/if}
    {#if item.identity}
      {@const c = item.identity as Record<string, string>}
      {#each IDENTITY_FIELDS as k (k)}
        {#if c[k]}<Field label={LABELS[k]!} value={c[k]} secret={SECRET.has(k)} />{/if}
      {/each}
    {/if}
    {#each item.fields as f, i (i)}
      {#if f.type === 3}
        <Field label={f.name || 'Linked field'}><span class="text-dim">Linked field ({f.linkedId})</span></Field>
      {:else if f.type === 2}
        <Field label={f.name || 'Field'} value={f.value === 'true' ? 'Yes' : 'No'} />
      {:else if f.value || f.name}
        <Field label={f.name || 'Field'} value={f.value} secret={f.type === 1} />
      {/if}
    {/each}
    {#if item.notes}
      <Field label="Notes">
        <div class="flex items-start gap-1">
          <pre class="max-h-48 min-w-0 flex-1 overflow-y-auto font-sans break-words whitespace-pre-wrap select-text">{item.notes}</pre>
          <CopyButton value={item.notes} label="Copy notes" />
        </div>
      </Field>
    {/if}
    {#if item.passwordHistory.length}
      <Field label="Password history">
        <button class="text-dim hover:text-accent" onclick={() => (showHistory = !showHistory)}>
          {item.passwordHistory.length} previous {item.passwordHistory.length === 1 ? 'password' : 'passwords'}
        </button>
        {#if showHistory}
          {#each item.passwordHistory as h, i (i)}
            <div class="mt-1 flex items-center gap-1">
              <span class="min-w-0 flex-1 truncate font-mono">{h.password}</span>
              <span class="text-[12px] text-faint">{fmt(h.lastUsedDate)}</span>
              <CopyButton value={h.password} />
            </div>
          {/each}
        {/if}
      </Field>
    {/if}
    <div class="space-y-0.5 px-3 pt-2 text-[12px] text-faint">
      <div>Folder: {folderName}</div>
      {#if item.revisionDate}<div>Updated {fmt(item.revisionDate)}</div>{/if}
      {#if item.reprompt}<div>Master password re-prompt is set (not enforced)</div>{/if}
      {#if item.type === 5}<div>SSH keys are read-only in Lightwarden.</div>{/if}
    </div>
    {#if canRevert && !item.deletedDate}
      <div class="px-3 pt-3">
        <button class="btn" disabled={busy} onclick={() => act('revert')}><Undo2 size={14} />Revert to previous version</button>
      </div>
    {/if}
  {:else}
    <div class="p-4 text-dim">Loading…</div>
  {/if}
</div>
