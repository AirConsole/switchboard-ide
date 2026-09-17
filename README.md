# Switchboard

**A web IDE for running several Claude Code agents at once, one per git worktree.**

Run one agent and you watch it. Run five and you lose them: which one is waiting
on a question, which one finished ten minutes ago, which one has been stuck on a
permission prompt since you went for coffee. Terminal tabs do not tell you, and
neither does anything that only shows you the one you are looking at.

Switchboard's job is to tell you **which agent is blocked and get you into that
worktree fast** — a dispatcher, not a dashboard.

Each worktree is a window in a row you scroll along. A window shows that
worktree's Claude, its terminals, its files and changes, or its queued prompts.
The two colours in the interface are the two questions you scan a row of agents
for: **amber** means an agent is blocked on you, **green** means one has
finished. Everything else is grey, because everything else can wait.

Sessions live in tmux, not in the browser. You can close the tab, restart the
server, or lose the network, and the agents keep working. A queued prompt is
typed into its agent by the server when that agent comes to rest, with no
browser open at all.

## Install

macOS or Linux. Needs Node 22+, git, tmux, pnpm, and the `claude` CLI on your
`PATH`.

```sh
curl -fsSL https://raw.githubusercontent.com/AirConsole/switchboard-ide/master/install.sh | sh
```

It checks what is missing, tells you what it will do, and does nothing until you
agree — `--check` reports and changes nothing. Or by hand:

```sh
git clone https://github.com/AirConsole/switchboard-ide.git
cd switchboard-ide
pnpm install        # compiles node-pty; Linux needs a C toolchain, macOS does not
pnpm build
pnpm start          # http://127.0.0.1:8084
```

Then open it, add a project — any directory inside a git repository works — and
its worktrees appear as windows.

```sh
pnpm status         # is it up, and is its public name right
pnpm stop           # leaves the tmux sessions and their agents running
pnpm restart        # builds first; this is the deploy
```

`start` detaches from your shell, so closing the terminal does not take it down.
Nothing registers it to start at boot.

## Read this before you expose it

**There is no password.** Not on localhost, not anywhere. The server binds
`127.0.0.1` and expects a reverse proxy in front of it if you want to reach it
from elsewhere — that proxy is what authenticates you.

This is a deliberate choice, not an omission. A process running as you on the
same machine is *not* kept out: it can already read your SSH keys and your
source, so a password in the app would be theatre against it. The caller worth
keeping out is the one that is not you.

What the server does enforce, because a reverse proxy cannot:

- **Which pages may open its WebSocket.** A socket is exempt from CORS, so
  without this any page you visited could open one, read a session id off the
  state broadcast, and type a prompt and a Return into a running agent.
- **Which names it answers to**, so a rebound DNS name pointed at your loopback
  address cannot reach it.
- **Cross-site requests**, via Fetch Metadata.

All of it is `server/src/gate.ts`, and it is about 90 lines.

Behind a proxy, tell the server the name a browser will type, or every socket
arriving through it is refused. Settings live in
`~/.config/switchboard/config.json` (mode 0600, because of the token):

```json
{ "port": 8084, "host": "ide.example.com:84", "token": "..." }
```

`start` and `restart` check that name afterwards rather than trusting it,
because a wrong value does not fail loudly: the page loads, every REST call
works, and only the row never paints.

## Linking another machine

Link a second machine running this same IDE and everything open there is open
here — its projects, worktrees, sessions and queued prompts join the row. There
is no per-project subscription: an agent blocked on you is blocked on you
wherever it is.

The machine being linked sets a `token`, which is what lets a gateway read it
and what makes binding an address other than loopback safe. Your browser never
talks to it; the server you have open forwards everything, so there is no CORS,
no cookie and no second login.

```jsonc
// on the machine to link, in ~/.config/switchboard/config.json
{ "token": "...", "bind": "0.0.0.0" }
```

Then add it in the open dialog, with its address and that token.

## What it is not

- **Not a hosted service.** It runs on your machine, against your checkouts,
  with your credentials. There is nothing to sign up for and nothing phones home.
- **Not an editor.** It has a files panel and a code view for reading and small
  edits; your editor is still your editor.
- **Not a Claude Code replacement.** It drives the real `claude` CLI in a real
  terminal. Anything Claude Code can do, it does here, because it *is* it.

## Status

Used daily, by its author, to build itself — the agents in the row are usually
the ones working on this repository. That is the main thing recommending it and
also the main caveat: it is shaped around one person's workflow, and the paths
that person does not walk are less worn.

Developed on Linux. macOS is supported — the portability work is done and the
install path runs there — but it has had far fewer hours on it, so expect to be
the first person to hit something.

## Development

```sh
pnpm dev        # vite on :5240, proxying the server on :8084
pnpm typecheck  # a gate
pnpm test       # the other gate
```

There is no linter; the compiler does that work. Throwaway instances for trying
things, each with its own state directory, tmux socket and port, so they cannot
reach the one you actually use:

```sh
pnpm scratch start
pnpm scratch start peer    # a second one, to link
pnpm scratch stop          # removes every trace
```

## Contributing

`master` is protected — everything arrives by pull request. Both gates
(`pnpm typecheck` and `pnpm test`) must pass.

A test here records a bug that actually happened, and most of them cite the
measurement in a comment. When you add one, break the line it guards and watch
it fail; a test that passes either way is documentation with a runtime cost.

Commit messages say what changed and **why it was wrong before**, and record
what was measured. They are long here on purpose.

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
