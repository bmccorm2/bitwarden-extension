<script lang="ts">
  import { CreditCard, IdCard, KeyRound, StickyNote, Terminal } from '@lucide/svelte';

  let { type, class: cls = '' }: { type: number; class?: string } = $props();
  const Icon = $derived(
    { 1: KeyRound, 2: StickyNote, 3: CreditCard, 4: IdCard, 5: Terminal }[type] ?? StickyNote,
  );
</script>

<Icon size={14} class={cls} />
