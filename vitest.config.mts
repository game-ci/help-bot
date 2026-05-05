import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/utils/**/*.ts', 'src/social/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts'],
    },
  },
})
