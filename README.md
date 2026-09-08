# ide-n-dream

A web IDE built around running several Claude Code agents in parallel, one per git
worktree. Its job is to tell you which agent is blocked and get you into that
worktree fast.

## What it does

- **Overview** — every worktree's agent as a live, interactive terminal tile. An
  agent blocked on a prompt is marked amber, and the top bar shows how many are
  waiting. You can answer a prompt straight from a tile.
- **Worktree view** — the agent full size, plus extra shells in the same working
  directory, with a top bar of worktree tabs.
- **Worktrees** — create a branch + worktree and start an agent in it in one step;
  remove it (and optionally its branch) when done.
- **Nothing is lost** — every terminal is a real tmux session on a private socket,
  so agents keep working when you close the tab, and survive a server restart or
  crash. You can always take one over from a real terminal.

## Running it

```sh
pnpm install          # also compiles node-pty for this platform
pnpm build
pnpm start            # http://127.0.0.1:8084
```

For development, with the Vite dev server proxying the API and terminal socket:

```sh
pnpm dev              # web on :5240, server on :8084
```

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `IDN_HOST` / `IDN_PORT` | `127.0.0.1` / `8084` | Where the server listens. |
| `IDN_TMUX_SOCKET` | `~/.config/ide-n-dream/tmux.sock` | Private tmux socket path. |
| `IDN_STATE_DIR` | `~/.config/ide-n-dream` | Projects and UI layout. |
| `IDN_CLAUDE_CMD` | `claude` | Command for agent sessions. |
| `IDN_SHELL` | `$SHELL` | Command for shell sessions. |

It binds localhost and has no auth of its own; put a reverse proxy in front if you
want to reach it from another machine.

## How it works

```
browser ── one WebSocket (JSON control + binary output) ──> server
                                                             │
   xterm.js per terminal                    SessionEngine ────┤
   CodeMirror 6 for files (planned)           │               │
                                              │  node-pty ──> tmux (private socket)
                                              │  @xterm/headless mirror per session
                                              │  git worktree / status
```

A few decisions worth knowing about, because they are not obvious:

- **One tmux client per session, owned by the server.** Browsers are never tmux
  clients, which removes the whole class of "tmux resized the window to the
  smallest attached client" problems. Viewers are fanned out from that one stream.
- **Reconnects repaint from a server-side terminal emulator**, not from a byte
  buffer. Claude Code runs on the alternate screen, where replaying raw history is
  meaningless and slicing mid-escape-sequence corrupts the screen.
- **Only the focused detail view sets the pty size.** Overview tiles shrink their
  font instead, so glancing at the overview never reflows a running TUI.
- **Exactly one attachment can type at a time.** Terminal apps send queries that
  xterm.js auto-answers, so two writers would inject duplicate replies into the
  app's stdin.
- **`server/tmux.conf` is load-bearing**, not boilerplate. Without `extended-keys
  on` Shift+Enter reaches Claude as zero bytes; without the `RGB` terminal feature
  tmux downgrades 24-bit colour to 256; with a status line the app loses a row.
  Each line there says why it exists.
- **Ids are derived, not generated.** Project and worktree ids are hashes of their
  absolute paths, so they are stable across restarts and sessions recorded in tmux
  are never orphaned.

## Status

Working: overview, worktree view, terminals, worktree and session lifecycle,
persistence across restarts.

Not built yet: the file tree and CodeMirror editor, git history and diff viewer,
and registering as a Claude Code IDE (the `~/.claude/ide/<port>.lock` protocol) so
agents get `openDiff` and diagnostics against this IDE.
