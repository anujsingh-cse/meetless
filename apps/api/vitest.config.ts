import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@meetless/shared': path.resolve(__dirname, '../../packages/shared/dist'),
      '@meetless/database': path.resolve(__dirname, '../../packages/database/dist'),
    },
  },
})