import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readFileSync } from 'node:fs';

/** Reads LW_TEST_EMAIL from .env.local for the dev write lock (todo.md, Decision 19). */
function testEmail(): string {
  if (process.env.LW_TEST_EMAIL) return process.env.LW_TEST_EMAIL;
  if (!existsSync('.env.local')) return '';
  const m = readFileSync('.env.local', 'utf8').match(/^\s*LW_TEST_EMAIL\s*=\s*["']?([^"'\s]+)/m);
  return m?.[1] ?? '';
}

// `LW_RELEASE=1 bun run build` enables writes for every account. Without it, only the test account can write.
const release = process.env.LW_RELEASE === '1';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  srcDir: 'src',
  // MV3 everywhere (WXT defaults Firefox to MV2).
  manifestVersion: 3,
  modules: ['@wxt-dev/module-svelte'],
  vite: () => ({
    plugins: [tailwindcss()],
    define: {
      __LW_WRITE_LOCK__: JSON.stringify({ release, testEmail: release ? '' : testEmail() }),
    },
  }),
  manifest: ({ browser }) => ({
    name: 'Lightwarden',
    description: 'Minimal Bitwarden client for a self-hosted Vaultwarden server.',
    permissions: ['storage', 'tabs', 'clipboardWrite', 'scripting', 'alarms'],
    host_permissions: ['<all_urls>'],
    commands: {
      autofill: {
        suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' },
        description: 'Fill login (press again to cycle) or TOTP code',
      },
    },
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'lightwarden@mccormick.sh',
          strict_min_version: '121.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    }),
  }),
});
