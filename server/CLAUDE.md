# server

Fastify, one WebSocket, and a private tmux server. Everything here exists to
make one promise good: **a session survives the IDE.** The browser can close,
this process can be restarted, and the agent keeps working.

```
remote/         a project on another machine: scope.ts (ids), peer.ts (its API),
                proxy.ts (forwarding /api), relay.ts (forwarding the socket)
routes/api.ts   REST: projects, worktrees, sessions, changes, diffs, files, find
routes/ws.ts    the single socket; JSON control frames + binary output frames
workspace.ts    the one funnel for every project/worktree operation
files.ts        a worktree's own files: containment, listing, search, read, write
http-error.ts   HttpError, so workspace.ts and files.ts can both throw it
state.ts        state.json: projects and the opaque `ui` blob
session/        engine (sessions, attachments, sizing) -> tmux -> node-pty
  tmux.ts       every tmux invocation, and the metadata in @swb_meta
  mirror.ts     a headless xterm per session, for repaint and attention
  attention.ts  idle / working / needs-you
  readiness.ts  whether it is safe to TYPE into a session -- a stricter question
  dispatch.ts   hands queued todos to Claude when it comes to rest
  claude.ts     transcripts: --continue, the last prompt, and turn boundaries
                (the prompt reader is incremental -- see "What a worktree is
                working on")
git/            worktree.ts (discovery, add, remove) and changes.ts (status, log, diff)
usage.ts        Claude's own limits, read from `claude -p /usage` and cached
config.ts       every SWB_* env var, in one place
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
- **`@swb_meta` dies with the session.** Session kind and worktree id are
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
   a scrollback and the patterns are not all safe on the turns above it:
   several of them are ordinary English, and a live worktree's `Which way do you want to
   go?` matched the permission dialog's "Do you want to …" and held a tile amber
   through a turn the spinner was visibly running. That phrase pattern is gone
   now, because scoping to the turn could not save it either: an
   AskUserQuestion **stays on screen after it is answered**, inside the same
   turn, and the question Claude asks is usually phrased "do you want to …" --
   measured, three minutes of amber over an agent that was deploying. Nothing
   was lost by deleting it, measured on v2.1.270: the permission dialog draws
   `❯ 1. Yes` beside the phrase, and the trust dialog no longer contains the
   phrase at all, asking "Is this a project you created or one you trust?"
   over options that are not numbered -- so `❯ N.` misses it too, and what
   holds it up is `Enter to confirm` together with the `Esc to cancel` footer,
   which lands in the footer window because `tailText` pops trailing blank
   rows. A dialog
   Claude is showing now is always below the marker — measured on a real permission dialog whose
   question sat on line 28 of 34 with the previous turn's done line on 12. Weak
   patterns live in `PROMPT_FOOTERS` and are trusted only on the last three
   lines. `^1. Yes` was dropped outright: it is what Claude writes when
   *explaining* options, and it made a finished worktree read as waiting.

   **Nothing is believed while the input box is on screen.** That is the one
   measured thing separating a modal from an agent at work: Claude Code takes
   the box away while a modal is up — captured on v2.1.270, present at rest and
   mid-turn with a queue showing, absent on the permission dialog, the plan
   approval and an AskUserQuestion. It is the `─` rule drawn directly above it
   that identifies the box, never the chevron, which is also on every submitted
   user message, on the queued-message display and on a dialog's own selected
   row. This retired four false positives at once, all of them ordinary English
   Claude writes or quotes: `read -p "continue? (y/n)"`, "Press enter in that
   pane", "Would you like to proceed?", "use j/k to navigate". And it fails
   safe: a rule that stops being drawn means "no box", which is only today's
   behaviour again, while losing a real dialog would take a *wrong yes*.

   A menu is recognised by its **selected row plus a sibling option numbered
   one away**, within a few lines either side — not by `❯ N.` alone. The
   chevron was picked because Claude never prints one, but the mirror draws a
   submitted *user message* as `❯ <text>`, so a prompt opening "1. fix the
   parser, 2. then the tests" was a chevron, a digit and a full stop at the top
   of the turn, and held the window amber for the whole of it. All three menus
   measured on v2.1.270 — permission, plan approval, AskUserQuestion — put the
   sibling on the very next line.

   The gap this leaves is written up beside `INPUT_BOX`: an unnumbered dialog
   carrying none of the footer wordings reads as *finished*, which is the green
   light rather than a grey one, because its selected row is indistinguishable
   from the input box. Two candidate fixes were measured and both cost more
   than they save; the note records which, so the next person does not
   re-derive them.
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

`SWB_DEBUG_DISPATCH=1` logs every verdict change, which is how the predicate was
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
`@swb_meta`, so changing the derivation orphans every running session. A linked
machine's ids are namespaced in `remote/scope.ts` instead, by a short key
derived from its base URL — not here, because the ids this function makes are
the ones a machine gives its *own* projects, and a linked machine's arrive
already made. The `host` parameter has no caller left; it is the seam that was
named ahead of time, and the answer turned out to be one layer up.

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
in-flight read. `SWB_USAGE_CMD` overrides the binary and is deliberately *not*
`SWB_CLAUDE_CMD`, which a scratch instance replaces with vim or a stand-in.

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

## Who may reach this server

Two callers, no login, no cookie and no session between them — `gate.ts` is the
whole of it, and `config.ts`'s `publicOrigins` is the list it consults.

- **Our own page**, in a browser.
- **A gateway**, which is this same program on another machine reading a project
  that lives here. Not a browser; it presents `SWB_TOKEN`.

`SWB_TOKEN` is what a machine sets to *be* a peer. Set, anything arriving over
the network must carry it. **Unset, this instance serves only this machine** —
every request and every socket must come from a loopback address. That is not
belt-and-braces: with no credential, every header a caller could be judged by is
one the caller writes. Measured on `--bind 0.0.0.0` with no token, a request
from the network carrying `Host: 127.0.0.1:<port>` — a name this server
genuinely answers to — read the whole snapshot, and a socket forging
`Origin: http://127.0.0.1:<port>` was admitted, which is attach-and-type. So
binding elsewhere without a token is not a configuration that can be made safe,
and it now fails at the first request rather than quietly serving the network.

