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
pnpm password       # the server will not start without one
pnpm start          # http://127.0.0.1:8083
```

Then open it, add a project — any directory inside a git repository works — and
its worktrees appear as windows.

```sh
pnpm status         # is it up, and is its public name right
pnpm stop           # leaves the tmux sessions and their agents running
pnpm restart        # builds first; this is the deploy
pnpm pull           # update to the newest version and restart on it
```

`start` detaches from your shell, so closing the terminal does not take it down.
Nothing registers it to start at boot.

## Read this before you expose it

**One password, and it is the whole boundary.** Anyone who gets past it can run
commands as you. Set it with `pnpm password`; the server will not start without
one. A browser asks for it once and then holds a session for up to a week.

It is asked for **everywhere, including on localhost**, and that is forced
rather than cautious: a reverse proxy connects from loopback, so "local callers
skip the password" would let the whole internet skip it through the proxy.

A process running as you on the same machine is still *not* kept out, and
cannot be: it can read the password file and the tmux socket, and your SSH keys
besides. The caller worth keeping out is the one that is not you.

What the server enforces beyond the password, because a password alone covers
none of it:

- **What may open its WebSocket.** A socket is exempt from CORS, and a session
  cookie is not enough: cookies ignore the port, so a page on another port of
  the same hostname is same-site and your browser hands it your cookie. So the
  socket does not accept the cookie at all. The page fetches a single-use ticket
  over `/api`, where the origin *is* checked, and opens the socket with that.
- **Which names it answers to**, so a DNS name re-pointed at your machine
  cannot reach it. That matters more with a password, not less: a rebound page
  is same-origin with the server, so the browser attaches your cookie to it.
- **Cross-site requests**, via `SameSite=Strict`, Fetch Metadata, and an
  `Origin` check on anything that changes state.
- **How fast a password can be guessed.** Every attempt waits its turn, and the
  wait does not depend on whether the guess was right, so timing tells an
  attacker nothing.

All of it is `server/src/gate.ts` and `server/src/auth.ts`.

Changing the password signs out every browser within a second, with no
restart, and closes their open terminals within a minute.
`pnpm password --revoke-sessions` does the same without changing it.

Behind a proxy, tell the server the name a browser will type, or every socket
arriving through it is refused. Settings live in
`~/.config/switchboard/config.json`:

```json
{ "port": 8083, "host": "ide.example.com:83" }
```

`start` and `restart` check that name afterwards rather than trusting it,
because a wrong value does not fail loudly: the page loads, every REST call
works, and only the row never paints.

## Linking another machine

Link a second machine running this same IDE and everything open there is open
here — its projects, worktrees, sessions and queued prompts join the row. There
is no per-project subscription: an agent blocked on you is blocked on you
wherever it is.

The machine being linked has its own password, like any instance. Make it
reachable from the machine you use by binding an address other than loopback:

```jsonc
// on the machine to link, in ~/.config/switchboard/config.json
{ "bind": "0.0.0.0" }
```

Then add it in the open dialog with its address and **its** password. Your
server signs in to it once and keeps the link it gets back, never the password.
Your browser never talks to that machine; the server you have open forwards
everything, so there is no CORS and no second login.

Over plain `http://`, only addresses on your own network are accepted — a
password that opens a shell should not cross the internet in clear. If that
machine's password changes, its windows stay where they are and the dialog
offers to link it again.

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
pnpm dev        # vite on :5240, proxying the server on :8083
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
