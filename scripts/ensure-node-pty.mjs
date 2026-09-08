/**
 * node-pty ships prebuilt binaries for darwin and win32 only, so on Linux it has
 * to compile. pnpm blocks dependency build scripts by default (and honouring
 * `onlyBuiltDependencies` proved unreliable across pnpm versions), so we own the
 * step instead of hoping the package manager runs it. Idempotent: exits
 * immediately when a usable binary is already present.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(join(import.meta.dirname, '../server/index.js'))

let pkgDir
try {
  pkgDir = dirname(require.resolve('node-pty/package.json'))
} catch {
  console.log('[ensure-node-pty] node-pty not installed yet; skipping')
  process.exit(0)
}

const candidates = [
  join(pkgDir, 'build', 'Release', 'pty.node'),
  join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'),
]
if (candidates.some(existsSync)) {
  console.log('[ensure-node-pty] native module present')
  process.exit(0)
}

console.log(`[ensure-node-pty] building for ${process.platform}-${process.arch}...`)
const run = (cmd, args) => execFileSync(cmd, args, { cwd: pkgDir, stdio: 'inherit' })
try {
  run('node', ['scripts/prebuild.js'])
} catch {
  // prebuild.js only downloads/copies prebuilts; compiling is the real fallback.
}
if (!candidates.some(existsSync)) run('npx', ['--yes', 'node-gyp', 'rebuild'])

if (!candidates.some(existsSync)) {
  console.error('[ensure-node-pty] build failed: no pty.node produced')
  process.exit(1)
}
console.log('[ensure-node-pty] built ok')