**The `/ws` check exists even on a normal instance**, and it closes a live hole:
a WebSocket is exempt from CORS, so any page you visit can open one, and every
liveness and attention change is broadcast to every connected sink with the
session id in it. Read an id off that broadcast, send one `{"t":"input"}`, and
that is a prompt and a Return typed into a running Claude. Neither the loopback
bind nor Caddy is in that path: the page runs in *your* browser, which is
already inside, and Caddy fronts the public name while the socket is reached on
127.0.0.1. Measured, and recorded in `test/ws-origin.test.ts`: the socket
opened, `clientCount()` went to 1, and a `session-state` frame arrived unasked.

Five rules, each of which was wrong once and found by measurement:

- **The name a request was addressed to has to be one we answer to.** This is
  the anti-rebinding check and nothing else catches it: a rebound page is
  *same-origin* with us, so it sends no `Origin`, needs no preflight, and
  reports `Sec-Fetch-Site: same-origin`. `Host` is the one thing it cannot
  change. `config.publicHosts` is derived from `--host` plus loopback; a gateway
  is exempt, because it addresses a peer by a name that machine never published
  and the token speaks for it. Both sets come from one canonicalisation, which
  is what stops them disagreeing: they were derived twice, and
  `https://IDE.Example.com` then allowed `/api` and refused `/ws`. A name that
  is itself scheme-shaped is dropped rather than repaired -- `new
  URL('box.local:8084')` does not throw, it parses as a *scheme*, whose
  `.origin` is the literal string `"null"`.

- **Key on the route Fastify matched, never on the URL text.** `request.url` is
  the raw request target and the router matches the *decoded* path, so the two
  disagree — and every spelling of that disagreement was a way through. Against
  a real peer with a token set and none supplied: `GET /%61pi/snapshot` returned
  the full snapshot, `/ap%69/…` likewise, an absolute-form target
  (`GET http://evil/api/snapshot`) did not begin with `/api` at all, and
  `POST /%61pi/sessions` **spawned a live shell** in one of its worktrees. That
  is unauthenticated command execution from anywhere on the network, and
  `routeOptions.url` — the string that actually answered — is the same however
  the client spells it. The `/api/health` exemption is an exact match for the
  same reason; `startsWith` also exempted `/api/healthz`.
- **A browser-set header proves nothing about a non-browser.** `Sec-Fetch-Site`
  and `Origin` are unforgeable only *inside* a browser, and the caller a peer
  has to keep out is not one. Both were accepted on their own, and both were
  defeated with one forged header: `curl -H 'Sec-Fetch-Site: none'` read the
  whole API, and a raw socket sending `Origin: http://127.0.0.1:<port>` — always
  in the allow-list — was admitted to `/ws`, where attach and input are full
  terminal control. So on a peer the **token is the only credential that crosses
  the network**, and a browser is believed solely from a loopback peer address,
  which a header cannot forge. Fetch Metadata now only *narrows* traffic that
  already came from this machine.
- **The refusal happens before the sink joins `sinks`.** Closing a socket that is
  already in the broadcast set is a race, not a fix.
- **An allow-list, not `Origin` against `Host`.** DNS rebinding makes those two
  agree — the attacker owns the name and re-points it here, so both read
  `evil.example` — and a name we never published is exactly what has to be
  refused.

