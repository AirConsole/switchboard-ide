import { describe, expect, it } from 'vitest'
import { childEnv, isRunScriptVar, withoutRunScriptPath } from '../src/session/tmux.js'

/*
 * Measured on this machine: the tmux server had been started under `pnpm`, and
 * every terminal and agent inherited its `npm_config_prefix` -- naming a Node
 * nvm had since moved off, so `npm install -g` in a terminal here went into the
 * old one -- along with the repository's `node_modules/.bin` on PATH.
 */
describe('what a package manager adds to a script', () => {
  it('drops its variables', () => {
    expect(isRunScriptVar('npm_config_prefix')).toBe(true)
    expect(isRunScriptVar('npm_lifecycle_event')).toBe(true)
    expect(isRunScriptVar('NPM_CONFIG_USERCONFIG')).toBe(true)
    expect(isRunScriptVar('NVM_DIR')).toBe(false)
    expect(isRunScriptVar('PNPM_HOME')).toBe(false)
  })

  it('drops its PATH entries and keeps the rest in order', () => {
    // The tmux server's own PATH, verbatim apart from the plugin directories.
    const leaked = [
      '/home/andrin/src/ide/server/node_modules/.bin',
      '/home/andrin/src/ide/node_modules/.bin',
      '/home/andrin/src/node_modules/.bin',
      '/home/andrin/node_modules/.bin',
      '/home/node_modules/.bin',
      '/node_modules/.bin',
      '/home/andrin/.nvm/versions/node/v24.14.0/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin',
      '/home/andrin/.local/bin',
      '/home/andrin/.nvm/versions/node/v24.14.0/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':')
    expect(withoutRunScriptPath(leaked)).toBe(
      '/home/andrin/.local/bin:/home/andrin/.nvm/versions/node/v24.14.0/bin:/usr/local/bin:/usr/bin:/bin',
    )
  })

  it('is what a session is started with', () => {
    const saved = { ...process.env }
    try {
      process.env.npm_config_prefix = '/old/node'
      process.env.PATH = '/repo/node_modules/.bin:/usr/bin'
      const env = childEnv()
      expect(env.npm_config_prefix).toBeUndefined()
      expect(env.PATH).toBe('/usr/bin')
    } finally {
      process.env = saved
    }
  })
})
