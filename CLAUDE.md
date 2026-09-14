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
pnpm typecheck   # a gate; builds shared first because the others import it
pnpm test        # the other gate: vitest over all three packages
pnpm start       # serves web/dist from the server on :8084
pnpm dev         # vite on :5240 proxying the server on :8084

pnpm test:watch  # the same, staying open
pnpm coverage    # with a per-file table
pnpm ensure-native   # rebuild node-pty if a Node upgrade left it ABI-stale
```

**There is no linter.** `pnpm lint` does not exist and fails with "Command not
found" — do not report it as passing. `pnpm typecheck`, `pnpm test` and
`pnpm build` are the only automated gates, so the compiler is doing all the work
a linter would.

## Tests

`vitest run`, one project per package: `shared` and `server` in node, `web` in
jsdom. Tests live in each package's `test/` rather than beside the source, so
`tsc -p tsconfig.json` -- which is the build -- keeps emitting `src` and nothing
else; `tsconfig.test.json` beside it is what typechecks them, and `pnpm
typecheck` runs both.

What is covered is the part that decides things: attention and readiness, the
transcript reader, the dispatcher, the git parsers, containment, the state file,
the workspace funnel, and the web's selectors, store and layout. The git tests
run **real git against throwaway repositories** (`test/helpers/repo.ts`) rather
than fixture strings, because every parser here exists to read git's actual
output -- a hand-written fixture is only what we *think* git prints, and the
`-z` porcelain parsers were written against measured output.

What is not covered is the part you have to look at: React components, the pty
and tmux engine, the routes and the socket. Those are driven in a browser
against `scripts/scratch.sh`, and the traps in "Verifying changes" below are
still the rules there.

**A test here records a bug that actually happened.** Most of them cite the
measurement in a comment, the way the code does -- that is what makes them worth
keeping, and it is also how you tell a test that would catch a regression from
one that merely runs the code. When you add one, break the line it guards and
watch it fail; a test that passes either way is documentation with a runtime
cost. Every test in the suite was checked that way once.

## A live instance is running on this machine

The user runs this IDE on `127.0.0.1:8084`, serving `server/dist` and
`web/dist` from this checkout, behind Caddy. Consequences:

- **A web change reaches them on reload.** A change under `server/` or `shared/`
  needs the server process restarted, which briefly drops every browser socket.
  Their tmux sessions survive it — that is the whole point of the design — but
  ask before restarting unless they asked for the change.
- **`scripts/deploy.sh` is the restart**, run from the master checkout after a
  merge lands: it builds, and only if that succeeds stops :8084 and starts it
  again detached. It is never automatic and never run from a worktree. It also
  passes `--host`, without which every socket arriving through Caddy is refused
  and the row never paints.
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

The server binds localhost and checks two things itself, both because neither
the bind address nor Caddy is in the path that matters. **Who may open `/ws`**:
a WebSocket is exempt from CORS, so any page you visited could otherwise open
one, read a session id off the broadcast and type into a running agent. And
**what name a request was addressed to**: a DNS-rebound page is same-origin with
us afterwards, so `Host` is the only thing about it that is not the attacker's
to choose. Both need `--host` behind a proxy -- the public name a browser types,
which `deploy.sh` passes.

Without `SWB_TOKEN` this instance serves **this machine only** -- there is no
credential, so the connection's own address is the whole of the boundary.
Setting `SWB_TOKEN` is what lets another machine read it, and therefore what
makes binding anything but loopback a thing that can be made safe. See
`server/CLAUDE.md`.

It also **installs as an app** -- a manifest and icons in `web/public/`, so
Chrome's "Install page as app" gives it its own window, icon and place in the
switcher. There is no service worker and none is needed:
Chrome installs it from the manifest alone, address bar included. See
`web/CLAUDE.md`.

## How the pieces fit

```
browser ── one WebSocket (JSON control + binary output frames) ──> server
   xterm.js per pane                     SessionEngine ──> node-pty ──> tmux
   fetch for everything else                    │          (private socket)
                                                ├─ @xterm/headless mirror/session
                                                ├─ git worktree / status / diff
                                                └─ peer (another machine's server)
```

- `shared/` — the wire contract: the domain model and the WebSocket protocol.
  Both other packages import it, so it builds first.
- `server/` — Fastify, the session engine, tmux, git. See `server/CLAUDE.md`.
- `web/` — React, xterm.js, the layout. See `web/CLAUDE.md`.

## Invariants that cross packages

**Ids are derived from absolute paths, and the derivation must not change.**
`idFor` in `server/src/git/worktree.ts` hashes the path; a worktree's id is
recorded inside its tmux session's metadata, so changing how local ids are
computed orphans every running session. Local ids keep hashing the bare path,
deliberately; a peer's are namespaced **on the server**, by a short key derived
from its base URL, because `/home/andrin/src/ide` on two machines hashes
identically.

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
  matched in luminance so neither outshouts the other. The keyboard legend is
  what the rule looks like when it is kept: holding Cmd lights the letter that
  opens each panel of the window you are in, and draws an arrow in the two
  windows a Cmd+arrow step would land in, and all of it is the grey ladder -- --bone on a word stepped down to
  --graphite -- because where a key would take you is not a state you scan a row
  of agents for. The exceptions are both content rather than chrome, and are read the
  way terminal output is: a diff's own green and red, and a source file's syntax
  colour. The rule still governs the interface around them, and neither
  exception may reach for amber or green — the files pane's palette is the terminal's own, minus its green, so that a
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

Do not add abstractions for things that do not exist yet. The two seams that
were named ahead of time — `Project.host` and the id namespacing — are both
used now, by the gateway described below.

## Remote projects

A project can live on another machine running this same IDE, and **this server
is the gateway**. The browser still talks to one origin and, almost everywhere,
never learns that a project is remote: `store.ts`, `Overview.tsx`, `TopBar.tsx`
and `App.tsx` are untouched, so the unit arithmetic, the keyboard, the focus
model and the WebGL budget never had to be reasoned about. Two places do know.
The open dialog, because somebody has to pick the machine; and one branch of
`socket.ts`, because a machine restarting re-attaches its panes and only a
repaint can say what they show now.

That is the whole of the design, and everything else follows from it:

- **A peer needs no public exposure.** No DNS, no TLS, no Caddy of its own, no
  login. It is reached from the gateway, on the network the two share, which is
  the topology this was built for: the machines are together and only you are
  somewhere else. A proxy's cost is the *detour*, not the peer's round trip --
  `dist(browser,gateway) + dist(gateway,peer) - dist(browser,peer)` -- and over
  a LAN hop that is about a millisecond on terminal echo.
- **A peer is an unmodified instance.** It runs this same program and has no
  idea anyone remote is asking. That is what lets one hook forward every `/api`
  route instead of twenty-five routes each growing a remote branch, and one
  relay carry the socket: the path that answers here answers there.
- **Todos live with the worktree**, so RUN NEXT on a remote worktree is
  dispatched by the peer's own dispatcher, with no browser open anywhere. They
  are created against the peer for exactly that reason.
- **The layout is the viewer's.** `ui` is read and written only on the server
  that served the page; a peer's snapshot carries one and it is dropped at the
  boundary.
- **A machine that is off keeps its tab.** The UI prunes stored layout for
  worktrees it cannot see, so "that machine is off" must never read as "those
  worktrees are gone" -- it would cost panels and open files permanently. The
  snapshot holds what a peer last said, and a project's id is derived from the
  root and the base URL so it exists even when nothing has ever answered.
- **Authentication is a token between servers, and there is no login.** A peer
  sets `SWB_TOKEN`, which is also what makes it safe for it to bind an address
  other than loopback: on a peer the token is the only credential that crosses
  the network, because `Origin` and `Sec-Fetch-Site` are unforgeable only inside
  a browser and the caller a peer must keep out is not one. A browser is
  believed solely from the peer's own machine. Your browser never talks to a
  peer, so there is no CORS, no cookie, no preflight -- and Caddy keeps its
  `basicauth` exactly as it is. A peer's own UI is therefore usable only from
  the peer; you look at it through the gateway, and a peer must not have a
  reverse proxy in front of it.

Testing needs two instances:

```sh
scripts/scratch.sh up          # the gateway
scripts/scratch.sh up peer     # the machine a project lives on; prints its token
scripts/scratch.sh down peer   # each one goes down by name
```

## Not built yet

- Installing and updating: there is no way to install this on a fresh box, so a
  peer is a checkout someone built by hand.
- Telling you *why* a machine is quiet: an unreachable peer's project keeps its
  tab and shows the worktrees it last had, but nothing yet says which of those
  it is.
- Registering as a Claude Code IDE (`~/.claude/ide/<port>.lock`) so agents get
  `openDiff` and diagnostics against this IDE.