Behind a proxy this process only ever sees `127.0.0.1`, so it cannot derive the
origin the page was served from and a deployment must say so: `--host`, which
`scripts/deploy.sh` passes. Unset, the loopback defaults still admit a
browser on this machine, so a scratch instance needs nothing — and every socket
through Caddy is refused, which is the failure to expect if it is forgotten.

Three consequences worth stating plainly. A peer's own web UI works only from
the peer itself -- its page is not even served elsewhere -- so you look at a
peer through the gateway. **Do not put a reverse proxy in front of a peer**: a
proxy connects from loopback, so everything it forwards would look local, and a
peer needs none because the gateway reaches it directly. And **the token is the
whole of a peer's security**, so it wants the properties that implies: high
entropy (`scratch.sh` generates one; a memorable one is not), and `https://` for
a peer across a network you do not own, since `PeerClient` sends it as a plain
header. There is no attempt limit and no lockout -- a token is the credential
for `POST /api/sessions`, which is arbitrary command execution on that machine.

Rebinding was worth closing rather than documenting: on a token-less instance
`/api` was fully *writable* by any page that kept a DNS record pointed at this
address. `POST /api/sessions` spawns a pty, and a queued todo is typed into a
live Claude by the dispatcher with no browser open — exactly the capability the
`/ws` check closes, reached through `/api` instead. Fetch Metadata narrows
browser traffic on top of that, on every instance rather than only on a peer: a
client sending none is not a browser and is judged by its address, while a
browser naming a cross-site initiator is refused. Measured before that,
`POST /api/worktrees/<id>/sleep` from a page you merely visited returned 200 —
it cannot read the reply, and does not need to in order to act.

## A machine you have linked

Linking another machine makes everything open there open here, and this server
is the gateway: it forwards, and the browser talks to one origin. See the root
`CLAUDE.md` for why that shape, and why linking rather than per-project.

Two pieces do the work, and both are small for one reason -- **a peer runs this
same program**, so the path that answers here answers there and the whole of the
translation is the ids:

- `remote/proxy.ts` is one `preHandler` hook, not a remote branch in each of
  twenty-five routes. Which machine a request is for is decided by the scoped id
  *in the request*, so a route added later is forwarded without anyone
  remembering to. `?host=` steers the three routes that name no resource yet --
  browsing a machine's disk, its recents, and opening a project on it -- and is
  **refused** anywhere else: unrestricted, `PATCH /api/ui?host=` replaced a
  peer's stored layout and `POST /api/servers?host=` linked it to a machine of
  the caller's choosing.
- `remote/relay.ts` is **one upstream socket per browser socket per peer**. The
  peer then sees one client per browser, so its own `sizeOwner` / `inputOwner`
  arbitration decides between two viewers of a remote terminal -- the same rule
  in the same place as for a local one. Verified against the real thing by
  pitting a viewer connected through the gateway against one connected straight
  at the peer: they arbitrate as equals, which a gateway-local arbiter could not
  produce.

  **A gateway's own socket gets no relay.** Two machines linked to each other
  otherwise melt down: A's relay opens a socket to B, B accepts it as an
  ordinary client and gives it a relay, which opens one back. Measured at ~55
  new sockets per second each way, self-sustaining once the sockets are each
  other's clients, ending in `EMFILE` on both. Linking a machine to itself is
  the same thing in one process, and is refused by instance id -- not by
  address, since the address is what is being got wrong.

  **The link holds what the browser is attached to and re-claims it on every
  reconnect.** A peer restarting is the ordinary event -- it is a deploy -- and
  the browser will not re-attach for us: it re-attaches in its own socket's
  `onopen`, and its socket never closed. Without this, one blip left every
  remote pane dead for the life of the page. A `detach` removes the record, or a
  pane closed while the peer was away is re-claimed when it returns and a stale
  primary goes on owning that session's geometry.

Terminal bytes are forwarded with four header bytes rewritten and the payload
untouched -- `streamId` is a `uint32` in a five-byte header, never a string id.
The gateway hands out stream numbers from its own range, because a peer's and
the local engine's both start at 1.

What `workspace.ts` contributes is `localTo`, and every line of it is a rule:

- **A machine's own projects only**, never the machines it is itself linked to.
  Non-transitive is what stops C's worktrees arriving through B under ids B
  scoped for itself, and it is the other half of why two machines linked to each
  other terminate.
- **Its ids, kept.** A remote project is known by the peer's own id, scoped.
  When this server minted one of its own, nothing about that id said "another
  machine" and `POST /api/worktrees` -- the one route that addresses a project
  -- was answered locally and refused, so creating a worktree on a remote
  project was simply unreachable.
