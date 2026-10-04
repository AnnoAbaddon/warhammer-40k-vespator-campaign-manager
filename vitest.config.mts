import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // server-only wirft außerhalb von React-Server-Komponenten – in Tests die leere Variante nutzen
      'server-only': path.resolve(import.meta.dirname, 'node_modules/server-only/empty.js'),
    },
  },
  // Großzügige Zeitlimits: Server-Tests hashen Passwörter (Argon2) und laden Module neu – unter paralleler Last
  // (Windows, CI-Runner) dauert das deutlich länger als die Standardwerte von 5 s / 10 s
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 30_000, hookTimeout: 60_000 },
});
