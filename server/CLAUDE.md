# server

Fastify, one WebSocket, and a private tmux server. Everything here exists to
make one promise good: **a session survives the IDE.** The browser can close,
this process can be restarted, and the agent keeps working.

```
routes/api.ts   REST: projects, worktrees, sessions, changes, diffs
routes/ws.ts    the single socket; JSON control frames + binary output frames
workspace.ts    the one funnel for every project/worktree operation
state.ts        state.json: projects and the opaque `ui` blob
session/        engine (sessions, attachments, sizing) -> tmux -> node-pty
  tmux.ts       every tmux invocation, and the metadata in @idn_meta
  mirror.ts     a headless xterm per session, for repaint and attention
  attention.ts  idle / working / needs-you
  claude.ts     where transcripts live, and whether to pass --continue
git/            worktree.ts (discovery, add, remove) and changes.ts (status, log, diff)
config.ts       every IDN_* env var, in one place
```

## tmux

One tmux session per terminal, on a private socket, with **exactly one client
attached and the server owns it**. Browsers are never tmux clients. tmux sizes a
window to its smallest attached client, so letting several viewers attach would
mean the narrowest browser tab dictating the agent's geometry — instead one pty
attaches, and the engine tells tmux what size to be.

`tmux.conf` is loaded explicitly with `-f` and is **load-bearing, not
cosmetic**. Read it before changing it: each setting carries the measurement
that justifies it. The two that break silently are `terminal-features …:RGB`
(without it tmux downgrades 24-bit colour to the 256 palette) and
`extended-keys on` (without it Shift+Enter arrives as zero bytes).

Two tmux facts worth knowing before writing a command:

- **Session-targeting commands accept `=name` for an exact match; pane-targeting
  commands reject it.** Hence `paneTarget()` returns the bare name. A wrong
  target here silently acts on a different session.
- **`@idn_meta` dies with the session.** Session kind and worktree id are
  recorded there, which is how a restarted server adopts running sessions — and
  why nothing can be remembered across a sleep. Resuming is derived from the
  transcript on disk instead.

## The engine

`Session` is a record; `LiveSession` is that plus its pty, its mirror and its
attachments. Three rules keep several viewers of one terminal sane:

- **`sizeOwner`** — one attachment decides the geometry, and it is the most
  recently added *primary*, not the first. "First primary wins" was a real bug:
  a leaked attachment froze every later viewer at its size. With no primary
  attached, the pty's size is left alone entirely.
- **`inputOwner`** — one attachment may type. Terminal apps emit queries
  (cursor position, device attributes) that xterm.js answers on its own, so two
  writers inject duplicate replies into the app's stdin. Claiming happens on
  focus.
- **Repaint from the mirror, never from a byte buffer.** `mirror.ts` serialises
  the emulator's state on every attach. Raw replay cannot work: it slices
  mid-escape-sequence, and every TUI here runs on the alternate screen where
  replayed history is meaningless.

Attention is inferred, not reported — no hooks, nothing written into the user's
Claude settings. `classify()` reads when output last arrived and the rendered
text in the mirror. Two constants matter: `WORKING_WINDOW_MS` (output newer than
this means working) and `REPAINT_QUIET_MS` — output right after a resize *we*
caused is a redraw, not the agent doing something. Without that second one,
tiles flicker "working" as they appear. `PROMPT_PATTERNS` is deliberately
narrow: the resting input box also draws `❯`, and a false "needs you" is worse
than a missed one.

## Worktrees and ids

Worktrees are **discovered** from `git worktree list --porcelain` on every read.
There is no registry, which is what lets the IDE be dropped onto a repo that
already has worktrees. `head` from porcelain feeds `pollChanged()`'s signature
(`id:branch:head:dirty:missing`), which is how the 4s poller decides whether to
broadcast `invalidate` — and it polls only while a client is connected.

`idFor(prefix, path, host)` hashes the path. **Local ids hash the bare absolute
path and must keep doing so**, byte for byte: those ids are recorded in
`@idn_meta`, so changing the derivation orphans every running session. The
remote branch namespaces by base URL; that is the whole of the remote design
that exists today, together with `Project.host`.

Anything destructive checks first and in the right order: `removeWorktree`
refuses a dirty worktree *before* killing its sessions, so a refusal costs
nothing.

## Adding to the API

Put the logic in `workspace.ts` — it is the single funnel, and the interface a
remote project would implement. Routes stay thin: parse, call, map `HttpError`.

A kill emits no event of its own, so any route that ends a session must call
`broadcastInvalidate()`; otherwise clients only find out on their next poll.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `IDN_HOST` / `IDN_PORT` | `127.0.0.1` / `8084` | Where the server listens. |
| `IDN_STATE_DIR` | `~/.config/ide-n-dream` | `state.json` *and* the tmux socket. |
| `IDN_TMUX_SOCKET` | `<state dir>/tmux.sock` | Overrides just the socket. |
| `IDN_TMUX_CONF` | `server/tmux.conf` | The config loaded with `-f`. |
| `IDN_CLAUDE_CMD` | `claude` | Command for agent sessions. |
| `IDN_SHELL` | `$SHELL` | Command for terminal sessions. |
| `IDN_MIRROR_SCROLLBACK` | `5000` | Lines each server-side mirror keeps. |
| `IDN_WEB_DIST` | `web/dist` | What `pnpm start` serves. |
| `IDN_LOG_LEVEL` | `info` | Fastify's logger. |
| `IDN_DEBUG_SIZE` | unset | Log every size decision and its owner. |

All of it is in `config.ts`. `IDN_STATE_DIR` is the one that matters for
testing: it moves both `state.json` and the tmux socket, which is what makes
`scripts/scratch.sh` unable to touch a real instance. `IDN_CLAUDE_CMD` swaps the
agent for something cheap. `IDN_DEBUG_SIZE=1` logs every size decision with the
attachment that owned it.

## Testing server behaviour

There is no test suite. Measure instead:

- To prove what arguments a spawned process got, put a shim earlier on `PATH`
  that logs its argv. That is how `--continue` was confirmed to appear only
  where a transcript exists.
- To prove work is *not* happening, count invocations of the thing that would do
  it — a `git` shim showed 0 calls with no client connected and 12 in 12s with
  one.
- To see what a session actually shows, `tmux -S <socket> capture-pane -p -t <name>`.