- **A machine that did not answer keeps its projects and worktrees and loses its
  sessions.** The UI prunes stored layout for worktrees it cannot see, so
  dropping them costs panels and open files permanently; and liveness recalled
  claims an agent is running, and that one is *blocked on you*, on a machine
  that is off. Both memories -- `lastGood` in the process and `remoteCache` in
  `state.json` -- go through the one function that strips them, because
  returning either directly put the sessions back.
- **The snapshot gets the same budget as any other read.** It had half, so the
  read that paints the whole row gave up soonest -- and a timeout is
  indistinguishable from a machine being off, so a *healthy* peer with a blocked
  agent came back grey.

Three more, each measured rather than reasoned:

- **A peer answers a gateway with its own world only** (`x-swb-peer-read`), or
  two machines linked to each other recurse until the timeouts fire at the
  leaves: 5.1 seconds and ~86 requests against 125ms and one.
- **A peer's errors arrive whole** -- message, `code` and `details`. The client
  acts on the code: `path-missing` is what turns a failed open into the offer to
  create it, and `stale-file` carries the `rev` that resolves a save an agent got
  to first.
- **A peer's `session-state` is forwarded for sessions the snapshot merged**,
  not for the ones this browser is attached to. `applySessionState` updates any
  session in the store, which is how an unattached tile's bullet changes colour
  at all -- filtered on attachment, a remote worktree asleep with Claude still
  running asked a question and the bar stayed grey.

And one about being the *other* machine: **the credential lives with the
machine, never on a project.** `Project` is in every snapshot the browser
receives; `RemoteServer` is not. `state.json` is written `mode: 0o600` because
of it, and the mode is set on the temp file so the contents never exist under
the umask. Only local projects are stored at all, forced in `reviveProject` --
which is what retired the guards `worktrees()` and `createWorktree` used to
carry against a stored remote project sending local git at a path on another
machine.

## Flags

| Flag | Meaning |
| --- | --- |
| `--host <name[:port]>` | The public name a browser types. Repeatable, or comma-separated. A bare name allows **both** schemes; write `https://…` to pin one. Required behind a proxy. |
| `--bind <address>` | The address to listen on. |

Two things are flags rather than environment variables, and both for the same
reason: they are what a *deployment* has to get right rather than a developer.
A flag shows up in `ps`, cannot be inherited by accident from a parent shell,
and a wrong one is visible in the command that started the process instead of in
an environment somebody has to go and read.

`--host` is the public name and `--bind` is the address: one word for each, on
purpose. They were `SWB_PUBLIC_ORIGIN` and `SWB_HOST`, which put "host" on the
one you answer *on* and left the one you answer *to* named something else — and
these are security settings, where the cost of configuring the wrong one is not
a typo.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `SWB_BIND` / `SWB_PORT` | `127.0.0.1` / `8084` | Where the server listens. `--bind` overrides. |
| `NODE_ENV` | unset | `development` also trusts Vite's origin; anything else does not. `production` turns off the pretty logger. |
| `SWB_TOKEN` | unset | Set to be somebody's peer. Unset, this server answers loopback only. |
| `SWB_SERVER_NAME` | `os.hostname()` | What this machine calls itself in another's picker. |
| `SWB_STATE_DIR` | `~/.config/switchboard` | `state.json` *and* the tmux socket. |
| `SWB_TMUX_SOCKET` | `<state dir>/tmux.sock` | Overrides just the socket. |
| `SWB_TMUX_CONF` | `server/tmux.conf` | The config loaded with `-f`. |
| `SWB_CLAUDE_CMD` | `claude` | Command for agent sessions. |
| `SWB_USAGE_CMD` | `claude` | The real binary, for reading `/usage`. |
| `SWB_SHELL` | `$SHELL` | Command for terminal sessions. |
| `SWB_MIRROR_SCROLLBACK` | `5000` | Lines each server-side mirror keeps. |
| `SWB_MAX_FILE_BYTES` | `2097152` | Largest file the files panel opens or saves. |
| `SWB_WEB_DIST` | `web/dist` | What `pnpm start` serves. |
| `SWB_LOG_LEVEL` | `info` | Fastify's logger. |
| `SWB_DEBUG_SIZE` | unset | Log every size decision and its owner. |
| `SWB_DEBUG_DISPATCH` | unset | Log why a queued todo did or did not go. |

All of it is in `config.ts`. `SWB_STATE_DIR` is the one that matters for
testing: it moves both `state.json` and the tmux socket, which is what makes
`scripts/scratch.sh` unable to touch a real instance. `SWB_CLAUDE_CMD` swaps the
agent for something cheap. `SWB_DEBUG_SIZE=1` logs every size decision with the
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
