#!/usr/bin/env node
/**
 * One command for the two things this repository runs: the machine's instance,
 * and the throwaway ones you develop against.
 *
 *   swb start | stop | restart        the machine's instance
 *   swb                               what it is doing
 *   swb scratch start|stop|restart    this checkout's throwaway instance
 *   swb scratch                       its URL, and anything else on the machine
 *
 * **Nothing is imported at module scope but `node:util`.** This file is on
 * `pnpm install`'s critical path -- `postinstall` runs `ensure-native` through
 * it, before anything in the workspace has been built -- so a mistake in a
 * command module must not be able to break an install. Each command is reached
 * through a dynamic import instead.
 */
import { parseArgs } from 'node:util'

const USAGE = `swb -- Switchboard

  pnpm start                     bring the instance up (does not build)
  pnpm stop                      stop it; tmux sessions and their agents keep running
  pnpm restart                   build, then stop and start; this is the deploy
  pnpm status                    what it is, and whether the public name is right

  pnpm scratch start [name]      a throwaway instance for this checkout
  pnpm scratch stop  [name]
  pnpm scratch restart [name]
  pnpm scratch [name]            its URL, plus any other instance on this machine

  pnpm ensure-native             rebuild node-pty if a Node upgrade left it stale

Options
  --host <name>   public name a browser types; overrides the config file
  --skip-build    restart without building first
  --force         override the worktree guard (worktrees develop, master deploys)
  --url           scratch: print only the URL, for scripting

Settings live in ~/.config/switchboard/config.json:
  { "port": 8084, "host": "ide.example.com:84", "token": "..." }
`

const main = async () => {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        host: { type: 'string' },
        'skip-build': { type: 'boolean' },
        force: { type: 'boolean' },
        url: { type: 'boolean' },
      },
    })
  } catch (err) {
    // strict, so an unknown flag lands here rather than being ignored -- which
    // is the one thing a hand-rolled argv loop always gets wrong.
    console.error(`swb: ${err instanceof Error ? err.message : String(err)}`)
    console.error(USAGE)
    process.exit(1)
  }

  const { values, positionals } = parsed
  if (values.help) {
    console.log(USAGE)
    return
  }

  const opts = {
    host: values.host,
    force: values.force,
    skipBuild: values['skip-build'],
    url: values.url,
  }
  const [first, ...rest] = positionals

  if (first === 'ensure-native') {
    const { ensureNodePty } = await import('../src/ensure-node-pty.js')
    ensureNodePty()
    return
  }

  if (first === 'help') {
    console.log(USAGE)
    return
  }

  if (first === 'scratch') {
    const scratch = await import('../src/scratch.js')
    const [verb, ...more] = rest
    // `scratch peer` and `scratch start peer` both name the instance; the first
    // is what you type when you only want to look at it.
    if (verb === undefined) return scratch.status(opts)
    if (verb === 'start' || verb === 'stop' || verb === 'restart' || verb === 'status') {
      return scratch[verb]({ ...opts, name: more[0] })
    }
    if (more.length === 0) return scratch.status({ ...opts, name: verb })
    console.error(`swb scratch: no such command "${verb}"`)
    console.error(USAGE)
    process.exit(1)
  }

  /*
   * Bare `swb` prints usage rather than status, because `swb` alone names no
   * object -- the same reason bare `git` prints usage while bare `git remote`
   * lists remotes. `swb scratch` does name one, so it reports.
   */
  if (first === undefined) {
    console.log(USAGE)
    return
  }

  const service = await import('../src/service.js')
  if (first === 'status') return service.status()
  if (first === 'start' || first === 'stop' || first === 'restart') return service[first](opts)

  console.error(`swb: no such command "${first}"`)
  console.error(USAGE)
  process.exit(1)
}

main().catch((err) => {
  console.error(`swb: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
