import { defineConfig } from 'vitest/config'

/**
 * One runner for all three packages, split into projects because they do not
 * agree about what a global is: `server` and `shared` run in node, and `web`
 * needs a DOM.
 *
 * Tests live in each package's `test/` rather than beside the source, so that
 * `tsc -p tsconfig.json` -- which is the build -- keeps emitting `src` and
 * nothing else. `tsconfig.test.json` next to it is what typechecks them.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: 'shared',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          root: 'server',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web',
          root: 'web',
          environment: 'jsdom',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['*/src/**/*.ts'],
      // The layers this suite deliberately does not reach: React components,
      // the pty/tmux engine, and the wiring that only exists to bolt them
      // together. They are driven in a browser against scripts/scratch.sh.
      exclude: ['web/src/**/*.tsx', 'server/src/session/{engine,tmux,mirror}.ts'],
    },
  },
})
