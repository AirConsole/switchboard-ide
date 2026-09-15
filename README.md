# Switchboard

A web IDE for running several Claude Code agents at once, one per git worktree.
Its job is to tell you which agent is blocked and get you into that worktree
fast — a dispatcher, not a dashboard.

Each worktree is a window in a row you scroll along. A window shows that
worktree's Claude, its terminals, its files and changes, or its queued
prompts. The two colours in the interface are the two questions you scan a row
of agents for: **amber** means an agent is blocked on you, **green** means one
has finished. Everything else is grey, because everything else can wait.

Sessions live in tmux, not in the browser. You can close the tab, restart the
server, or lose the network, and the agents keep working. A queued prompt is
typed into its agent by the server when that agent comes to rest, with no
browser open at all.

## Read this before you run it

**There is no password.** Not on localhost, not anywhere. The server binds
`127.0.0.1` and expects a reverse proxy in front of it if you want to reach it
from elsewhere — that proxy is what authenticates you.

What the server does enforce, because a proxy cannot:

- **Which pages may open its WebSocket.** A socket is exempt from CORS, so
  without this any page you visited could open one, read a session id off the
  state broadcast, and type a prompt and a Return into a running agent.
- **Which names it answers to**, so a rebound DNS name pointed at your loopback
  address cannot reach it.
- **Cross-site requests**, via Fetch Metadata.

A process running as you on the same machine is *not* kept out, deliberately: it
can already read your SSH keys and your source, so a password in the app would
be theatre against it. The caller worth keeping out is the one that is not you.

Everything above is `server/src/gate.ts`, and it is about 90 lines.

## Running it

Requires Node 22+, pnpm, git, and tmux. `pnpm install` compiles `node-pty` from
source, so a C toolchain too.

```sh
pnpm install
pnpm build
pnpm start          # serves on http://127.0.0.1:8084
```

Open it, add a project — any directory inside a git repository works — and its
worktrees appear as windows.

Behind a proxy, tell the server the name a browser will type, or every socket
arriving through the proxy is refused:

```sh
node server/dist/index.js --host ide.example.com:84
```

`scripts/deploy.sh` does that and checks it afterwards, because a wrong value
does not fail loudly: the page loads, every REST call works, and only the row
never paints.

## Linking another machine

Link a second machine running this same IDE and everything open there is open
here — its projects, worktrees, sessions and queued prompts join the row. There
is no per-project subscription: an agent blocked on you is blocked on you
wherever it is.

The machine being linked sets `SWB_TOKEN`, which is what lets a gateway read it
and what makes binding an address other than loopback safe. Your browser never
talks to it; the server you have open forwards everything, so there is no CORS,
no cookie and no second login.

```sh
# on the machine to link
SWB_TOKEN=$(head -c 32 /dev/urandom | base64) node server/dist/index.js --bind 0.0.0.0
```

Then add it in the open dialog, with its address and that token.

## Development

```sh
pnpm dev        # vite on :5240, proxying the server on :8084
pnpm typecheck  # a gate
pnpm test       # the other gate
```

There is no linter; the compiler does that work. Two throwaway instances for
trying things, each with its own state directory, tmux socket and port:

```sh
scripts/scratch.sh up
scripts/scratch.sh up peer      # a second one, to link
scripts/scratch.sh down         # removes every trace
```

## The comments are the documentation

`CLAUDE.md`, `server/CLAUDE.md` and `web/CLAUDE.md` are not an overview — they
are the reasoning, and most of it was measured rather than argued. Why the
attention heuristic reads the whole turn and not the last twelve rows; why a
repaint comes from a server-side terminal emulator and never from a byte
buffer; why two linked machines needed four separate fixes before they stopped
opening sockets at each other.

They are written for whoever works on this next, which is often an agent. If
you are about to change something that looks arbitrary, the comment beside it
probably says what it cost to learn.

## Licence

MIT. See [LICENSE](LICENSE).
