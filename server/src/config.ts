import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

const env = process.env

const int = (value: string | undefined, fallback: number): number => {
  const n = value === undefined ? NaN : Number(value)
  return Number.isFinite(n) ? n : fallback
}

const port = int(env.SWB_PORT, 8084)
const isDev = env.NODE_ENV !== 'production'

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
 * process has no way to derive, so a deployment must name it. `deploy.sh` does.
 */
const publicOrigins = (): ReadonlySet<string> => {
  // Three spellings of this machine, because which one reaches the server is
  // the user's choice of URL and all three are the same server.
  const loopback = ['127.0.0.1', 'localhost', '[::1]']
  const allowed = loopback.map((h) => `http://${h}:${port}`)
  // In dev the page is Vite's and it proxies `/ws` here, so the browser's origin
  // is Vite's rather than ours. `changeOrigin` rewrites `Host` and leaves
  // `Origin` alone, which is why this is needed and why it names the web port.
  if (isDev) {
    const webPort = int(env.SWB_WEB_PORT, 5240)
    for (const h of loopback) allowed.push(`http://${h}:${webPort}`)
  }
  for (const raw of (env.SWB_PUBLIC_ORIGIN ?? '').split(',')) {
    // Trailing slash trimmed: an origin has none, but a value pasted from a
    // browser's address bar does, and the two must not be different origins.
    const origin = raw.trim().replace(/\/+$/, '')
    if (origin !== '') allowed.push(origin)
  }
  return new Set(allowed)
}

export const config = {
  /**
   * Caddy already fronts 127.0.0.1:8084 as andrin.ide.n-dream.com:84 with auth,
   * so the app itself stays unauthenticated and bound to localhost.
   */
  host: env.SWB_HOST ?? '127.0.0.1',
  port,

  /** Origins whose pages may open `/ws`. See `publicOrigins` above. */
  publicOrigins: publicOrigins(),

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

  /*
   * Holds `state.json` and the tmux socket, so it is the one path that must not
   * change under a *running* server -- but it can be moved and the server
   * pointed at the new place, because a unix socket is bound to its inode and
   * `mv` within a filesystem keeps it -- which is how the rename from the old
   * name moved this directory with all six sessions still running. `sun_path`
   * is 108 bytes, so keep it short.
   */
  stateDir: env.SWB_STATE_DIR ?? join(homedir(), '.config', 'switchboard'),

  tmuxConf: env.SWB_TMUX_CONF ?? new URL('../tmux.conf', import.meta.url).pathname,

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

  /** Static web build, served in production. */
  webDist: env.SWB_WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname,

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
