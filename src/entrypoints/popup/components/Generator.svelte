<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import { DEFAULT_GEN, generatePassword, type GenOptions } from '@/lib/generator';

  let { onuse, onclose }: { onuse: (pw: string) => void; onclose: () => void } = $props();
  let opts = $state<GenOptions>({ ...DEFAULT_GEN });
  let pw = $state('');
  const regen = () => (pw = generatePassword($state.snapshot(opts)));
  $effect(() => {
    void [opts.length, opts.upper, opts.lower, opts.digits, opts.symbols];
    regen();
  });
  const SETS = [
    ['upper', 'A-Z'],
    ['lower', 'a-z'],
    ['digits', '0-9'],
    ['symbols', '!@#'],
  ] as const;
</script>

<div class="mt-1 space-y-2 rounded-[8px] border border-line bg-sidebar p-2.5 shadow-popover">
  <div class="flex items-center gap-1">
    <span class="min-w-0 flex-1 font-mono text-[13px] break-all select-text">{pw}</span>
    <button type="button" class="icon-btn" title="Regenerate" onclick={regen}><RefreshCw size={14} /></button>
  </div>
  <label class="flex items-center gap-2">
    <span class="w-14 text-dim">Length</span>
    <input type="range" min="8" max="128" bind:value={opts.length} class="flex-1 accent-accent" />
    <input type="number" min="8" max="128" bind:value={opts.length} class="input w-14 px-1 py-0.5" />
  </label>
  <div class="flex gap-3">
    {#each SETS as [k, label] (k)}
      <label class="flex items-center gap-1">
        <input
          type="checkbox"
          class="accent-accent"
          bind:checked={opts[k]}
          disabled={opts[k] && SETS.filter(([s]) => opts[s]).length === 1}
        />{label}
      </label>
    {/each}
  </div>
  <div class="flex justify-end gap-1.5">
    <button type="button" class="btn" onclick={onclose}>Cancel</button>
    <button type="button" class="btn btn-primary" onclick={() => onuse(pw)}>Use password</button>
  </div>
</div>
