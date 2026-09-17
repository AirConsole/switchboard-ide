import { randomUUID } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.env

const int = (value: string | undefined, fallback: number): number => {
  const n = value === undefined ? NaN : Number(value)
  return Number.isFinite(n) ? n : fallback
}

const port = int(env.SWB_PORT, 8083)
const isDev = env.NODE_ENV !== 'production'

/**
 * A repeatable command-line flag, as `--name value` or `--name=value`.
 *
 * The one thing here that is not an environment variable, because it is the one
 * thing a *deployment* has to get right rather than a developer: it shows up in
 * `ps`, it is impossible to inherit by accident from a parent shell, and a
 * wrong one is visible in the command that started the process rather than in a
 * environment somebody has to go and read.
 */
const flag = (name: string): string[] => {
  const found: string[] = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === `--${name}`) {
      const next = argv[i + 1]
      // `--host --port 9000` is a missing value, not a host called "--port".
      if (next !== undefined && !next.startsWith('--')) found.push(next)
    } else if (arg.startsWith(`--${name}=`)) {
      found.push(arg.slice(name.length + 3))
    }
  }
  return found
}

/**
 * Origins whose pages may open `/ws`.
 *
 * A WebSocket is exempt from CORS by design, so without this any page you
 * happen to visit can open one to this server, read a session id off the state
 * broadcast every client gets, and send a prompt and a Return into a running
 * Claude -- command execution as you, from a page you merely looked at. The
 * bind address does not help: the page runs in *your* browser, which is already
 * inside. `Origin` is what closes it, because a browser sets it on every socket
 * and script cannot override it.
 *
 * An allow-list, rather than checking `Origin` against `Host`: DNS rebinding
 * makes those two agree -- the attacker owns the name and re-points it here, so
 * both read `evil.example` -- and a name we never published is exactly what
 * this has to refuse.
 *
 * Behind a reverse proxy the browser's origin is the proxy's, which this
 * process has no way to derive, so a deployment must name it: `--host`, which
 * `swb` passes from its config file.
 *
 * **A bare name means both schemes.** `--host ide.example:83` allows
 * `https://ide.example:83` and `http://ide.example:83`, because which one the
 * browser sends depends on how the proxy terminates and that is not something
 * the person typing the flag should have to know -- getting it wrong costs a
 * page that loads over a row that never paints. Write the scheme yourself to
 * pin one. Listing both is no weaker: anyone who can serve `http://<name>`
 * already controls the name.
 */
const publicOrigins = (): ReadonlySet<string> => {
  // Three spellings of this machine, because which one reaches the server is
  // the user's choice of URL and all three are the same server.
  const loopback = ['127.0.0.1', 'localhost', '[::1]']
  const allowed = loopback.map((h) => `http://${h}:${port}`)
  /*
   * In dev the page is Vite's and it proxies `/ws` here, so the browser's
   * origin is Vite's rather than ours. `changeOrigin` rewrites `Host` and
   * leaves `Origin` alone, which is why this is needed and why it names the
   * web port.
   *
   * Keyed on `NODE_ENV` being *explicitly* development, not on its absence.
   * `isDev` is "not production", so a hand-started `node dist/index.js` --
   * which is the documented way to run one for testing -- was a dev instance,
   * and any other local app that happened to be served on 5240 could open
   * `/ws`, read a session id off the broadcast and type into a terminal.
   */
  if (env.NODE_ENV === 'development') {
    const webPort = int(env.SWB_WEB_PORT, 5240)
    for (const h of loopback) allowed.push(`http://${h}:${webPort}`)
  }
  for (const raw of flag('host').flatMap((value) => value.split(','))) {
    const given = raw.trim().replace(/\/+$/, '')
    if (given === '') continue
    // A bare name means both schemes; writing one pins it. See above.
    const written = given.includes('://') ? [given] : [`https://${given}`, `http://${given}`]
    for (const candidate of written) {
      try {
        /*
         * Canonicalised, and that is what keeps `publicHosts` below from
         * disagreeing with this set: it derives from these values, and it used
         * to re-parse raw input of its own. `https://IDE.Example.com` then
         * allowed `/api` and refused `/ws` -- a half-broken deployment, which
         * is worse than either end of it, because the page loads and only the
         * row never paints. A browser's `Origin` is always the canonical form,
         * so that is what has to be in here.
         *
         * The scheme is checked, and not as a formality: a name that is itself
         * scheme-shaped (`box.local:8083`) parses as the *scheme*
         * `box.local:`, and `.origin` for any non-special scheme is the
         * literal string `"null"` -- which would land in this set and blow up
         * `new URL` downstream.
         */
        const url = new URL(candidate)
        if (url.protocol === 'http:' || url.protocol === 'https:') allowed.push(url.origin)
      } catch {
        // Not a URL at all. Dropped rather than guessed.
      }
    }
  }
  return new Set(allowed)
}

