# server

Fastify, one WebSocket, and a private tmux server. Everything here exists to
make one promise good: **a session survives the IDE.** The browser can close,
this process can be restarted, and the agent keeps working.

```
routes/api.ts   REST: projects, worktrees, sessions, changes, diffs, files, find
routes/ws.ts    the single socket; JSON control frames + binary output frames
workspace.ts    the one funnel for every project/worktree operation
files.ts        a worktree's own files: containment, listing, search, read, write
http-error.ts   HttpError, so workspace.ts and files.ts can both throw it
state.ts        state.json: projects and the opaque `ui` blob
session/        engine (sessions, attachments, sizing) -> tmux -> node-pty
  tmux.ts       every tmux invocation, and the metadata in @idn_meta
  mirror.ts     a headless xterm per session, for repaint and attention
  attention.ts  idle / working / needs-you
  readiness.ts  whether it is safe to TYPE into a session -- a stricter question
  dispatch.ts   hands queued todos to Claude when it comes to rest
  claude.ts     transcripts: --continue, the last prompt, and turn boundaries
                (the prompt reader is incremental -- see "What a worktree is
                working on")
git/            worktree.ts (discovery, add, remove) and changes.ts (status, log, diff)
usage.ts        Claude's own limits, read from `claude -p /usage` and cached
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
Claude settings. `classify()` weighs three things, in this order, and the order
is the point:

1. **Is a human needed?** Decided from the screen, before anything about the
   clock, because a dialog is up or it is not and a repainting TUI is never
   quiet. Checked over the **whole of the current turn**, not a tail: measured,
   a plan approval's option list sat 5 rows above the bottom and a question
   dialog's sat 11, each option carrying a paragraph, so the old 12-row window
   caught both by a row or two and one more line of text would have lost them.
   The turn is everything below the last `· done HH:MM`, because the screen is
   a scrollback and the patterns are not all safe on the turns above it: two of
   them are ordinary English, and a live worktree's `Which way do you want to
   go?` matched the permission dialog's "Do you want to …" and held a tile amber
   through a turn the spinner was visibly running. A dialog Claude is showing
   now is always below the marker — measured on a real permission dialog whose
   question sat on line 28 of 34 with the previous turn's done line on 12. Weak
   patterns live in `PROMPT_FOOTERS` and are trusted only on the last three
   lines. `^1. Yes` was dropped outright: it is what Claude writes when
   *explaining* options, and it made a finished worktree read as waiting.
2. **Is it working?** Recent output, `turn === 'in-turn'`, or the spinner's
   parenthesised timer — `(3m 34s · …)`, and the minute and hour forms are not
   decoration: the pattern was `\(\d+s` and so missed every turn longer than a
   minute, which is most of them.
3. **Has it said it finished?** Done is claimed, not assumed. `screenState()`
   looks at the last line above the input box, ignoring blanks and a short
   named list of furniture: the line a finished turn leaves behind
   (`✻ Baked for 2s · done 3:01 PM`) means idle, and so does having printed
   nothing at all — a session nobody has asked anything yet. Anything else
   there happened *after* the last turn ended, so the turn record has to settle
   it, and a screen with no input box at all is unreadable rather than
   finished, which is what an empty mirror looks like.

The order of 2 and 3 is the whole point. Idle used to be the fall-through —
whatever was left after "no dialog and nothing printed for 900ms" — so every
silent stretch inside a turn read as *done*: a quiet tool call, a slow hop, a
subagent thinking. Now the fall-through is **working**, and idle has to be
positively shown. Ambiguity costs a grey tile and a queue that waits, instead
of a green tile and a prompt typed into a running agent.

Two constants still matter: `WORKING_WINDOW_MS` (output newer than this means
working) and `REPAINT_QUIET_MS` — output right after a repaint *we* caused is a
redraw, not the agent doing something. `expectRepaint()` marks the ones we ask
for, including the `refreshClients` call after adopting a session: **an adopted
session starts with an empty mirror**, and tmux sends nothing until the app
writes something, so an agent sitting on a static dialog was invisible to
everything that reads the mirror and its window said idle. Measured immediately
after a restart, before and after the fix.

## Typing into a session

`readiness.ts` and `dispatch.ts` exist so a todo queued with RUN NEXT can be
typed into that worktree's Claude with no browser open. Everything about them is
shaped by one asymmetry: **sending a prompt twice is much worse than never
sending it**, and a Return pressed on a screen we misread is not recoverable.

- **It is a whitelist, not a blacklist.** `attention.ts` answers "what label goes
  on the tile" and is deliberately narrow about `needs-you`; a modal it misses is
  merely a wrong label. Here a missed modal means a paragraph typed into a
  dialog and a Return that answers it — measured: a real Claude's trust-folder
  dialog sits with **No, exit** selected. So readiness requires positive
  recognition of the resting empty input box, and anything unrecognised waits.
- **The screen is read three ways.** Silence (`lastOutputAt`), the rendered text,
  and Claude's own transcript. The transcript is the precise one: Claude writes
  `{"subtype":"turn_duration"}` when a turn ends, which is the signal
  `attention.ts` names in its own comment and never wired up. An `in-turn`
  reading is believed only if the transcript was written to in the last 30s —
  otherwise a session killed mid-turn blocks its queue forever, which is a real
  thing that happened.
- **Two measurements that overturned assumptions.** This Claude paints no "esc
  to interrupt"; the busy marker is a parenthesised elapsed timer
  (`✽ Grooving… (8s · …)`), and a finished turn drops the parentheses. And the
  hint inside an empty input box is drawn **dim**, indistinguishable in plain
  text from a draft you typed — hence `TerminalMirror.tailText({ skipDim: true })`,
  without which the queue would stall on Claude's own ghost text.
- **xterm.js answers the app's terminal queries through the same socket as your
  keystrokes**, so `lastUserInputAt` counts only input that survives having its
  escape sequences stripped. Without that, a browser tab merely being open reads
  as "the human is typing" and holds the queue off indefinitely.
- **Delivery is claim-then-write.** `dispatchingAt` is set and `store.flush()`ed
  before a byte goes out, the paste and the Return are separate writes, and the
  Return is withheld unless the paste is visibly in the box. A todo found with
  `dispatchingAt` on startup is handed back to the human, never re-sent.

`IDN_DEBUG_DISPATCH=1` logs every verdict change, which is how the predicate was
checked against a real Claude before it was allowed to type anything.

## Worktrees and ids

Worktrees are **discovered** from `git worktree list --porcelain -z` on every
read. `-z` because the porcelain form prints a worktree's path raw and
unquoted: a path containing a newline splits into two attributes, and the
line-oriented parse then reports the path truncated at the newline (measured --
`.../worktrees/od\nd` came back as `.../worktrees/od`, with the wrong id, since
an id is a hash of the path).

There is no registry, which is what lets the IDE be dropped onto a repo that
already has worktrees. `head` from porcelain feeds `pollChanged()`'s signature
(`id:branch:head:dirty:missing:prompt`), which is how the 4s poller decides
whether to broadcast `invalidate` — and it polls only while a client is
connected.

`prompt` is the last thing the user asked Claude in that worktree, read from the
tail of the newest transcript in `transcriptDir(path)`. **A slash command is not
written as a `last-prompt` entry at all** -- it arrives as a `user` message
holding `<command-name>/plan</command-name>` and its args -- so one backward
scan classifies both kinds of line, and both `lastPrompt()` and `turnState()`
read it. Before that, a `/plan` left the window showing the *previous*
instruction for the whole turn, and left `turnState` reading the previous turn's
end, which said "idle" while Claude was working. Claude writes two
candidates and `lastPrompt()` takes the second on purpose: `ai-title` is Claude's
own name for the conversation but is set from its opening subject and goes stale
within the hour, while `last-prompt` is rewritten every turn. Neither costs a
token — both are already on disk — and only the file's tail is read, because a
transcript is megabytes and this runs per worktree per poll.

`idFor(prefix, path, host)` hashes the path. **Local ids hash the bare absolute
path and must keep doing so**, byte for byte: those ids are recorded in
`@idn_meta`, so changing the derivation orphans every running session. The
remote branch namespaces by base URL; that is the whole of the remote design
that exists today, together with `Project.host`.

Anything destructive checks first and in the right order: `removeWorktree`
refuses a dirty worktree *before* killing its sessions, so a refusal costs
nothing.

## Files

`files.ts` is the one place that reads or writes inside a worktree, and three
things in it are load-bearing:

- **Containment is checked after `realpath`, not on the string.** `resolve()`
  folds away `..`, but a symlink -- to a file, or a *directory* traversed on the
  way in -- lands outside without the path containing a dot. The comparison then
  uses `relative()` rather than a prefix test, because `/a/b` is a string prefix
  of `/a/bc`. `.git` is refused by name, since in a linked worktree it is a file
  and a kind test would miss it. Note that `Workspace.browse()` is deliberately
  uncontained -- the project picker has to roam -- so do not "fix" it to use
  this.
- **`git check-ignore` exits 1 when nothing is ignored**, with empty stdout, and
  128 outside a repository; both must be caught, the same trap `fileDiff`
  documents for `git diff --no-index`. Directory entries are sent with a
  trailing `/` because a `dist/` pattern matches only directories and git
  decides by stat'ing the path. Tracked files are never reported as ignored,
  which is what keeps a file the repo actually has from disappearing behind a
  stale rule.
- **A read is stat, read, stat.** If the file moved in between, the rev handed
  back would not describe the bytes sent, and the next save would be refused as
  stale for no reason the reader could see. The rev is nanosecond mtime, size
  and inode -- `mtimeMs` is a double that rounds away exactly the sub-millisecond
  precision a write guard needs, and the inode catches a temp-file-and-rename.

## Is there anything of yours left in this worktree

Two counts answer that, and the bar shows whichever applies: `dirty` is work not
committed, `unmerged` is work committed and not merged. A worktree with neither
is one you can forget about.

`unmerged` is `rev-list --count <default>..HEAD` — "would merging this bring
anything". What counts as the default branch is resolved once per repository and
cached for the life of the process, in this order: `origin/HEAD`, because that
is what the remote itself says its default is and it survives a repository whose
default is neither `main` nor `master`; then `origin/main` or `origin/master` if
one exists, since `origin/HEAD` is only written at clone time or by `set-head`;
then a local `main` or `master`. All local reads — nothing here touches the
network. Measured: this repo resolves to `master` (no remote), mapplets to
`origin/master` from its `origin/HEAD`, and a repository with no commits at all
resolves to nothing, which is correct — there is no branch to be unmerged from,
and the count is 0.

Cost: one `rev-list` per worktree per poll, alongside the `git status` that
`dirty` already pays. Measured over four worktrees of this repo, 38ms for both
halves together and 15ms for the `rev-list` half, against a 4s poll.

## What a worktree is working on

`lastPrompt(cwd)` is the line a window's bar shows, and reading it is not the
one-liner it looks like. Two measurements shaped it, both from the same live
worktree:

- **`last-prompt` is bookkeeping, not the newest prompt.** Claude re-stamps that
  record every turn with the same prose -- five copies of "merge and deploy"
  inside one 256KB tail -- and writes none at all for a slash command. So the
  `/plan ...` the person had actually typed was invisible and a two-turn-old
  instruction sat in the bar. A real user record now wins wherever there is one;
  the bookkeeping is the fallback for a session with none in reach.
- **Plan feedback is a tool result.** What someone types when they turn a tool
  use down comes back as that tool's own result, phrased for Claude ("The user
  doesn't want to proceed with this tool use ... the user said: <words>") --
  usually `ExitPlanMode`, so a reader that only looks at user records cannot see
  the newest thing a person said during planning. `PLAN_FEEDBACK` digs it out,
  behind a substring test because a tool result can be hundreds of kilobytes,
  and **anchored at the start of the result**: a tool result is whatever a tool
  printed, and the bare phrase matched this file's own comment, so an agent that
  read `claude.ts` put `<words>". So the 197- * newest thing a person said` in
  its own window.
- **The harness records its own business as `user` records too**, each opening
  with a tag: `<task-notification>`, `<bash-input>`, `<bash-stdout>`,
  `<local-command-stdout>`, `<system-reminder>`, `<attachment>` -- surveyed over
  120 live transcripts. That was a list of three and a `startsWith`, and it went
  stale the way such a list does: a finished background task put 453 characters
  of `<task-id>` XML in a worktree's bar. `INJECTED` tests the shape instead,
  the opening tag rather than a whole wrapped block, because `<bash-stdout>`
  closes and continues into `<bash-stderr>`. A slash command opens with a tag as
  well and is read first, so it still survives.

And the reason it is incremental: the real record was **857KB** past the end of
that transcript, well outside any tail worth reading on every poll. So the
reader remembers what it has already scanned per working directory and reads
only the bytes added since, with a 64KB overlap so a record straddling the
boundary is not lost. A file it has never seen gets one backward walk, doubling
out from 256KB to a cap of 8MB, which stops at the first real prompt. Measured:
10ms for the first look at a 9.8MB transcript, 0-1ms after.

## Claude's usage limits

`GET /api/usage` answers with what `claude -p /usage` last said, parsed into
`{ label, percent, resets }` rows for the bars in the top bar.

Print mode is why this is small: `-p` answers a slash command as plain text, so
there is no pty to drive and no TUI to scrape. `--bare` does **not** work — it
skips whatever handles the command and prints a cost summary instead.

The reading costs a `claude` process, measured 4.3–4.6s, so it is cached for
five minutes and there is no timer: the browser polls on the same interval and a
poll inside the window is answered from the last reading, which also means
nothing is spawned while nobody is looking. Concurrent requests share one
in-flight read. `IDN_USAGE_CMD` overrides the binary and is deliberately *not*
`IDN_CLAUDE_CMD`, which a scratch instance replaces with vim or a stand-in.

Parsing keys on `% used`, because the rest of that report is full of percentages
that are not limits ("96% of your usage came from subagent-heavy sessions"). An
empty parse counts as a failure rather than a reading — `/usage` says something
else entirely when it cannot answer — and a failure keeps the previous numbers
and adds `error`, so the bars can show stale figures instead of vanishing.

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
| `IDN_USAGE_CMD` | `claude` | The real binary, for reading `/usage`. |
| `IDN_SHELL` | `$SHELL` | Command for terminal sessions. |
| `IDN_MIRROR_SCROLLBACK` | `5000` | Lines each server-side mirror keeps. |
| `IDN_MAX_FILE_BYTES` | `2097152` | Largest file the files panel opens or saves. |
| `IDN_WEB_DIST` | `web/dist` | What `pnpm start` serves. |
| `IDN_LOG_LEVEL` | `info` | Fastify's logger. |
| `IDN_DEBUG_SIZE` | unset | Log every size decision and its owner. |
| `IDN_DEBUG_DISPATCH` | unset | Log why a queued todo did or did not go. |

The `IDN_` prefix and that path are the old name's, and both are frozen: the
socket lives at that path and a restarted server re-adopts its sessions through
it, and an env var renamed out from under a caller falls back through `??`
silently -- which for this one means writing into the live instance's state.

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
