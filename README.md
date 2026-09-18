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

It reports what is missing and does nothing until you agree, then installs it,
builds, **asks you for a password, starts the server and prints its URL**.
`--check` reports and changes nothing. Or by hand:

```sh
git clone https://github.com/AirConsole/switchboard-ide.git
cd switchboard-ide
pnpm install        # compiles node-pty; Linux needs a C toolchain, macOS does not
pnpm build
pnpm password       # the server will not start without one
pnpm start          # http://127.0.0.1:7999
```

## First run

Open the URL and sign in with that password. The browser holds a session for up
to a week; changing the password signs every browser out.

**Open a project.** A project is any directory inside a git repository. Every
branch you work on becomes a worktree with its own Claude, its own terminals and
its own window in the row — and they keep running whether or not the page is
open.

**Nothing on the machine yet?** The row ends with a terminal on the machine
itself, in your home directory. Clone a repository there, then open it as a
project. It is also where the rest of the administration goes: a disk that is
filling up, a process to kill, `gh auth login`.

From then on the row is the interface: scroll it, or press `Cmd`/`Alt` with the
arrow keys to walk it. Hold that key to see what else it does — the letters that
open a window's terminals, todos and files light up on the window you are in.

## The commands

```sh
pnpm status         # is it up, and what name is it answering to
pnpm stop           # stops the server; the agents keep running in tmux
pnpm restart        # builds first, then restarts on what it built
pnpm pull           # update to the newest version and restart on it
pnpm password       # change it; every browser is signed out
```

`start` detaches from your shell, so closing the terminal does not take it down,
and nothing registers it to start at boot.

## Read this before you expose it

**One password, and it is the whole boundary.** Anyone who gets past it can run
commands as you. It is asked for **everywhere, including on localhost**, and
that is forced rather than cautious: a reverse proxy connects from loopback, so
"local callers skip the password" would let the whole internet skip it through
the proxy.

A process running as you on the same machine is still *not* kept out, and cannot
be: it can read the password file and the tmux socket, and your SSH keys
besides. The caller worth keeping out is the one that is not you.

What the server enforces beyond the password, because a password alone covers
none of it:

- **What may open its WebSocket.** A socket is exempt from CORS, and a session
  cookie is not enough: cookies ignore the port, so a page on another port of
  the same hostname is same-site and your browser hands it your cookie. The
  socket does not accept the cookie at all — the page fetches a single-use
  ticket over `/api`, where the origin *is* checked.
- **Which names it answers to**, so a DNS name re-pointed at your machine cannot
  reach it. That matters more with a password, not less: a rebound page is
  same-origin with the server, so the browser attaches your cookie to it.
- **Cross-site requests**, via `SameSite=Strict`, Fetch Metadata, and an
  `Origin` check on anything that changes state.
- **How fast a password can be guessed.** Every attempt waits its turn, and the
  wait does not depend on whether the guess was right.

Behind a proxy, tell the server the name a browser will type, or every socket
arriving through it is refused:

```json
{ "port": 7999, "host": "ide.example.com:83" }
```

in `~/.config/switchboard/config.json`. `start` and `restart` check that name
afterwards rather than trusting it, because a wrong value does not fail loudly:
the page loads, every REST call works, and only the row never paints.

`pnpm password --revoke-sessions` signs every browser out without changing the
password. The whole of it is `server/src/gate.ts` and `server/src/auth.ts`, and
`server/CLAUDE.md` says why each rule is there.

## Run it in the cloud

One command builds a machine on Google Cloud that runs this IDE, and prints a
URL you can open from anywhere:

```sh
curl -fsSL https://raw.githubusercontent.com/AirConsole/switchboard-ide/master/cloud/provision.sh \
  | sh -s -- create mybox --project my-project
```

It needs `gcloud` signed in, and nothing else — not even a checkout. From one,
it is `./cloud/provision.sh create mybox --project my-project`.

It shows what it will create and roughly what it costs, then asks. Ten minutes
later you get `https://<ip>`, a password and a recovery passphrase, each shown
once. Three things are worth knowing before you use it:

- **There is no domain and no DNS.** Let's Encrypt issues certificates for bare
  IP addresses, so the machine's address is its name. A domain is optional and
  an addition rather than a replacement: `--domain ide.example.com` prints the
  A record to go and make, waits for it, and sets the machine up to answer to
  the name *and* the address — which is what you want the day the DNS is
  wrong. `create` again with a different one changes it; `--domain ""` removes
  it.
- **Your data is encrypted and the password is the key.** `/home` is a LUKS
  volume whose key is derived from the IDE password and stored nowhere. A
  snapshot, a disk clone or a stopped machine is unreadable; anyone with root on
  the *running* machine reads everything, which is why `create` refuses a
  project owned by an organisation unless you pass `--in-org`.
- **Ports 8000–8099 are public.** Anything listening on one of them is at
  `https://<ip>:<port>` with no password — which is how you show somebody what
  an agent just built, and a thing to know before an agent starts a server.

`provision.sh status | recreate | destroy` do the rest — what it is and who
touched it, a new VM on the same data disk, and taking it all down. Their own
`--help` and the comments at the top of `cloud/provision.sh` have the detail,
including what `destroy` keeps unless you ask it not to.

## Linking another machine

Link a second machine running this same IDE and everything open there is open
here — its projects, worktrees, sessions and queued prompts join the row. There
is no per-project subscription: an agent blocked on you is blocked on you
wherever it is.

The machine being linked has its own password, like any instance, and must be
reachable from the machine you use — `{ "bind": "0.0.0.0" }` in its config.
Add it in the open dialog with its address and **its** password: your server
signs in once and keeps the link it gets back, never the password, and your
browser never talks to that machine at all.

Over plain `http://`, only addresses on your own network are accepted — a
password that opens a shell should not cross the internet in clear.

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

## Working on it

```sh
pnpm dev            # vite on :5240, proxying the server on :7999
pnpm typecheck      # a gate
pnpm test           # the other gate
pnpm scratch start  # a throwaway instance, with its own state and port
```

`master` is protected: everything arrives by pull request and both gates must
pass. There is no linter; the compiler does that work. `CLAUDE.md` has the rest
— what a test is for here, what a commit message has to say, and why.

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
