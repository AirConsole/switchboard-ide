# Switchboard

A web IDE for running several Claude Code agents at once, one per git worktree.
Its job is to tell you which agent is blocked and get you into that worktree
fast — a dispatcher, not a dashboard.

The IDE is used to develop itself. If you are reading this in a worktree, you
are probably one of the agents in one of its windows.

## The model

A **project** is a registered git repository. Every registered project is open;
there is no "active" one. A project's **worktrees** are discovered from
`git worktree list`, never stored, so dropping the IDE on a repo finds its
worktrees already there.

A worktree is the unit, and it owns everything about itself: one Claude session,
any number of terminals, its todos, and its files and changes. A todo is a
prompt you park against a worktree; RUN NEXT hands it to the server, which types
it into that worktree's Claude once Claude has come to rest -- with the browser
closed, if need be. It is **awake** or
**asleep**. Awake means it has a window in the row; asleep means it is behind
the top bar and, unless you said otherwise, nothing of it is running. Waking
continues the conversation it was having rather than starting a new one.

The row of windows is a strip you scroll along, and it is laid out in **units**
of half a pane. Claude is two units, and so is a terminal or the todo list. The
files panel is the one that changes size: **one unit while it is only its tree**,
and three once you open something in it, since a pane holding both the tree and
the file spends a quarter of its width on the tree and would otherwise be the one
pane that cannot keep the 80-column promise. A worktree shows **one panel at a
time** -- its todos, its files and changes, or its terminals -- so a window is
two, three, four or five units. A unit is as wide as it needs to be for as many
as fit to fill the screen, and two of them never fall below 80 columns; the
tree by itself is the one thing allowed to have less, because it is names and
not code. Navigation always lands on a unit boundary, so no window is ever shown
half-cut.

## Commands

```sh
pnpm install     # also compiles node-pty from source for this platform
pnpm build       # shared -> web -> server, in that order
pnpm typecheck   # the gate; builds shared first because the others import it
pnpm start       # serves web/dist from the server on :8084
pnpm dev         # vite on :5240 proxying the server on :8084

pnpm ensure-native   # rebuild node-pty if a Node upgrade left it ABI-stale
```

**There is no linter.** `pnpm lint` does not exist and fails with "Command not
found" — do not report it as passing. `pnpm typecheck` and `pnpm build` are the
only automated gates, so the compiler is doing all the work a linter would.

## A live instance is running on this machine

The user runs this IDE on `127.0.0.1:8084`, serving `server/dist` and
`web/dist` from this checkout, behind Caddy. Consequences:

- **A web change reaches them on reload.** A change under `server/` or `shared/`
  needs the server process restarted, which briefly drops every browser socket.
  Their tmux sessions survive it — that is the whole point of the design — but
  ask before restarting unless they asked for the change.
- **`scripts/deploy.sh` is the restart**, run from the master checkout after a
  merge lands: it builds, and only if that succeeds stops :8084 and starts it
  again detached. It is never automatic and never run from a worktree.
- **Never touch their project or its sessions.** Their worktrees have live
  agents in them. Scope anything destructive by project id, and do not run
  `tmux kill-server` on `~/.config/switchboard/tmux.sock`.
- **Do not test against :8084.** Clicks there fight the user for the same UI
  state, and a browser tab of your own competes for terminal geometry. Use:

```sh
scripts/scratch.sh up      # this checkout's own instance; prints its URL
scripts/scratch.sh url     # that URL again, if you lost it
scripts/scratch.sh down    # removes every trace
scripts/scratch.sh list    # every scratch instance on the machine
CLAUDE_CMD=vim scripts/scratch.sh up   # vim as the stand-in agent
```

Each checkout gets its own instance — its own state dir, tmux socket, scratch
repositories and port, all derived from the checkout's path — so several
worktrees can run one at once without reaching each other. **The port differs
per worktree**, so read it from `up` or ask `url`; do not assume one. `vim` is
the useful stand-in for anything about attention or resizing: silent at rest,
full redraw on SIGWINCH. Close any browser tab you opened when you finish, and
`down` before you go.

## If you are working in a worktree

The IDE develops itself, and the split that keeps that safe is: **worktrees
develop, master deploys.**

Your worktree is its own checkout with its own `dist/`, so building, testing and
running a scratch instance here cannot reach the running IDE. Nothing you do in
a worktree deploys — the live instance serves `server/dist` and `web/dist` from
the master checkout alone. So do not build, start, or restart anything in
`/home/andrin/src/ide` itself, and do not restart :8084; finish on your branch
and let the merge into master be what ships it.

A fresh worktree needs its own `pnpm install` before it can build, and `node-pty`
compiles from source there, so the first one takes a while.

## Where worktrees live

A worktree the IDE creates goes in `<repo>/.claude/worktrees/<branch>`, which is
where `claude --worktree` puts them too, so one made here and one made by the
agent itself land together. The pattern `**/.claude/worktrees/` is added to
`.git/info/exclude` — repo-local and untracked, never a shared `.gitignore` — so
the checkout does not read as dirty because of them. Nothing depends on that
location, though: worktrees are read from `git worktree list`, so one registered
anywhere shows up.

The server binds localhost and has no auth of its own. Reaching it from another
machine is a reverse proxy's job.

## How the pieces fit

