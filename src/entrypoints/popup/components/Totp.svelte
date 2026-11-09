<script lang="ts">
  import { generateTotp, parseTotp } from '@/lib/totp';
  import CopyButton from './CopyButton.svelte';

  let { secret }: { secret: string } = $props();
  const spec = $derived(parseTotp(secret));
  let code = $state('');
  let remaining = $state(0);

  $effect(() => {
    const s = spec;
    if (!s) return;
    let alive = true;
    const tick = async () => {
      const r = await generateTotp(s, Date.now());
      if (alive) ({ code, remaining } = r);
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  });

  const pretty = $derived(code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
  const R = 7;
  const C = 2 * Math.PI * R;
</script>

{#if spec}
  <div class="flex items-center gap-2">
    <svg width="18" height="18" viewBox="0 0 18 18" class="shrink-0 -rotate-90" aria-label="{remaining}s left">
      <circle cx="9" cy="9" r={R} fill="none" stroke="var(--color-line)" stroke-width="2" />
      <circle
        cx="9"
        cy="9"
        r={R}
        fill="none"
        stroke="var(--color-running)"
        stroke-width="2"
        stroke-dasharray={C}
        stroke-dashoffset={C * (1 - remaining / spec.period)}
      />
    </svg>
    <span class="flex-1 font-mono text-[16px] tracking-wider text-running">{pretty}</span>
    <span class="text-[12px] text-faint">{remaining}s</span>
    <CopyButton value={code} label="Copy TOTP" />
  </div>
{:else}
  <span class="text-dim">unsupported</span>
{/if}
