import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, 'src/domain'),
      '@surface': path.resolve(__dirname, 'src/surface'),
      '@policy': path.resolve(__dirname, 'src/policy'),
      '@artifact': path.resolve(__dirname, 'src/artifact'),
      '@evidence': path.resolve(__dirname, 'src/evidence'),
      '@agent': path.resolve(__dirname, 'src/agent'),
    },
  },
});
