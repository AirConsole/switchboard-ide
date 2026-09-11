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
  host: env.SWB_HOST ?? '127.0.0.1',
  port: int(env.SWB_PORT, 8084),

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
export const tmuxSocketPath = env.SWB_TMUX_SOCKET ?? join(config.stateDir, 'tmux.sock')
