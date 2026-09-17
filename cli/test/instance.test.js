import { describe, expect, it } from 'vitest'
import {
  PORT_FLOOR,
  PORT_SPAN,
  assertScratchPaths,
  deriveScratch,
  isOurServer,
  portCandidates,
  scratchEnv,
  validateName,
} from '../src/instance.js'

/**
 * These are the derivations a mistake in points `rm -rf` or a `kill` at the
 * wrong thing, which is why they are the part of this CLI with tests.
 */
describe('deriveScratch', () => {
  /*
   * Measured against the shell this replaced, not recomputed here -- the point
   * is that the Node port agrees with `printf '%s' "$REPO$NAME" | sha1sum |
   * cut -c1-6` byte for byte, and a test that hashed the input itself would
   * agree with any implementation including a wrong one.
   *
   *   $ printf '%s' "/home/andrin/src/ide" | sha1sum | cut -c1-6
   *   5ce014
   *
   * It matters because the hash decides the port, the state directory and the
   * tmux socket: change it and a running instance is orphaned, leaving a stray
   * server and a stray tmux server with no handle left to reach them. The third
   * fixture is a directory that was on this machine when this was written.
   */
  it('reproduces the shell derivation exactly', () => {
    expect(deriveScratch('/home/andrin/src/ide').hash).toBe('5ce014')
    expect(deriveScratch('/home/andrin/src/ide/.claude/worktrees/remote').hash).toBe('15f26a')
    expect(deriveScratch('/repo/a b/ide').hash).toBe('c86a1d')
  })

  // Appended with no separator, so the unnamed instance hashes the bare repo
  // path exactly as it always has. `sha1("<repo>peer")`, not `sha1("<repo>-peer")`.
  it('appends the name with no separator', () => {
    expect(deriveScratch('/home/andrin/src/ide', 'peer').hash).toBe('9cd83b')
  })

  /*
   * The socket is a sibling of the root rather than a file inside it, and short.
   * `sun_path` is 108 bytes on Linux but 104 on macOS, where $TMPDIR is a
   * per-user path around 48 characters before anything of ours: measured,
   * `$TMPDIR/swb-scratch-<slug>-<hash>/state/tmux.sock` reaches 104 for a name
   * this repository actually uses, and tmux fails there with an opaque bind
   * error only after the server has started and answered /api/health.
   */
  it('keeps the tmux socket inside macOS sun_path', () => {
    const macTmp = '/var/folders/2z/8rk4q_9n1cq0j3_zv0h2xk5r0000gn/T'
    const long = deriveScratch('/Users/andrin/src/some-quite-long-branch-name', 'peer', macTmp)
    expect(long.tmuxSocket.length).toBeLessThan(104)
    // The path it replaced would not have fitted.
    expect(`${long.root}/state/tmux.sock`.length).toBeGreaterThan(104)
  })
})

describe('validateName', () => {
  // The name is concatenated into a path that `stop` later removes recursively.
  it('refuses anything that could leave the scratch directory', () => {
    for (const bad of ['..', 'a/b', '../../etc', 'a b', '', ' ', 'a;b', '~']) {
      if (bad === '') continue // empty means "the unnamed instance"
      expect(() => validateName(bad), bad).toThrow()
    }
    expect(() => validateName('peer')).not.toThrow()
    expect(() => validateName('two-terms.1_x')).not.toThrow()
  })

  it('cannot produce a root outside the temp directory', () => {
    expect(() => deriveScratch('/repo', '../../../etc')).toThrow()
  })
})

describe('portCandidates', () => {
  /*
   * Derived first so a checkout keeps its port across restarts, probed second by
   * the caller because the derivation cannot know what else is listening. The
   * arithmetic breaks silently if the floor and the span are ever changed apart.
   */
  it('walks every port in the range exactly once, starting at the derived one', () => {
    const ports = portCandidates('ebd504')
    expect(ports).toHaveLength(PORT_SPAN)
    expect(new Set(ports).size).toBe(PORT_SPAN)
    expect(ports[0]).toBe(PORT_FLOOR + (0xebd504 % PORT_SPAN))
    expect(Math.min(...ports)).toBe(PORT_FLOOR)
    expect(Math.max(...ports)).toBe(PORT_FLOOR + PORT_SPAN - 1)
  })
})

