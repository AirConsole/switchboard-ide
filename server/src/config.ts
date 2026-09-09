import { homedir } from 'node:os'
import { join } from 'node:path'

const env = process.env

const int = (value: string | undefined, fallback: number): number => {
  const n = value === undefined ? NaN : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  /**
   * Caddy already fronts 127.0.0.1:8084 as andrin.ide.n-dream.com:84 with auth,
   * so the app itself stays unauthenticated and bound to localhost.
   */
  host: env.IDN_HOST ?? '127.0.0.1',
  port: int(env.IDN_PORT, 8084),

  stateDir: env.IDN_STATE_DIR ?? join(homedir(), '.config', 'ide-n-dream'),

  tmuxConf: env.IDN_TMUX_CONF ?? new URL('../tmux.conf', import.meta.url).pathname,

  /** Command used for `claude` sessions. */
  claudeCommand: env.IDN_CLAUDE_CMD ?? 'claude',
  shellCommand: env.IDN_SHELL ?? env.SHELL ?? '/bin/bash',

  /** Scrollback the server-side mirror keeps for reconnect repaints. */
  mirrorScrollback: int(env.IDN_MIRROR_SCROLLBACK, 5000),

  /**
   * Largest file the files panel will open, and the largest it will save.
   *
   * Configurable rather than a constant because "the editor refuses to open my
   * file" is exactly the limit someone needs to raise once, without a rebuild.
   * Nothing is ever truncated to fit it -- a partial buffer in the editor is one
   * save away from destroying the rest of the file -- so over the cap the panel
   * says so instead of showing anything.
   */
  maxFileBytes: int(env.IDN_MAX_FILE_BYTES, 2 * 1024 * 1024),

  /** Static web build, served in production. */
  webDist: env.IDN_WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname,

  isDev: env.NODE_ENV !== 'production',
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
export const tmuxSocketPath = env.IDN_TMUX_SOCKET ?? join(config.stateDir, 'tmux.sock')
