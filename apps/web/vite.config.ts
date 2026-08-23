import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js depends on buffer@4, which references Node's `global`.
  // The production build resolves this, but dev dependency pre-bundling does not, so
  // the app threw `global is not defined` before React mounted and every route in
  // `pnpm web:dev` rendered blank. Scoped to optimizeDeps to leave the build untouched.
  optimizeDeps: {
    esbuildOptions: {
      define: { global: 'globalThis' },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
  },
});