describe('scratchEnv', () => {
  /*
   * "A scratch instance cannot touch a real one" is a claim the docs make; this
   * is it asserted. The shell version set its own SWB_* values and never cleared
   * the parent's, so a shell that had exported SWB_STATE_DIR -- an agent's pane,
   * or a service manager -- would have had a "scratch" server attach itself to
   * the real instance's state directory and tmux socket. Live agents, in a
   * process this CLI treats as disposable and removes with `rm -rf`.
   */
  it('drops every inherited SWB_ variable', () => {
    const instance = deriveScratch('/repo/ide')
    const env = scratchEnv(
      {
        PATH: '/usr/bin',
        SWB_STATE_DIR: '/home/andrin/.config/switchboard',
        SWB_TMUX_SOCKET: '/home/andrin/.config/switchboard/tmux.sock',
        SWB_TOKEN: 'somebody-elses-secret',
        SWB_PUBLIC_HOST: 'ide.example.com',
      },
      instance,
      8234,
    )
    expect(env.SWB_STATE_DIR).toBe(instance.stateDir)
    expect(env.SWB_TMUX_SOCKET).toBe(instance.tmuxSocket)
    expect(env.SWB_TOKEN).toBeUndefined()
    expect(env.SWB_PUBLIC_HOST).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin') // everything else is inherited
    expect(env.SWB_PORT).toBe('8234')
    expect(env.NODE_ENV).toBe('production')
  })

  it('passes CLAUDE_CMD through as the stand-in agent, defaulting to bash', () => {
    const instance = deriveScratch('/repo/ide')
    expect(scratchEnv({ CLAUDE_CMD: 'vim' }, instance, 8234).SWB_CLAUDE_CMD).toBe('vim')
    expect(scratchEnv({}, instance, 8234).SWB_CLAUDE_CMD).toBe('bash')
  })
})

describe('isOurServer', () => {
  /*
   * The two servers running on the machine where this was written printed the
   * same `ps` line, because the shell started them after a `cd server` with a
   * relative path:
   *
   *   3944799 node dist/index.js --host andrin.ide.n-dream.com:84
   *
   * so the pid file's pid was killed on nothing but trust. Spawning by absolute
   * path is what makes the question answerable at all.
   */
  const script = '/home/andrin/src/ide/server/dist/index.js'

  it('refuses the relative line the shell version produced', () => {
    expect(isOurServer('node dist/index.js --host andrin.ide.n-dream.com:84', script)).toBe(false)
  })

  it('refuses another checkout whose path is a near miss', () => {
    const other = '/home/andrin/src/ide-2/server/dist/index.js'
    expect(isOurServer(`node ${other}`, script)).toBe(false)
    // ...and the containing-path direction, which a naive prefix test gets wrong
    expect(isOurServer(`node ${script}`, other)).toBe(false)
  })

  it('accepts our own line, including a path with a space in it', () => {
    expect(isOurServer(`node ${script} --host x:84`, script)).toBe(true)
    const spaced = '/Users/me/My Projects/ide/server/dist/index.js'
    expect(isOurServer(`node ${spaced}`, spaced)).toBe(true)
  })
})

describe('assertScratchPaths', () => {
  // The guard in front of every kill and every `rm -rf`.
  it('refuses the real instance directory and its socket', () => {
    const real = {
      ...deriveScratch('/repo/ide'),
      root: '/home/andrin/.config/switchboard',
      stateDir: '/home/andrin/.config/switchboard',
      tmuxSocket: '/home/andrin/.config/switchboard/tmux.sock',
    }
    expect(() => assertScratchPaths(real)).toThrow(/not a scratch directory/)
  })

  it('refuses a scratch root whose socket has been pointed elsewhere', () => {
    const tampered = {
      ...deriveScratch('/repo/ide'),
      tmuxSocket: '/home/andrin/.config/switchboard/tmux.sock',
    }
    expect(() => assertScratchPaths(tampered)).toThrow(/not a scratch socket/)
  })

  it('accepts what it derives itself', () => {
    expect(() => assertScratchPaths(deriveScratch('/repo/ide'))).not.toThrow()
  })
})