```
browser ── one WebSocket (JSON control + binary output frames) ──> server
   xterm.js per pane                     SessionEngine ──> node-pty ──> tmux
   fetch for everything else                    │          (private socket)
                                                ├─ @xterm/headless mirror/session
                                                └─ git worktree / status / diff
```

- `shared/` — the wire contract: the domain model and the WebSocket protocol.
  Both other packages import it, so it builds first.
- `server/` — Fastify, the session engine, tmux, git. See `server/CLAUDE.md`.
- `web/` — React, xterm.js, the layout. See `web/CLAUDE.md`.

## Invariants that cross packages

**Ids are derived from absolute paths, and the derivation must not change.**
`idFor` in `server/src/git/worktree.ts` hashes the path; a worktree's id is
recorded inside its tmux session's metadata, so changing how local ids are
computed orphans every running session. A remote host will namespace its ids by
base URL; local ids keep hashing the bare path, deliberately.

**One tmux client per session, owned by the server.** Browsers are never tmux
clients, which removes the whole class of "tmux resized the window to the
smallest attached client" problems. Viewers are fanned out from that one stream.

**Reconnects repaint from a server-side terminal emulator**, not from a byte
buffer. Claude runs on the alternate screen, where replaying raw history is
meaningless and slicing mid-escape-sequence corrupts the screen. This is also
what makes it safe to unmount a terminal and remount it later.

**Exactly one attachment may type at a time.** Terminal apps send queries that
xterm.js answers automatically, so two writers inject duplicate replies into the
app's stdin.

**UI state belongs to the client.** The server stores `ui` opaquely and the
client adopts it only on first load, which is why two open tabs drift apart —
that is deliberate, and it fixed a bug where a debounced write raced a refresh.
Writes are debounced 200ms and fire-and-forget, so a change made immediately
before a reload can be lost.

## Verifying changes

Typecheck and build. Then, for anything you can see, drive it in the browser
against `scripts/scratch.sh` and **measure the thing you are claiming**. Every
line below is a mistake made in this codebase, not a hypothetical:

- **Presence in the DOM is not visibility.** A dropdown was "verified" twice
  while being clipped away entirely by an ancestor's `overflow`. Programmatic
  clicks work perfectly on invisible elements. Ask
  `document.elementFromPoint(centre)` whether the element is what you would hit.
- **Screenshots lie about hairlines.** Resampling a screenshot blends a 1px line
  out of existence; a divider was "missing" twice and was there both times. Read
  the rendered pixel columns, or crop 1:1 with nearest-neighbour.
- **The headless browser races animation clocks.** `currentTime` jumped 0 to
  117ms in 10ms of wall time. You can verify that an animation exists, has the
  right duration and interpolates the right property; you cannot verify its
  timing here.
- **Scroll offsets settle late.** Reading `scrollLeft` synchronously after
  setting it returns a partly-applied value. Wait, then read.
- **Synthetic key events can mask real handling.** A `dispatchEvent` test passed
  while Shift+Enter was broken, because returning false from xterm's handler
  does not stop the browser's own default input.
- **Terminal contents are not in the DOM.** The WebGL renderer keeps text in a
  canvas. Read it with `tmux -S <socket> capture-pane -p -t <name>`.
- **For server behaviour, instrument rather than infer.** To prove which
  arguments a spawned process received, put a shim earlier on its `PATH` that
  logs its argv. To prove work is not happening, count the invocations.

## Design rules

- **Colour is scarce, and it answers two questions.** The interface is
  greyscale except for the two states you scan a row of agents for: blocked on
  you is amber (`--signal`), and done — Claude running and come to rest — is
  green (`--done`). Nothing running is not done, and stays grey. The two are
  matched in luminance so neither outshouts the other. The exceptions are both
  content rather than chrome, and are read the way terminal output is: a diff's
  own green and red, and a source file's syntax colour. The rule still governs
  the interface around them, and neither exception may reach for amber or green
  — the files pane's palette is the terminal's own, minus its green, so that a
  string constant cannot catch the eye that is scanning a row of agents.
- **Two faces, one job each.** `--font-mono` for the terminal, patch lines, and
  identifiers read character by character. `--font-ui` for everything the
  interface says in its own voice. Neither names a font that may not be
  installed — a stack of hopefuls renders differently on every machine.
- **Every text colour clears 4.5:1** on every ground it appears on, including
  `--slab-raised`. The three greys are a deliberate ladder: 13.4 : 7.0 : 5.2.
- **The only motion is the terminal text**, plus 140ms for a window opening or
  closing. No spinners, no pulsing borders.
- **User-facing words: worktree, window, terminal, Claude.** Not tile, not row,
  not pane — those name how the interface is built. Say what a click does to the
  worktree.

## Conventions

Comments explain **why**, especially where something is load-bearing and looks
arbitrary; the code already says what. `server/tmux.conf` is the model for this.

Commit messages say what changed and why it was wrong before, and record what
was measured. They are long here on purpose: most of the traps in this codebase
were found once and would be re-introduced without a note saying so.

Do not add abstractions for things that do not exist yet. Two seams are named
ahead of time — `Project.host` and the id namespacing — and both are documented
where they are.

## Not built yet

- Remote projects: a project on another Switchboard server, with this server as
  the gateway. The seams are named in `server/CLAUDE.md`.
- Registering as a Claude Code IDE (`~/.claude/ide/<port>.lock`) so agents get
  `openDiff` and diagnostics against this IDE.
