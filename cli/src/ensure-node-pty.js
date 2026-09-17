/**
 * node-pty ships prebuilt binaries for darwin and win32 only, so on Linux it has
 * to compile. pnpm blocks dependency build scripts by default (and honouring
 * `onlyBuiltDependencies` proved unreliable across pnpm versions), so we own the
 * step instead of hoping the package manager runs it. Idempotent: exits
 * immediately when a usable binary is already present.
 *
 * This runs from `postinstall`, i.e. before anything in the workspace has been
 * built, which is why the whole CLI is plain JavaScript with no build step.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { repoRoot } from './instance.js'

/*
 * Anchored inside the `server` package, because that is where `node-pty` is a
 * dependency -- under pnpm's isolated layout it is linked into
 * `server/node_modules`, not the workspace root. Resolving from anywhere else
 * throws, and the catch below turns that into a cheerful "skipping" and an exit
 * code of 0: a silent no-op that leaves the install with no pty at all.
 */
const require = createRequire(join(repoRoot, 'server', 'index.js'))

/**
 * Does the compiled module actually load?
 *
 * The check this replaced asked only whether `pty.node` *existed*, which is why
 * `pnpm ensure-native` could never do the job it is documented for -- "rebuild
 * node-pty if a Node upgrade left it ABI-stale". A stale binary exists; it just
 * cannot be loaded, and a Node major upgrade is exactly what makes that happen.
 * Loading it in a child so a failed `dlopen` cannot take this process with it.
 * @param {string} pkgDir
 */
const loads = (pkgDir) => {
  try {
    execFileSync(process.execPath, ['-e', 'require(process.argv[1])', pkgDir], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

export const ensureNodePty = () => {
  let pkgDir
  try {
    pkgDir = dirname(require.resolve('node-pty/package.json'))
  } catch {
    console.log('[ensure-node-pty] node-pty not installed yet; skipping')
    return
  }

  if (loads(pkgDir)) {
    console.log('[ensure-node-pty] native module present')
    return
  }

  console.log(`[ensure-node-pty] building for ${process.platform}-${process.arch}...`)
  /** @param {string} cmd @param {string[]} args */
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: pkgDir, stdio: 'inherit' })
  try {
    run('node', ['scripts/prebuild.js'])
  } catch {
    // prebuild.js only downloads/copies prebuilts; compiling is the real fallback.
  }
  if (!loads(pkgDir)) run('npx', ['--yes', 'node-gyp', 'rebuild'])

  if (!loads(pkgDir)) {
    console.error('[ensure-node-pty] build failed: no loadable pty.node produced')
    process.exit(1)
  }
  console.log('[ensure-node-pty] built ok')
}
