<script lang="ts">
  import { Eye, EyeOff } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import CopyButton from './CopyButton.svelte';

  let {
    label,
    value = '',
    secret = false,
    mono = false,
    display,
    children,
  }: {
    label: string;
    value?: string;
    secret?: boolean;
    mono?: boolean;
    /** Formatted text shown when revealed; copy still uses `value`. */
    display?: string;
    children?: Snippet;
  } = $props();
  let shown = $state(false);
</script>

<div class="border-b border-hairline px-3 py-1.5">
  <div class="label mb-0.5">{label}</div>
  {#if children}
    {@render children()}
  {:else}
    <div class="flex items-center gap-1">
      <span class="min-w-0 flex-1 break-all select-text" class:font-mono={secret || mono}>
        {secret && !shown ? '•'.repeat(Math.min(value.length, 16)) : (display ?? value)}
      </span>
      {#if secret}
        <button type="button" class="icon-btn" title={shown ? 'Hide' : 'Show'} onclick={() => (shown = !shown)}>
          {#if shown}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
        </button>
      {/if}
      <CopyButton {value} label="Copy {label.toLowerCase()}" />
    </div>
  {/if}
</div>
