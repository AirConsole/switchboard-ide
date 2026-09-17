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
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
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

/**
 * Make node-pty's `spawn-helper` executable, wherever a copy of it is.
 *
 * On macOS node-pty does not fork the shell itself: it `posix_spawn`s this
 * helper, which sets up the terminal and then execs the shell. node-pty 1.1.0
 * publishes the helper in its darwin prebuilds as mode 0644 -- read from the
 * registry tarball, both `darwin-arm64` and `darwin-x64` -- and nothing in its
 * own install scripts sets the bit. So on a fresh Mac `pty.node` loads, the
 * check below passes, and every session then fails with
 * `posix_spawnp failed.`: no agent, no terminal, nothing in the row works.
 * Linux never runs the helper, which is why it was not seen here.
 *
 * Done before the load check and on every platform, because the load check
 * cannot see this -- the module loads fine -- and setting a bit that is
 * already set, or on a file Linux ignores, costs nothing.
 * @param {string} pkgDir
 * @returns {string[]} the helpers that were not executable before
 */
export const makeHelpersExecutable = (pkgDir) => {
  const candidates = [join(pkgDir, 'build', 'Release', 'spawn-helper')]
  const prebuilds = join(pkgDir, 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) candidates.push(join(prebuilds, dir, 'spawn-helper'))
  }
  /** @type {string[]} */
  const fixed = []
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const mode = statSync(file).mode
    if ((mode & 0o111) === 0o111) continue
    chmodSync(file, mode | 0o755)
    fixed.push(file)
  }
  return fixed
}

export const ensureNodePty = () => {
  let pkgDir
  try {
    pkgDir = dirname(require.resolve('node-pty/package.json'))
  } catch {
    console.log('[ensure-node-pty] node-pty not installed yet; skipping')
    return
  }

  for (const file of makeHelpersExecutable(pkgDir)) {
    console.log(`[ensure-node-pty] made executable: ${file}`)
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
  // A compile writes a fresh helper into build/Release; its mode is the
  // compiler's, which is right, but the sweep is cheap and says so for certain.
  makeHelpersExecutable(pkgDir)

  if (!loads(pkgDir)) {
    console.error('[ensure-node-pty] build failed: no loadable pty.node produced')
    process.exit(1)
  }
  console.log('[ensure-node-pty] built ok')
}
