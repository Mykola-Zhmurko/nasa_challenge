import path from 'node:path'

const rootDir = import.meta.dirname

export default {
  plugins: [
    {
      name: 'vitest-basic-reporter-compat',
      resolveId(id: string) {
        if (id === 'basic') return '\0virtual:basic-reporter'
      },
      load(id: string) {
        if (id === '\0virtual:basic-reporter') {
          return `import { DefaultReporter } from '/usr/local/lib/hermes-agent/node_modules/vitest/dist/node.js'; export default class BasicReporter extends DefaultReporter { constructor(opts = {}) { super({ ...opts, summary: false }); } }`
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
      '@lib': path.resolve(rootDir, 'lib'),
      '@components': path.resolve(rootDir, 'src/components'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}
