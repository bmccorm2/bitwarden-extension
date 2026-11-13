<script lang="ts">
  import type { Snippet } from 'svelte';

  /** Two-click confirm. Replaces window.confirm(), which Firefox popups don't support. */
  let {
    ask,
    onconfirm,
    class: cls = 'btn',
    title,
    disabled = false,
    children,
  }: { ask: string; onconfirm: () => void; class?: string; title?: string; disabled?: boolean; children: Snippet } =
    $props();

  let armed = $state(false);
  let timer: ReturnType<typeof setTimeout>;

  function onclick() {
    clearTimeout(timer);
    if (armed) {
      armed = false;
      onconfirm();
      return;
    }
    armed = true;
    timer = setTimeout(() => (armed = false), 4000);
  }
</script>

{#if armed}
  <button type="button" class="btn border-error-border text-error" {disabled} {onclick}>{ask}</button>
{:else}
  <button type="button" class={cls} {title} aria-label={title} {disabled} {onclick}>{@render children()}</button>
{/if}
