<script lang="ts">
  import { ArrowLeft, Dices, Eye, EyeOff, LoaderCircle, Plus, Star, X } from '@lucide/svelte';
  import { CARD_FIELDS, IDENTITY_FIELDS, type CipherView } from '@/lib/types';
  import Generator from '../components/Generator.svelte';
  import { rpc } from '../rpc';
  import { app, flash, go, loadList } from '../store.svelte';

  let { item: initial }: { item: CipherView } = $props();
  // Edit a private copy; `initial` is the decrypted original.
  // svelte-ignore state_referenced_locally
  let item = $state<CipherView>($state.snapshot(initial) as CipherView);
  let busy = $state(false);
  let error = $state('');
  let showPw = $state(false);
  let showGen = $state(false);

  // svelte-ignore state_referenced_locally
  const isNew = !initial.id;
  const TYPE_NAME: Record<number, string> = { 1: 'login', 2: 'note', 3: 'card', 4: 'identity' };
  const MATCH = [
    [null, 'Default (base domain)'],
    [0, 'Base domain'],
    [1, 'Host'],
    [2, 'Starts with'],
    [3, 'Exact'],
    [4, 'Regular expression'],
    [5, 'Never'],
  ] as const;
  const LABELS: Record<string, string> = {
    cardholderName: 'Cardholder name',
    brand: 'Brand',
    number: 'Number',
    expMonth: 'Exp. month',
    expYear: 'Exp. year',
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
    passportNumber: 'Passport no.',
    licenseNumber: 'License no.',
  };
  const HALF = new Set(['expMonth', 'expYear', 'firstName', 'lastName', 'city', 'state', 'postalCode', 'country']);

  function back() {
    go(isNew ? { name: 'list' } : { name: 'item', id: initial.id! });
  }

  async function save(e: Event) {
    e.preventDefault();
    if (!item.name.trim()) {
      error = 'Name is required';
      return;
    }
    busy = true;
    error = '';
    try {
      const view = $state.snapshot(item) as CipherView;
      if (view.login) {
        // Drop blank rows the user added, but leave the original list untouched if nothing else changed.
        const blank = (u: { uri: string; match: number | null }) => !u.uri.trim() && u.match === null;
        const cleaned = view.login.uris.filter((u) => !blank(u));
        const orig = initial.login?.uris ?? [];
        const same = (a: typeof cleaned, b: typeof cleaned) =>
          a.length === b.length && a.every((u, i) => u.uri === b[i]!.uri && u.match === b[i]!.match);
        view.login.uris = same(cleaned, orig.filter((u) => !blank(u))) ? ($state.snapshot(orig) as typeof cleaned) : cleaned;
      }
      const saved = await rpc('save', { view });
      await loadList();
      flash(isNew ? 'Created' : 'Saved');
      go({ name: 'item', id: saved.id! });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

{#snippet text(label: string, get: () => string, set: (v: string) => void, opts: { secret?: boolean; mono?: boolean } = {})}
  <label class="flex min-w-0 flex-col gap-0.5">
    <span class="label">{label}</span>
    <input
      class="input"
      class:font-mono={opts.mono}
      type={opts.secret ? 'password' : 'text'}
      autocomplete="off"
      spellcheck="false"
      value={get()}
      oninput={(e) => set(e.currentTarget.value)}
    />
  </label>
{/snippet}

<form class="contents" onsubmit={save}>
  <header class="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-2">
    <button type="button" class="icon-btn" title="Cancel" onclick={back}><ArrowLeft size={14} /></button>
    <span class="flex-1 truncate font-semibold">{isNew ? `New ${TYPE_NAME[item.type]}` : `Edit ${initial.name}`}</span>
    <button type="button" class="btn" onclick={back}>Cancel</button>
    <button class="btn btn-primary" disabled={busy || !app.st?.writable}>
      {#if busy}<LoaderCircle size={14} class="spin" />{/if}Save
    </button>
  </header>

  <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
    {#if !app.st?.writable}
      <div class="rounded-[6px] border-b-2 border-banner-border bg-banner-bg px-2.5 py-1.5 text-banner-text">
        Writes are disabled for this account in this build (dev write lock).
      </div>
    {/if}
    {#if error}<div class="rounded-[6px] border border-error-border px-2.5 py-1.5 text-error">{error}</div>{/if}

    <div class="flex items-end gap-2">
      <div class="flex-1">
        {@render text('Name', () => item.name, (v) => (item.name = v))}
      </div>
      <button
        type="button"
        class="icon-btn mb-1"
        title={item.favorite ? 'Unfavorite' : 'Favorite'}
        onclick={() => (item.favorite = !item.favorite)}
      >
        <Star size={14} class={item.favorite ? 'fill-current text-accent' : ''} />
      </button>
    </div>

    <label class="flex flex-col gap-0.5">
      <span class="label">Folder</span>
      <select class="input" bind:value={item.folderId}>
        <option value={null}>No folder</option>
        {#each app.folders as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
      </select>
    </label>

    {#if item.login}
      {@const l = item.login}
      {@render text('Username', () => l.username, (v) => (l.username = v))}
      <div class="flex flex-col gap-0.5">
        <span class="label">Password</span>
        <div class="flex items-center gap-1">
          <input
            class="input font-mono"
            type={showPw ? 'text' : 'password'}
            autocomplete="new-password"
            bind:value={l.password}
          />
          <button type="button" class="icon-btn" title={showPw ? 'Hide' : 'Show'} onclick={() => (showPw = !showPw)}>
            {#if showPw}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
          </button>
          <button type="button" class="icon-btn" title="Generate" onclick={() => (showGen = !showGen)}><Dices size={14} /></button>
        </div>
        {#if showGen}
          <Generator
            onuse={(pw) => {
              l.password = pw;
              showGen = false;
              showPw = true;
            }}
            onclose={() => (showGen = false)}
          />
        {/if}
        {#if !isNew && initial.login?.password && l.password !== initial.login.password}
          <span class="text-[12px] text-dim">The old password will be kept in the password history.</span>
        {/if}
      </div>
      {@render text('TOTP secret', () => l.totp, (v) => (l.totp = v), { mono: true })}

      <div class="flex flex-col gap-1">
        <span class="label">Websites</span>
        {#each l.uris as u, i (i)}
          <div class="flex items-center gap-1">
            <input class="input min-w-0 flex-1" placeholder="https://" bind:value={u.uri} spellcheck="false" />
            <select class="input w-[92px] shrink-0 px-1" bind:value={u.match} title="Match detection">
              {#each MATCH as [v, label] (label)}<option value={v}>{label}</option>{/each}
            </select>
            <button type="button" class="icon-btn" title="Remove" onclick={() => l.uris.splice(i, 1)}><X size={14} /></button>
          </div>
        {/each}
        <button type="button" class="btn self-start" onclick={() => l.uris.push({ uri: '', match: null })}>
          <Plus size={14} />Add website
        </button>
      </div>
      {#if l.passkeys.length}
        <div class="text-dim">Passkey: yes (kept unchanged)</div>
      {/if}
    {/if}

    {#if item.card}
      {@const c = item.card as Record<string, string>}
      <div class="grid grid-cols-2 gap-2">
        {#each CARD_FIELDS as k (k)}
          <div class={HALF.has(k) ? '' : 'col-span-2'}>
            {@render text(LABELS[k]!, () => c[k] ?? '', (v) => (c[k] = v), { secret: k === 'code' || k === 'number' })}
          </div>
        {/each}
      </div>
    {/if}

    {#if item.identity}
      {@const c = item.identity as Record<string, string>}
      <div class="grid grid-cols-2 gap-2">
        {#each IDENTITY_FIELDS as k (k)}
          <div class={HALF.has(k) || k === 'title' || k === 'middleName' ? '' : 'col-span-2'}>
            {@render text(LABELS[k]!, () => c[k] ?? '', (v) => (c[k] = v))}
          </div>
        {/each}
      </div>
    {/if}

    <label class="flex flex-col gap-0.5">
      <span class="label">Notes</span>
      <textarea class="input min-h-20 resize-y" rows={item.type === 2 ? 8 : 3} bind:value={item.notes}></textarea>
    </label>

    <div class="flex flex-col gap-1">
      <span class="label">Custom fields</span>
      {#each item.fields as f, i (i)}
        {#if f.type === 3}
          <div class="flex items-center gap-1 text-dim">
            <span class="flex-1 truncate">{f.name} (linked field, read-only)</span>
          </div>
        {:else}
          <div class="flex items-center gap-1">
            <input class="input w-[110px] shrink-0" placeholder="Name" bind:value={f.name} />
            {#if f.type === 2}
              <label class="flex flex-1 items-center gap-1.5 px-1">
                <input
                  type="checkbox"
                  class="accent-accent"
                  checked={f.value === 'true'}
                  onchange={(e) => (f.value = e.currentTarget.checked ? 'true' : 'false')}
                />{f.value === 'true' ? 'Yes' : 'No'}
              </label>
            {:else}
              <input
                class="input min-w-0 flex-1"
                class:font-mono={f.type === 1}
                type={f.type === 1 ? 'password' : 'text'}
                autocomplete="off"
                placeholder="Value"
                bind:value={f.value}
              />
            {/if}
            <select
              class="input w-[70px] shrink-0 px-1"
              value={f.type}
              onchange={(e) => {
                f.type = Number(e.currentTarget.value);
                if (f.type === 2) f.value = f.value === 'true' ? 'true' : 'false';
              }}
            >
              <option value={0}>Text</option>
              <option value={1}>Hidden</option>
              <option value={2}>Boolean</option>
            </select>
            <button type="button" class="icon-btn" title="Remove" onclick={() => item.fields.splice(i, 1)}><X size={14} /></button>
          </div>
        {/if}
      {/each}
      <button
        type="button"
        class="btn self-start"
        onclick={() => item.fields.push({ name: '', value: '', type: 0, linkedId: null })}
      >
        <Plus size={14} />Add field
      </button>
    </div>
  </div>
</form>