export const config = {
  /**
   * The address to listen on, and loopback is the answer unless another
   * machine has to reach this one directly -- a gateway on the same network.
   *
   * Binding elsewhere is safe only because nothing here is served without the
   * password (`gate.ts`), and the server will not start without one. Over plain
   * HTTP on a network you do not own, though, the password and the session
   * cross it in clear; put TLS in front, or keep it to a network you trust.
   *
   * Named `bind`, not `host`: `--host` is the *public* name a browser types,
   * and one word meaning both the address we answer on and the name we answer
   * to is how a security setting gets configured with the wrong value.
   */
  bind: flag('bind')[0] ?? env.SWB_BIND ?? '127.0.0.1',
  port,

  /** Origins whose pages may open `/ws`. See `publicOrigins` above. */
  publicOrigins: publicOrigins(),

  /**
   * Host names this server answers to, which is what closes DNS rebinding.
   *
   * Rebinding is a page served from a name the attacker owns, the name then
   * re-pointed at this address -- and the subtle half is that the rebound page
   * is *same-origin* with us afterwards, so it sends no `Origin`, needs no
   * preflight, and `Sec-Fetch-Site` reads `same-origin`. Every check built on
   * those agrees with it. What it cannot forge is `Host`: the browser sends the
   * name that was typed, and that name is one we never published.
   *
   * Derived from the same place as `publicOrigins`, so a deployment configures
   * one thing. Port is ignored -- it is the name that is being lied about.
   */
  publicHosts: new Set(
    // Every entry is already a canonical origin, so this cannot disagree with
    // the set above -- which it did, and silently.
    [...publicOrigins()].map((origin) => new URL(origin).hostname).filter((host) => host !== ''),
  ),

  /**
   * The shared secret that makes this instance reachable as somebody's peer.
   *
   * Unset -- the default, and what a normal instance stays -- nothing changes:
   * the bind address and whatever proxy sits in front are the boundary, as they
   * always were. Set, every `/api` and `/ws` request must either carry it or be
   * our own page, which is what makes it safe to bind an address other than
   * loopback so a gateway on the network can read this machine. See gate.ts.
   */
  token: env.SWB_TOKEN === '' ? undefined : env.SWB_TOKEN,

  /**
   * What this machine calls itself in another machine's UI.
   *
   * The hostname is the obvious default and a poor one for testing, where two
   * instances share a host and would be one name twice.
   */
  serverName: env.SWB_SERVER_NAME ?? hostname(),

  /**
   * A value this process can use to recognise itself.
   *
   * Not the name, which two machines can share, and not the address, which is
   * the thing being compared. Linking a machine to itself is otherwise
   * accepted and is a meltdown: its relay opens a socket to itself, which is
   * accepted as a client and given a relay, which opens another -- 1,447
   * sockets in five seconds, measured. Per start, because nothing needs it to
   * survive one.
   */
  instanceId: randomUUID(),

  /*
   * Holds `state.json` and the tmux socket, so it is the one path that must not
   * change under a *running* server -- but it can be moved and the server
   * pointed at the new place, because a unix socket is bound to its inode and
   * `mv` within a filesystem keeps it -- which is how the rename from the old
   * name moved this directory with all six sessions still running. `sun_path`
   * is 108 bytes on Linux and **104 on macOS**, so keep it short -- the default
   * here is 43 for a six-character user name, but a deep `SWB_STATE_DIR` is one
   * of the few ways to get an opaque tmux bind failure long after startup.
   */
  stateDir: env.SWB_STATE_DIR ?? join(homedir(), '.config', 'switchboard'),

  /*
   * `fileURLToPath`, never `.pathname`: a file URL percent-encodes, so a
   * checkout under a directory with a space in it -- ordinary on macOS --
   * produced `/home/a%20b/ide/server/tmux.conf`, a path that does not exist.
   * tmux then silently loads none of this file, and `server/tmux.conf` is
   * load-bearing rather than cosmetic: Shift+Enter arrives as zero bytes and
   * truecolor degrades to 256.
   */
  tmuxConf: env.SWB_TMUX_CONF ?? fileURLToPath(new URL('../tmux.conf', import.meta.url)),

  /** Command used for `claude` sessions. */
  claudeCommand: env.SWB_CLAUDE_CMD ?? 'claude',
  /*
   * The real `claude`, for reading `/usage`.
   *
   * Deliberately not `claudeCommand`: that one is the agent a scratch instance
   * swaps for vim or a stand-in script, and a stand-in cannot report usage.
   */
  usageCommand: env.SWB_USAGE_CMD ?? 'claude',
  shellCommand: env.SWB_SHELL ?? env.SHELL ?? '/bin/bash',

  /** Scrollback the server-side mirror keeps for reconnect repaints. */
  mirrorScrollback: int(env.SWB_MIRROR_SCROLLBACK, 5000),

  /**
   * Largest file the files panel will open, and the largest it will save.
   *
   * Configurable rather than a constant because "the editor refuses to open my
   * file" is exactly the limit someone needs to raise once, without a rebuild.
   * Nothing is ever truncated to fit it -- a partial buffer in the editor is one
   * save away from destroying the rest of the file -- so over the cap the panel
   * says so instead of showing anything.
   */
  maxFileBytes: int(env.SWB_MAX_FILE_BYTES, 2 * 1024 * 1024),

  /**
   * Static web build, served in production.
   *
   * `fileURLToPath` for the same reason as `tmuxConf` above: percent-encoding
   * makes `existsSync(webDist)` false, and the server then serves no UI at all
   * and says so only in a log line.
   */
  webDist: env.SWB_WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),

  isDev,
} as const

export const stateFile = join(config.stateDir, 'state.json')

/**
 * Private tmux socket, addressed by path rather than `-L`.
 *
 * `-L` would place it in /tmp/tmux-$UID/, where systemd-tmpfiles or a
 * PrivateTmp unit can delete it out from under a long-lived server. The usual
 * advice is /run/user/$UID, but that does not exist on this host, so it lives
 * beside our state instead - persistent, per-user, and isolated from the user's
 * own tmux server (which currently holds unrelated sessions we must not touch).
 */
export const tmuxSocketPath = env.SWB_TMUX_SOCKET ?? join(config.stateDir, 'tmux.sock')
