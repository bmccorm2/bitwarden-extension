<script lang="ts">
  import { Check, Copy } from '@lucide/svelte';
  import { copy } from '../rpc';
  import { flash } from '../store.svelte';

  let { value, label = 'Copy' }: { value: string; label?: string } = $props();
  let done = $state(false);

  async function onclick(e: MouseEvent) {
    e.stopPropagation();
    try {
      await copy(value);
      done = true;
      setTimeout(() => (done = false), 1200);
    } catch (err) {
      flash(`Copy failed: ${(err as Error).message}`, true);
    }
  }
</script>

<button type="button" class="icon-btn" title={label} aria-label={label} {onclick}>
  {#if done}<Check size={14} class="text-ok" />{:else}<Copy size={14} />{/if}
</button>
