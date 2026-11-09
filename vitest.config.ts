import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  // Dev write lock in tests: only this fake account may write (and fetch is always mocked).
  define: { __LW_WRITE_LOCK__: JSON.stringify({ release: false, testEmail: 'writer@lightwarden.invalid' }) },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
  },
});
