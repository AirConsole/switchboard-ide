# web

React, xterm.js, and plain CSS with custom properties. No component library, no
CSS framework, no state library — `store.ts` is a subscription over a plain
object, and that is enough.

```
App.tsx              projects -> groups -> the row; every dialog; UI state writes
store.ts / socket.ts the snapshot, and the one WebSocket
api.ts               REST calls, typed against shared/
components/TopBar    the tab strip: project heads, tabs, usage bars
components/WorktreeTab  one worktree as a row: the strip, the project pane, Move to
components/ProjectPane  a project's own pane: its worktrees, a new one, closing it
components/useAnchoredMenu  a menu hung under its trigger, kept on screen
views/Overview       the row: spot arithmetic, scrolling, what fits
views/TodoPane       a worktree's todos, RUN NEXT, and Move to
views/TerminalsPane  a worktree's terminals and their tab strip
views/ChangesPane    what changed and what was committed; the patch renderer
views/FilesPane      the panel: its three modes, the search box, and the editor
editor/CodeEditor    one CodeMirror view over one file
editor/theme         the syntax palette and the editor's chrome
editor/language      filename -> grammar, fetched on demand
terminal/TerminalView  one xterm bound to one session
views/overviewLayout   MIN_PANE_COLUMNS, PANE_CHROME_WIDTH, measureMonoCharWidth
views/useNearViewport  whether a tile is close enough to mount its terminal
views/tileMotion       keeps a departing tile alive while it animates out
```

## The top bar is Chrome's tab strip

Copied on purpose, and closely: everyone already knows what a tab strip is,
which tab they are in, and what the × on one does. Chromium's own constants are
the reference — `chrome/browser/ui/tabs/tab_style.cc` gives a 10px top radius
and a 2px separator 16px tall — scaled into the 38px bar.

What is **not** copied is Chrome's *shape*. Its tabs stand on the toolbar and
grow feet to run into it. The feet went with the ground they ran into: the page
is black and the tab you are in is the lit one, so there is nothing to be
continuous with — and they cost a 12px overhang across each neighbour's click
target that needed `pointer-events: none` to be safe, and a `z-index` on two
states to paint in the right order. Both are gone; every tab owns its own width
at its left edge, its centre and its right, `elementFromPoint`-measured.

**A project is one slab and the tabs are its segments.** They were pills for a
while — round on every side, floating in the sleeve — and that is what made the
grouping fail. Round pills are each their own object, so a row of them is a row
of objects that happen to be near each other; **square segments inside one
rounded shell are one object divided**, and the container holds every outer
edge. So `.tab` is `border-radius: 0` and `.tabgroup` is `9px 9px 0 0` with
`overflow: hidden` and no padding: the first segment wears the shell's left
curve, the + wears its right, and the sleeve is seen only in the 2px seams,
which is all a trough was ever for. It is the strongest grouping available
without colour, which is the channel this interface will not spend on identity.
Verified 1:1 off the rendered pixels: the slab's left edge curves in over six
rows and the head segment is clipped by it, and a seam measures exactly two
columns of `--sleeve` before the next segment's state bar.

What is **not** copied is Chrome's colour. A tab group there picks a hue; here
the sleeve is grey, and the only colour on a tab is its **state bar** — 4px down
its leading edge: amber blocked on you, green done, grey working, and dashed
grey when nothing is running, which is the old hollow bullet's job done by solid
against dashed. (A blocked tab's *label* is amber too, which is the one place the
state reaches past that bar.) Identity is not what colour is for in this
interface.

The pieces, and why each is the way it is:

- **Every surface picks a level; none invents a value.** The ladder is six
  rungs, deepest first — `--level-frame` (the top bar), `--level-ground` (the
  page and the terminal), `--level-panel` (tiles and dialogs, and the project's
  head), `--level-raised` (menus and the sleeve), `--level-object` (a thing at
  rest on a surface: a tab, a segment, a scrollbar thumb) and `--level-lit` (the
  one you are in, wherever you are — the tab, and a selected row in the files or
  changes list, which is the same statement). `grep -- --level-` finds every
  surface at a given depth. `--sleeve` survives as an alias
  because the comments around the strip are written in them.

  This replaced twelve grey tokens describing about five rungs. The names used
  to say which component first needed the colour, so a new component needed a
  new name: `--sleeve` and `--slab-raised` measured **1.014:1** apart,
  `--tab-head` and `--slab` **1.010**, `--rule-bright` and `--tab-hover`
  **1.046**. Two colours that close are one colour with two spellings — nobody
  resolves the step, so nobody notices when the two ends drift.

  **The values did not move, and respacing them was measured and rejected.**
  Every invisible step is at the dark end, because contrast is
  `(L₁+0.05)/(L₂+0.05)` and near black the constant swamps the luminance:
  `--level-frame` and `--level-ground` differ by **72% in luminance** and
  measure **1.05:1**. An evenly stepped six-level scale widens exactly the steps
  nobody reads anything against, and pays for them at the light end, where it
  puts `--graphite` on 4.41 and 3.17 — under the floor on two levels instead of
  one.

  **The ceiling is the quiet grey, not taste.** `--graphite` clears five of the
  six levels (7.94, 7.54, 6.98, 6.44, 5.19) and fails on `--level-lit` at 3.90,
  which is the entire reason `--quiet-on` exists. So each level carries the grey
  its quiet text is set in, and a seventh level would not be a colour decision —
  it would be a third grey.

  **Hover is an operation, not a level**: `--level-hover` is
  `color-mix(in srgb, var(--level-lit) 40%, var(--level-object))`, part-way from
  where you are to where clicking takes you, so it cannot drift from either end.
  40% and not 50% because `--graphite` has to survive it — the halfway mix lands
  on 4.48:1, just under the floor, and this lands on **4.62**. It resolves to
  `#313b4a`, which is the old `--tab-hover` to the pixel.

  **`--rule` and `--rule-bright` are lines, and only lines.** `--rule-bright`
  was the most-used token in the app at 45 uses, 16 of them fills — a border
  name doing a surface job. Its fills went to the level each one actually is:
  eight hovers to `--level-hover`, three selections to `--level-lit`, three
  objects to `--level-object`, and two that turned out to be `height: 1px`
  bands kept the name, because a rule drawn as a background is still a rule.

- **The bar has its own ground, `--bar`, and that was the whole contrast
  problem.** It used to be `--ink`, the page's, and the sleeve measured
  **1.08:1** against it — so the trough that says "these tabs are one project"
  was not visible at all, and every complaint about the strip followed from it.
  Chrome runs its frame against its toolbar at 1.33:1 *and* gives each group a
  hue. `--level-frame` is `#0a0d12` and the sleeve is `--level-raised`, which is
  1.23:1, and the shell's shape carries the rest.
- **The project is the group's first segment**, not a bead in front of it. It
  was a 22px fully-round pill, vertically centred, 14px clear of 32px tabs — a
  different shape at a different height with a gap after it, which is exactly
  what "dangling" was. Now it is the tabs' own height, flush against them, and
  it wears the segments' own `--level-object`. It was a rung *below* them, and
  that was wrong for a measured reason: the head and the `＋` are the two
  segments at the **ends** of the slab, and at `#171c24` they were **1.14:1**
  against the bar behind them — they dissolved into it, so the shape lost both
  its ends and read as the tabs alone. At `--level-object` it is **1.53:1**.
  What separates the head from a tab is no longer the fill but the type:
  uppercase and letterspaced at label size, because a heading is not a name you
  read one character at a time. Its × stays on it — closing a project is the
  project's own action.
- **The tab you are in is `--level-lit`**, the lightest thing on the strip, and one
  rung higher than it was: 2.26:1 over the bar where it used to be 1.66. That
  rung is not free, and the price is one value. `--graphite` is what every quiet
  thing on a tab is written in — the ×, the dirty count — and it cleared the old
  `--tab-on` at 4.54:1 and measures **3.90:1** on `--level-lit`, under the
  floor. So
  `--quiet-on` (`#b3bac6`, 4.89:1) exists for exactly that ground and nothing
  else. Any future attempt to brighten the active tab pays the same toll; the
  ceiling on it has never been taste.
- **The 2px seam is the only sleeve you ever see.** It is what keeps two
  segments of one fill from reading as one shape, and it is what retired
  Chrome's separator: a 1px mark hung off each tab's left edge and hidden either
  side of the active and hovered ones, three rules doing what a gap does. The
  bar's bottom rule is still a background rather than a border, which is what
  lets the slab paint over it.
- **The status is a bar, not the fill**, and that was the question. The fill is
  the loudest channel on the strip — amber over the sleeve measures 9.70:1 where
  every other step here is 1.18 to 1.54 — and it is already spoken for: it says
  which tab you are in. Filling a tab with its status costs that twice, since
  `--bone` on `--signal` is 1.38:1 and on `--done` 1.36:1, so those tabs' text
  has to flip to `--ink` and the label's own 1.92:1 "you are in this one" step
  has nowhere left to go. Four candidates were drawn before this one: a bone ring
  for the active tab dies at 1.38:1 on exactly the amber tab it matters most on,
  and the only active signal that survives a coloured fill is **shape** —
  square shoulders on the active tab — which is the honest answer if the fill is
  ever wanted for status after all — and since the tabs went square, that answer
  is available for free. The bar gets roughly four times the old bullet's area
  for none of it, and a severity stripe is nowhere a way of saying "selected". It is drawn as a **background gradient with a hard stop**, which is
  the only one of the three ways that gives a straight edge: an inset box-shadow
  is the box minus a copy of itself shifted 4px, so *both* the band's edges take
  the 9px radius and it bends away along the top and bottom of the pill instead
  of ending in a line — it looks right in a mockup and wrong on a tab. A
  background is painted inside the border box and clipped by the radius for
  free, so the outer edge takes the curve and the inner edge stays vertical,
  and the menu's stacked tabs get it from the same rule. Measured 1:1 off the
  rendered pixels: the band's right edge lands on the same column for all 27
  rows of the pill, and only its left edge moves with the curve.
- **Removal only asks what it has to.** `removalQuestions` reads the same two
  counts the tab shows: uncommitted work is what makes git refuse without
  `--force`, and unmerged commits are what make deleting the branch a decision.
  A clean worktree is not offered a "discard changes" box to rule out, a branch
  the default branch already has goes with the worktree rather than being put to
  a vote, and when neither is left to ask the removal dialog does not open at
  all — the sleep dialog's button drops its ellipsis and does it.
- **The branch on the remote is asked the same question, separately.** A branch
  that was pushed has a second copy, and `remoteBranch` / `remoteBranchMerged`
  put it through the same rule: unmerged, it is its own checkbox; already on the
  default branch, it goes with the worktree unasked. Two answers rather than one
  because the halves disagree — a branch can be ahead locally and spent on the
  remote (unpushed commits) or the reverse — and one box would delete whichever
  half the reader was not thinking about. It is also the only answer on this
  dialog that leaves the machine, which is why the server pushes the deletion
  *before* it destroys anything local, and under `--force-with-lease`: mergedness
  is read from `refs/remotes` and nothing here fetches, so the lease is what
  stops "merged, delete it" throwing away a colleague's push. A failed lease
  leaves the dialog open with git's own words and the worktree untouched.
- **What is running is told, not asked.** `removalWarnings` covers what git
  knows nothing about: a Claude that is working or waiting on you, todos queued
  behind it, terminals still running. Each is one red line (`--danger`, the
  colour of the button they lead to; amber means an agent is blocked on you and
  nothing else), and none is a checkbox, because there is nothing to decide —
  they go whatever you answer. They are also what makes the dialog open for a
  worktree that is clean and merged: without them, a click removed an agent
  mid-turn with four todos behind it and asked nothing. Only a worktree that is
  clean, merged, running nothing and holding nothing goes without the dialog.
- **The project's name is its pane's tab.** It was a label with an × on it, and
  that × closed the project — the same glyph a worktree's tab uses to merely
  sleep it, one mis-click apart. Closing lives in the pane now; the head is a
  button that walks you there and lights `--level-lit` while you are in it, with
  `--bone` text, because `--graphite` is 3.90:1 on that ground.
- **The head's state bar carries only its sleepers, and only amber or green.**
  That is the zZ tab's job, which was the one thing that could not be lost when
  it went: sleeping does not mean stopped, so a sleeper blocked on you still has
  to reach the top bar. An awake worktree says its own state on its own tab, so
  the head reports what has no tab. `tab--working` and `tab--off` are never
  applied to it — a summary that is always lit is not a summary. A quiet `zZ`
  beside the name says there is something behind this project you cannot see;
  it carried the count for a day and that was noise, since how many is a thing
  you find out by looking and the pane is one click away.
- **The × opens the sleep dialog**, which is also where deleting lives — so a
  worktree's own toolbar carries neither a trashcan nor a zZ: both questions are
  asked here, on the tab, and asking them twice in two places only made the
  window's bar longer. A tab is therefore a `<span>` wrapper with two buttons
  inside it: a `<button>` inside a `<button>` is not HTML.
- **A tab says whether work is left in the worktree**, in one slot: the dirty
  count when there is one, otherwise a fork glyph — GitHub's `repo-forked` way
  up, two heads over a shared trunk — when the branch has commits the default
  branch does not. Committed and uncommitted work answer the same
  question, and the count is the more urgent answer, so it wins the slot. The
  **Files toggle in a window's own bar carries the same slot** — `ForkIcon` is
  shared for exactly that reason — because it is the control you click to look
  at the answer, and two glyphs for one fact would be two things to learn.
- **A tab does not name the branch.** A worktree is nearly always on the branch
  it is named after, so it was a second copy of the name most of the time and
  every tab paid width for it. The window's own bar names it, and so does a
  tab's title.
- **The same row, stacked, in three places.** `WorktreeTab` draws a worktree in
  the strip, in a project's pane and in the todo panel's **Move to** list, and
  that is one component because a worktree met in three places has to be one
  object. The list forms used to invent a row of their own, with the state
  spelled out in words and the prompt on a second line, which made the same
  worktree look like different things depending on where you met it; both facts
  are on the row itself, the state on its bar and the prompt in its title. A
  stacked row needs a height said out loud -- it has no 38px bar to derive one
  from -- and left at its natural 15px it is all radius: 9px top and bottom is
  its whole left edge, so the state bar has no straight run to fill and comes
  out a crescent while the strip beside it draws a bar.
- **Widths come from a cap that tightens with the count**, `data-tight` on the
  strip, not from flexbox. Two attempts failed and the measurements are worth
  keeping: `min-width: 0` on the body is what lets a name ellipsise, and it
  zeroes what the body contributes to an `auto` flex basis, so every tab
  collapsed to its floor with the strip half empty; `width: max-content` fixes
  that and then a tab's min-content *contribution* is its full width, so the
  sleeve cannot shrink at all — measured, min-content 1402px against a 1402px
  sleeve — and the strip scrolled while there was room. Nor may the sleeve carry
  `min-width: 0`: it then shrinks past its own tabs and one project's tabs
  overprint the next project's.
- **The strip runs Chrome's way round, and the page runs with it.** A dark
  interface usually gets darker as it goes deeper; Chrome's strip does the
  opposite, and that is what makes it legible: the frame is the darkest thing on
  screen, an unselected tab *is* the frame, and the tab you are in is a light
  grey continuous with the toolbar under it — a hole cut in the frame onto the
  surface below (measured from Chrome: frame `#202124` against toolbar `#35363a`,
  1.58:1). What we keep is that direction, not the continuity: the page is
  black, and `--level-lit` (`#3b4657`) is simply the lit one —
  1.75:1 above the sleeve it is seamed into, and 2.26:1 above the bar,
  against 1.17:1 when the tab you were in was the dark one. It stops there
  because `--graphite` — what everything quiet on a tab is written in, and it
  lands on this ground on that tab — is 4.54:1 against it; one more rung is
  under the floor.
- **Hover lifts the fill a rung, and only the fill.** `--level-hover` sits between
  `--level-object` and `--level-lit`, which is where a hover should point, and clears
  `--graphite` at 4.61:1 — the tightest of the three tab grounds now that the
  active one has `--quiet-on` of its own. The label deliberately stays `--graphite`: the tab you are in is only
  1.06:1 lighter than a hovered one, so lighting the label on hover too would
  leave nothing to tell them apart. Bright text is what "you are in this one"
  means, and it outranks an echo of the pointer.
- **Brightness says which tab you are in**, which is Chrome's other half of the
  job — its unselected titles are dim and its selected one is bright, and that
  difference does as much work as the tab's shape. Every tab here used to be
  `--bone`, so the *only* thing saying where you were was that 1.28:1 fill. The
  resting label is `--graphite` (6.98:1 on the sleeve) and the active tab's is
  `--bone` (7.48:1 on `--level-lit`): 1.92:1 between the two labels, against 1.0
  before. What that channel used to carry — awake or asleep — costs nothing to
  give up, since every tab in the strip is awake.
- **Contrast pins two more rules.** Everything quiet on a tab is `--graphite`
  on every ground but one — 5.19:1 on a resting segment, 4.61 hovered, 6.91 on
  the project's head — and `--quiet-on` on the lit segment, which is the light
  one and where `--graphite` finally falls through the floor at 3.90. It used to
  be a single value across all three; raising the active tab is what bought the
  second, and it is the whole price of that rung. And the project head's ×
  turns `--danger` with no ground under it — and `--danger` itself was lifted
  `#e5707a` → `#eb8087` when the head joined the tabs, because on
  `--level-object` the old red measured **4.19:1**, under the floor. That is the
  lightest ground any red here lands on, so clearing it at 4.82 clears the rest:
  the dialogs and the todo list, both on `--level-panel`, go 5.64 → 6.49. One
  red raised, rather than a second red for one control.

## Remote projects are not this package's problem

A project can live on another machine, and **nothing here knows**. `api.ts`
still speaks to one origin, `socket.ts` still opens one socket, `store.ts` still
merges one snapshot, and a worktree id is a worktree id. The server forwards and
namespaces; see `server/CLAUDE.md`.

That is deliberate and worth keeping. The subtle parts of this package -- the
unit arithmetic, `useNearViewport` and the WebGL budget it protects, the
document-level capture listeners every shortcut is built on, the focus model,
and `ui` being one last-writer-wins document -- are all things a second origin
in the row would have broken, and an iframe per window would have broken all
five at once.

One line of `socket.ts` knows, and only just: **a second `attached` for a session
already mapped is a re-attach, and repaints.** When a remote worktree's machine
restarts, the gateway re-claims the attachment on our behalf and this socket
never closes -- so nothing else would ever clear `painted`, and the pane went on
showing the screen from before the restart while everything printed in the gap
was dropped. Claude runs on the alternate screen, where a serialized repaint is
the only thing worth anything. The stale stream number is dropped with it.

The other component that knows is `OpenProjectDialog`, because somebody has to
pick the machine: a `host` key goes to `browse`, `recents` and `openProject`,
and the server decides what it means. Adding a machine takes its token, which
goes to our own server and no further -- the browser never talks to a peer.

## The row is a grid of units

`Overview.tsx` holds the only layout arithmetic:

```ts
unitPitch = (minPaneWidth + GAP) / 2   // a unit is half a pane
units = max(2, floor((width - GAP) / unitPitch))
pitch = (width - GAP) / units          // a unit plus the gap after it
tileWidth = tileUnits * pitch - GAP    // a tile swallows the gaps it covers
```

**A unit is half a pane**, and that halving is the whole of it. Panes declare
what they want in `PANE_UNITS`: two for Claude, a terminal or the todos, and
three for the files panel — a spot and a half — because that panel spends a
quarter of its width on the tree beside the editor and at one spot its editor
came to 56–63 columns, under the 80 the layout exists to guarantee. Measured,
and worse the wider the monitor: 57 columns at 3440px, because more spots fit
and a two-pane tile is always two of them. At three units it is 90–107 columns
from 1687px up, and 82 once the editor asks for exactly 80.

**The files panel is one unit while it is only its tree**, and a project's own
pane is one always. They are the two exceptions to "nothing may ask for one
unit", and both are chrome rather than something you read code in: the floor of
two exists to keep the 80-column promise, and that promise is about panes you
read *code* in — a terminal, a diff, the editor.

**A project's pane is the head of its run of windows** — see `ProjectPane`. It
holds that project's awake worktrees, its sleeping ones, the form for a new one
and the button that closes it: everything that is about the *project* rather
than about one of its worktrees, which the top bar used to carry as a ×, a `zZ`
dropdown and a `+`. A menu is the wrong home for a list you want to scan, and a
modal the wrong shape for "and one more", which is a standing offer rather than
a question.

It is a pane you can walk to: `PaneKind` includes `'project'`, cells are keyed
by `projectKey(projectId)`, and the Cmd+arrow stops are keyed by the cell rather
than by a worktree, so the walk reaches it with no special case. Arriving puts
the caret in **the branch box** — naming the next worktree is what you come here
to do often enough. It has to hold the keyboard somewhere regardless: the
stepper reads where it is from `activeElement`, so a pane that refuses focus is
one the walk can never leave.

**The field says which of the two things it is about to do.** `git worktree add`
either checks out a branch that is already there or cuts a new one from the
default, and the name alone does not say which — "Branch from" used to imply it
by sitting there empty, and removing that box removed the only hint. So
`GET /api/projects/:id/branch` answers a beat after you stop typing (one
`show-ref` behind `describeBranch`; the staleness guard is the branch itself
rather than a counter, so a reply that is not about what is in the field now is
dropped whichever order they arrive in, and a failed request says nothing rather
than claiming the branch is new). The line under the field reads *"fourth"
exists — it is checked out here, not branched from HEAD*, or *New branch, from
HEAD*.

**A branch another worktree holds is refused outright**, because git checks a
branch out in one worktree at a time and Create would end in
`fatal: 'x' is already used by worktree at ...`. `usedBy` comes back with the
answer and the button goes off; the *path* rather than a boolean, since "already
in use" is only useful if you can go and look at what is using it. Note the
distinction the field used to hide: a branch that merely **exists** is fine — it
gets checked out rather than cut — and only one something is **holding** is
impossible. Refusing is on a *known* no rather than the absence of a yes, since
the answer is in flight for a beat after every keystroke and refusing on silence
would flicker the button off as you type.

The surprising answer goes **bright**, not amber. `--signal` was the first
reach and it was wrong: amber means an agent is blocked on you and nothing
else, and a form saying what a button will do is not a state you scan a row of
agents for. `--graphite-dim` to `--bone` is the 1.92:1 step that already means
"read this one".

**The room for that line is reserved, not made.** It is rendered whether or not
there is anything in it, and `.addform__fate` is `min-height` two rows tall —
because the answer lands a beat after you stop typing, and a line appearing then
shoved the field you were still looking at. Two rows rather than one for the
same reason: the longest of these messages wraps at this width, and a box that
grows from one row to two jumps exactly as badly as one that grows from none.
The path in it is said **relative to the project** (`.claude/worktrees/x`, and
"the project itself" for the root), which is both what keeps it inside two rows
and the only part worth reading — this line is shown inside that project's own
pane, so the absolute path is mostly its root repeated back. The full path stays
in the `title`. Measured across empty, typed-but-unanswered, a two-line answer
and a one-line answer at 1180×620: field, path, line and button all sat at
y=463, 503, 522 and 565 every time.

**The project's name is 19px**, not a tile bar's 12. This pane is the only cell
in the row whose bar is not a toolbar — there is nothing beside the name to keep
small for — and it is the thing you scroll the row looking for.

**Its foot does not scroll.** The lists grow — a project can have twenty
worktrees — and a form you have to scroll to is a form you stop using, so the
new-worktree field and Close project are pinned under the part that moves. That
form is **one field**: "Branch from" was left empty every time, since the
remote's default (or HEAD without one) is what you want unless you are doing
something unusual and something unusual is what a terminal is for; and "Start
Claude here" was checked every time, because a worktree with no agent in it is a
directory. The server still takes both parameters — this stops asking.

**Close project is the form's last row, not a button under it.** Both are things
you do to the *project* rather than to one of its worktrees, so they sit under
one heading with one rhythm and one edge; it was a stray control below a form
that read as belonging to neither. It is shaped like a tab, which is what the
pane's other controls are, and turns `--danger` under the pointer: the red the
project's × used to turn, said on the thing itself.

The lists are `WorktreeTab`, the same component the strip's tabs are, keeping
every `.tab*` class — only the container differs. A worktree met in the pane and
met in the strip has to be one object. They deliberately carry no `data-pane` of
their own: a row claiming a worktree's pane key would teleport the walk, so they
resolve to the pane's. The cell carries its `ProjectGroup` rather than looking
the project up by id, because `useTileMotion` keeps a departed cell on screen
for its exit and anything re-derived from `projects` is gone by then — and
closing a project is now a button *inside* that cell, so that is the common path
rather than a rare one.

A tree is chrome: names at a few levels of indent,
its own floor 158px, against a unit that measures 336px at 2400px and 403px on a
phone. So `panesOf` asks `filesContentOpen` before it asks `PANE_UNITS`, and a
worktree browsing its files is three units where one reading a file is five —
measured, 1011px and 1694px at 2400px. Two things fall out of that and must stay
true: a panel that asks for *less* than the floor cannot settle for less still
(`least` is `min(wants, 2, capacity)`, not `min(2, capacity)`), and a panel alone
on the window takes `capacity` rather than what it asked for, or a phone would
show a tree down one half of the screen and nothing down the other.

A panel asks, and **Claude is what gives way**. Files wants three units; on a
window with only four it does not settle for two, because two is what puts the
half you are reading under the floor — measured at 1500px, the editor came to
**70 columns** beside Claude and **82** with Claude hidden. It used to settle,
on the argument that a narrower editor beats no agent; a diff you cannot read at
80 columns is not a narrower editor, it is a broken one, and the agent is still
there the moment you close the panel. `wants > least` in `panesOf` is exactly
"this panel would have to be squeezed", since `least` is what the squeeze would
give it. A panel that asked for no more than a pane's floor — todo, terminals,
the files tree by itself — still settles beside Claude as it did.

Measured across the band, with a file open: 1400px and 1500px (four units) hide
Claude and give the panel the window; 1687px and up (five) show both. Every one
of them lands the editor at 82 columns.

Two consequences to preserve. **The row comes to rest on a pane's leading
edge**, so a pane is never shown cut down the middle; the snap points are one
out-of-flow `.grid__spot` marker per pane start, listed in `rest`, plus the far
end. They were one per *unit*, and a unit is half a pane: the row could stop
with half of Claude beside half of a terminal, and on a phone — where a window
is the whole screen — that was the *usual* place a swipe landed, two halves of
two worktrees and neither of them readable. A pane is the smallest thing worth
looking at, so it is the smallest thing worth stopping on, and it is already the
granularity the Cmd+arrow walk uses.

Three things fall out of that and are load-bearing. `nearestOffset` has to
**return one of those stops**, because mandatory snapping governs programmatic
scrolls too and the browser would otherwise re-snap the offset it was just
given, somewhere that cuts the tile it was asked to reveal. **The far end is a
stop whether or not a pane begins there**: the last reachable offset is
`totalUnits - units`, which lands mid-pane whenever the tail does not divide
evenly, and without it the last window could never be seen whole — it is also
exactly the low end of `nearestOffset`'s range for the last tile, so revealing
that tile and resting at the end are the same offset. And **a wheel notch goes
to the next stop in the direction it is travelling** rather than a flat two
units: two units is one pane only while every pane is one, and the files panel
is three, so a notch used to leave the row a unit inside the next pane with the
one after it undoing the mistake.

Measured at 2400px, where the row is seven units of 341px and `fourth` holds
Claude beside an open file (five units, at unit 3): stops at units 0, 1, 3, 5
and 6 — 5 being the files pane's own edge inside that tile, 6 the far end.
Wheel right stepped 341 → 1023 → 1706 → 2047 and held there; wheel left came
back 1706 → 1023 → 341 → 0. Clicking the tabs landed on 2047, 341 and 1023,
each on a stop and each with the named window whole on screen. On a 400×800
phone, where every tile is one pane, the stops are units 0, 1, 3, 5, 7, 8 and
five swipes walked 0 → 1 → 7 → 8 — a flick crossing several stops, never
resting between two. And **a tile wider than the window is collapsed, not squeezed**:
`panesOf` drops Claude's pane first, which is all it ever has to drop now that a
worktree shows one panel at a time — a tile is two, four or five units, so the
only window it cannot fit whole is one a single pane already fills. That is what
retired the machinery that used to close panels the layout could not keep:
nothing is ever held open behind the scenes, so a toggle cannot lie about what
is on screen.

`ui.panels` is still a list per worktree, because stored state predates the
one-at-a-time rule and can still name several. `openPanelsOf` takes the last —
the newest wins, which is the rule a too-narrow window already used.

`scrollTo` names a worktree and says nothing about where to put it: the row
moves by the fewest units that bring the whole of that tile on screen, and not
at all if it is already there (`nearestOffset`, `wholeOnScreen`). A tab click, a
Cmd+arrow step, waking, and opening a panel all mean that same thing, so
whatever you were already looking at stays in front of you when it can.

**Focus landing in a pane means it too** (`revealTile`). Navigation lands the
row on a tile boundary, but a drag or a wheel leaves it wherever the gesture
ended, so the window you reach for is often the one hanging half off an edge --
and the caret used to go into a pane a third of which was on screen and stay
there. It reaches the same two functions, so a window you can already see whole
does not move. It is deliberately *not* routed through `onReveal`: that hands
the keyboard to the pane it names, and this is triggered by the keyboard
arriving, so re-handing it would take the caret off the file in the tree or the
terminal tab that was actually clicked. Measured at 1100px with 713px tiles:
clipped on the right 0 -> 363 and whole, clipped on the left 363 -> 0 and whole,
already whole 363 -> 363, and `activeElement` the clicked terminal's own
textarea throughout.

**A window that grows means it too.** Opening a panel is a reveal already;
opening something *inside* one was not, and it is the same action a level down
— the files panel is one unit while it is only its tree and three once a file,
a diff or a commit is open in it, so a click inside a pane that is fully on
screen can take its tile from three units to five and push its own right-hand
half off the edge. So the row remembers each cell's span between renders and
reveals one that **grew**, through the same two functions as everything else.

Three things about it are deliberate, and each is a way of not moving the row
when nobody asked. **Growth, not size**: a tile that shrinks — you closed the
file — has nothing hidden left to show, and scrolling then would take the window
you were reading out from under you. **A new cell is not growth**, since waking
a worktree and making one each scroll to it themselves and a tile arriving
mid-row must not drag the row to wherever it landed. And **not across a
resize**, which is the other thing that changes a span: capacity moves with the
window, so a tile can gain a unit with nothing opened, and the row is already
putting itself back by spot (`unitRef`) — two effects scrolling one row in one
commit is one of them losing.

Measured at 2400px, where the row is six units of 341px: with the files panel
open on a tile at 1377–2388 (three units, whole on screen), opening README.md
took it to 1694px wide and 665px of it past the right edge, and the row stepped
two units, 682 -> 1365, leaving the tile at 694–2388 and whole. Closing the file
again left the row at 1365, and re-opening it from there — where the grown tile
still fits — also left it at 1365. Across 2400 -> 2800 -> 1500 -> 2400 the row
kept its spot and came back to 1365 exactly, as it did before this existed.

`measureMonoCharWidth` is **floored** on purpose. xterm rasterises glyphs into
an atlas and blits per cell, so a cell is a whole number of pixels: canvas says
8.429px where xterm lays out 8. This value now decides how many tiles the window
divides into, and 5% of slack costs a whole tile in some width bands.
`PANE_CHROME_WIDTH` tracks `.tile__pane`'s padding — change one, change both.

**How many windows fit is decided by `TERMINAL_FONT_SIZE`, and it is settled at
14.** It works through the floored cell, not the type size, so it moves in
plateaus: 12 and 13 lay out a 7px cell, 14 lays out 8, 15 and 16 lay out 9 —
eighty columns is 560px against 640 against 720, which is most of a tile. 13 was
tried on a 1920 screen and reverted: it fits a third window at 84 columns, and
reads too small for a row of agents you watch all day. **Do not reach for it
again** to fit another window in. The other two candidates cannot reach it
either, which is worth knowing before measuring it a second time:
`PANE_CHROME_WIDTH` is 18px of the 658 a pane needs, so zeroing the padding
outright still leaves 1920px at five units, and doing it on columns means
`MIN_PANE_COLUMNS` at 75 — the one promise this layout exists to keep.

## Terminals mount lazily, and that is not optional

Each pane's `TerminalView` is `primary`, which loads a `WebglAddon`. A browser
grants a page around **sixteen WebGL contexts** before it starts revoking them,
and twelve awake worktrees would also run twelve render loops over twelve
5000-line scrollbacks nobody is looking at. So `useNearViewport` gates the mount
and the tile renders its terminal ground otherwise. The bar, name, state and
toggles are always present — nothing leaves the row.

This is only safe because the server serialises its mirror on attach: a
remounted terminal paints exactly what it would have shown, and with nothing
attached the pty's geometry is left alone.

## The files pane

A search box sits at the foot of the sidebar in all three modes, filtering
whichever list is showing. It is under what it filters, for the reason the todo
form is: the sidebar reads top to bottom as the list you are looking for, and
the box is the line under it rather than a lid on top of it -- so the key into
the results is ArrowUp, while Enter still means the first hit, which is the best
match rather than the nearest row. Changes and Commits filter in place, because they already hold their
whole list. **Files asks the server**, because the tree only holds what you
expanded and the file worth searching for is the one you have not walked to:
`GET /api/worktrees/:id/find` runs `git ls-files --cached --others
--exclude-standard`, which inherits the same ignore rules `check-ignore` does
and never lists `.git`, so the finder and the tree can never disagree about what
is hidden.

**Hits are drawn as a tree**, with the directories between them put back in
(`hitRows`) -- a flat list with each hit's directory in small type under its
name was a second way of drawing what the tree already draws, and it read as a
different panel rather than the same one filtered. The two kinds of hit answer
different clicks: a **file** opens and leaves the query up, since looking at one
hit is rarely looking at the last, and opening it expands its ancestors so
clearing the box leaves the tree already on it. A **directory** does the
opposite -- it drops the query and unfolds itself in the tree, which is the only
thing picking a place rather than a file can mean. `expandDir` is a separate
action from `toggleDir` for that: two `toggleDir` calls in one render read the
same `uiRef` and the second drops the first, so the ancestors have to be opened
in one write. Enter from the box takes the first *file* rather than the first
row, which in a tree is usually a directory on the way to something.

**The content pane comes and goes.** The panel opens as its list alone and grows
a second column only once you pick something, which is where the one-unit width
above comes from. Each mode says "something is open" differently, and
`contentOpen` in the pane and `filesContentOpen` in the row must give the same
answer or the tile is laid out for a column it does not render:

- **Files keeps tabs**, `ui.openFilesByWorktree`, in the worktree's bar above the
  editor and wearing the terminal strip's own classes — it is the same object, a
  row of things one pane can show with one of them lit, and a second look would
  say it was a different one. Opening a file adds one; closing the last takes the
  editor with it. Closing the showing tab moves to the one on its right, falling
  back to the left, which is what every tab strip does.
- **Changes and Commits keep no list.** You open one thing and click it again to
  put it away, or use the `»` at the right of the bar, which is the same action
  with a name. A diff is not something you collect the way you collect the files
  you are working in.

**Not text, but the browser can draw it: draw it.** A `.png` picked in the tree
opens as a picture rather than as the note saying it is not a text file. The
server decides from the extension and before it reads a byte (`MEDIA_TYPES` in
`server/src/files.ts`), answering `binary: true` with a `media` type; the bytes
never travel as JSON, because an `<img src>` is exactly a GET the browser makes
on its own -- `GET /api/worktrees/:id/raw`, whose URL carries the file's rev, so
an image the agent regenerates is a *different* URL and repaints on the next
poll instead of showing what the browser still has. That decision has to come
**before** the size cap, which is a cap on text going through JSON and has
nothing to say about a photograph: with the cap first, every image over 2MB
answered "too large to open here". It is scaled down to the pane and never up --
measured, a 1600x1200 png drawn at 652x489 and a 16px favicon at 16px -- and the
line under it carries the real dimensions and the file size, which is the one
thing a scaled picture cannot say for itself. `.svg` is deliberately not in the
table: it is text, it decodes, and editing it is the reason to open it.

Nothing auto-selects any more. The commit list used to choose its newest for you,
which was free when the pane was always there and is not now: it would open the
second column on arrival and the narrow panel could never be seen. The other half
of that is `useChangesState`'s stale check — an amend or a rebase leaves the
selection naming nothing, and it closes the pane rather than showing an empty
one. Verified by rewriting a commit under an open panel in a scratch repo: the
selection cleared and the tile went 1776px back to 1061px.

The commit selection therefore lives in `Overview`, not in `useChangesState`: it
decides how wide the tile is, and only the row lays out the row. It is still not
persisted, for the reason it never was.

One panel with three faces -- **Changes**, **Commits**, **Files** -- switched
from the top of its own sidebar. It was two panels, files and a git panel beside
it; they answered questions about the same objects, kept two selections that
drifted apart, and together cost a fifth column of the tile. The sidebar list was
Finder's Miller columns first, on the argument that a pane eighty characters wide
cannot afford to spend width on indentation -- that turned out to be the wrong
trade in use, so it is a tree.

Six things in it are load-bearing:

- **One selection, `ui.openPathByWorktree`, serves all three modes.** Pick a
  changed file and its diff opens; switch to Files and the editor opens that same
  file, ancestors already expanded. That is most of the reason the two panels
  became one. `untracked` and `from` are looked up from `changes.uncommitted` by
  path when the diff is asked for, never stored, so there is no second copy to go
  stale.
- **At most one hook polls.** `useChangesState` is enabled outside Files mode and
  `useFilesState` inside it, so an open panel reads what you are looking at
  rather than everything it could show. **`enabled` is in the dependency array of
  every fetch effect and must stay there**: that is what makes switching back
  re-read within a render instead of showing the last poll's answer for three
  more seconds.
- **Save is in the bar in every mode, whenever there are unsaved edits.** The
  buffer lives in the hook, which stays mounted across a switch, so scoping Save
  to Files mode would keep an edit while removing every way to save it.
- **The changed list folds single-child directory chains** (`web/src` as one
  row). Its directory rows are inert labels, not buttons: everything there is
  expanded already and the server has no diff of a directory. Only files are
  selectable.

- **`.files__file` is a flex column, and that is not cosmetic.** CodeMirror's
  host is sized by `flex: 1; min-height: 0` from it. A block container instead
  left the host at its *content's* height -- an 11,792px editor inside a 225px
  pane, measured. `.cm-scroller` then has nothing to scroll, so the file would
  not scroll at all. (It used to have a second symptom: the row took every
  downward wheel a pane did not want, so scrolling a file slid the windows
  sideways. The row no longer answers to a downward wheel at all -- see below --
  but the flex column is still what makes the file scroll.)
- **The tree must stay a scroller** (`overflow-y: auto`), which is what lets a
  wheel over it scroll the tree rather than falling through to nothing.
- **The error notice is in the sidebar, not in the content pane.** A tree that
  failed to read has no content pane to say so in. The *conflict* notice stays
  beside the file, because it can only happen while one is open.
- **The draft lives in a ref, and only a boolean reaches state.** The editor is
  uncontrolled: it is handed the file as it is on disk and reports its buffer
  back, never the reverse. If the buffer were state, every keystroke would
  re-render the tile -- and the tile holds two live terminals. It also makes
  "unsaved" mean *differs from disk*, so undoing back to the file's own text
  clears it for free.
- **Following a file keeps your place by the line's text, not its offset.**
  Trimming the common prefix and suffix is enough while a change is one
  contiguous region, but an agent that adds an import at the top *and* a
  function at the bottom produces one region spanning the whole file -- and
  CodeMirror maps a position inside a replaced range to the end of what replaced
  it. Measured: the cursor jumped from line 3 to line 1. So the line being read
  is remembered by its text and looked for again near its old number.

Moving in the tree is not opening, unlike a click: arrowing past twenty files
would otherwise read and render twenty of them, so Enter is the key that says
you meant it. Opening a file expands its ancestors, which is what makes a
restored path visible without the expansion having to be derived -- and leaves
collapsing an ancestor working normally, which a derived set would quietly undo.

`.tile__pane--files` has no padding, deliberately, so the divider between tree
and file runs the full height and meets the tile's border; the 8px inset comes
from each row and from the editor's gutter instead. `PANE_CHROME_WIDTH` still
describes the terminal panes, which are what set the minimum width -- the
mismatch is not a bug to fix.

## The mouse, and why it kept typing into agents

Three rules, each of which was a bug first.

**The encoding travels with the snapshot.** Claude asks for mouse tracking and
SGR encoding together (`?1003h ?1006h`). `SerializeAddon` restores nine modes
including the tracking mode, and cannot restore the encoding — xterm's public
`IModes` does not expose it. So a repainting client, which calls `term.reset()`
first, came back with tracking on and the encoding at xterm's default: the legacy
`ESC [ M` + three bytes form, which an SGR app cannot read. `TerminalMirror`
watches DECSET/DECRST for `1006`/`1016` and appends it to the snapshot itself.
A repaint with no resize behind it — a socket drop, which is what a deploy is —
is the window where this bit; a resize hid it, because the app redraws and
re-declares its own modes.

**Hovering is not input.** `buttons === 0` is stopped in the capture phase
before xterm sees it. Nothing in an agent's interface needs the pointer's
position, and in a row of windows the pointer crosses several agents on the way
anywhere. Clicks and drags still report — `pointerdown` claims the keyboard
before `mousedown`, so the pane is yours by the time the press is reported.

**The wheel never becomes keystrokes.** On the alternate screen with no tracking
mode, xterm.js translates a notch into an Up or Down arrow and sends it as
input; in Claude, Up recalls the last prompt. `attachCustomWheelEventHandler`
cancels exactly that, and nothing else: once a tracking mode is on, xterm binds
its own wheel listener that reports to the app without consulting the hook.

A legacy report is also refused on the way out, as a guard, because it cannot
survive this transport: a byte above 127 (any column past 95) is a latin-1 code
unit in a JSON string, node-pty re-encodes it as two UTF-8 bytes, and tmux then
consumes the wrong three bytes and passes the rest on as text — measured as a
bare `9999...8888` arriving in a prompt.

## On a phone

Two things the desktop never exercises, both measured:

**The keyboard must shrink the app, not cover it.** `height: 100%` means the
window, and the on-screen keyboard is drawn over that, so the terminal and its
input end up underneath it. `interactive-widget=resizes-content` in the viewport
meta asks the browser to resize the page instead — Chrome honours it, Safari
does not — so `trackViewport()` mirrors `visualViewport.height` and `offsetTop`
into `--app-height` / `--app-offset` and `#root` is fixed to those. The offset
is not decoration: iOS scrolls the layout viewport to keep the caret in view
rather than resizing anything, and without it the app is the right height in the
wrong place.

**A finger dragged up or down scrolls the app.** There is no wheel and no Page
Up key, and on the alternate screen there is no scrollback for the browser to
move — the app owns its history. Claude scrolls on Page Up / Page Down, so a
vertical drag on a terminal sends those; horizontal drags are left to the row.
`.term-host` carries `touch-action: pan-x` so the browser hands over the
vertical axis instead of claiming it for a pan that has nowhere to go.

**The drag sends whichever of the two the app is listening for.** An app with a
tracking mode on is one xterm reports the wheel to — that is how the same
transcript is scrolled on a desktop — so a finger sends the same report,
`ESC [ < 64` and `65` in SGR, **one notch per line of finger travel**
(`host.clientHeight / term.rows`, floored at 8px). SGR without asking, because
every app in this stack sets `?1006h`; the guard on `send` refuses the legacy
form outright, so a report built wrong here cannot reach an agent. An app that
answers no mouse report — a plain shell — keeps Page Up and Page Down at an
eighth of the pane's height.

Paging was the whole gesture, and it was too coarse in both directions at once:
Page Up moves a *screen*, so the smallest move available was the largest move
there is, and it cost 85px of dragging to get it. (It cost 341px before that,
half the pane's height, which was more than a comfortable drag — a 300px pull
sent **nothing at all** and the gesture read as broken. That number is where the
eighth came from, and it survives as the shell's step.)

Measured on a 400×800 phone, a 682px terminal at 40 rows — 17px a notch — with
`vim -c 'set mouse=a' -c 'set ttymouse=sgr'` as the stand-in for an app that
takes the mouse: a 300px push sent 18 notches and vim scrolled 54 lines, three
a notch, reading 19 → 73 in one gesture; 100px sent 6; the same drag pulled back
sent 18 the other way. On a plain shell's pane the identical 300px drag sent
**3 Page Ups and no notches**, which is the old behaviour kept where it is the
only one available.

A burst is capped at twenty reports per move event, and the remainder dropped
rather than carried: the step is small enough now that a finger that *jumps* —
a touch reordered, a pane resized mid-drag — would otherwise spend the distance
as a flood of reports at an agent, and paying it out later would scroll for a
gesture that had already finished.

Measure it by counting what goes down the socket, not by looking: the payload
is JSON, so an escape is the six characters `\u001b[5~` and a regex for a raw
ESC byte matches nothing. Wrap `WebSocket.prototype.send`, then drive the drag
with CDP `Input.dispatchTouchEvent` — `Input.synthesizeScrollGesture` moved
neither the row nor the terminal in headless Chromium, and a `page.mouse.wheel`
over a terminal is eaten by xterm's own handler before the row sees it.

This is not the wheel rule in reverse. Turning the wheel into keystrokes was
wrong because the wheel is how you scroll what is under the pointer; a finger
inside a pane has no other meaning.

**Scrolling down never moves the row.** It used to: a terminal on the alternate
screen has nothing of its own to scroll, so a downward wheel over most of a
window would otherwise do nothing, and the row was offered the gesture instead.
That loses to what it costs -- reading down a diff and running off its end threw
the row sideways, and so did a stray graze over a terminal. Only a *sideways*
gesture moves the row, a pane at a time because `scroll-snap-type: x mandatory`
drags anything shorter back (measured: a 120px nudge snapped to where it
started, a 600px flick landed a spot along). Anything with sideways scrolling
of its own keeps first claim through `inner()` -- measured on a tile's terminal
tab strip, which took 8px of the gesture and left the row at 0, then handed the
next one on once it was at its end.

## Cmd+Left and Cmd+Right walk panes, not only worktrees

They step through the worktrees from wherever the caret is — a terminal, a
todo's prompt, the editor in the files panel. The only thing that keeps the key
is a dialog, which is modal: stepping the windows behind a scrim would act on
something nobody asked about.

The handler listens in the **capture** phase and calls `stopPropagation`, which
is what makes that true. A text field and CodeMirror both handle the key at the
target, before a listener on the document would see it, so without capturing you
get both: the caret jumps to the start of the line *and* the row steps. Cmd+Left
as "start of line" is the price; Home still does it.

## Cmd+I, Cmd+O and Cmd+F are the three panel toggles

The keyboard version of the buttons in a window's own bar, acting on the
worktree that has the keyboard, and toggling the same way: pressed on the panel
already showing, the shortcut closes it and gives the width back to Claude.
Mnemonics rather than positions -- each key is a letter inside the word its
toggle already shows.

**Terminals are on their third letter.** T is what the word wants, and the
browser will not give up Cmd+T. E was next, and was wrong for a reason no
amount of `preventDefault` reaches: Claude's own browser extension takes Cmd+E
before the page sees it. A key another tool holds is a key that does nothing
here, so the terminals moved to the next free letter in TERMINAL.

**Cmd, never Ctrl**, and Cmd+I is the sharpest case for it: Ctrl+I *is* Tab,
the same byte 0x09, so binding it would have taken completion away from every
shell and every prompt in the row. Ctrl+E is end-of-line and Ctrl+F
forward-character for the same reason, and both are typed in these windows all
day. Cmd itself costs the terminal nothing: xterm.js emits a printable key only
when `!ctrlKey && !altKey && !metaKey`, and this build has no kitty-protocol or
`modifyOtherKeys` encoding to fall back on, so a Cmd-modified key produces no
bytes at all -- measured with `cat` as the stand-in agent, where a plain `x`
arrived and Cmd+X, reaching xterm's own textarea, left the pane unchanged. tmux
is not in the argument either: `tmux.conf` sets `prefix None` and
`unbind-key -a`, so it binds nothing and every byte passes through.

The browser claims all three on macOS -- find, open a file, and Safari's "use
selection for find" -- and, unlike Cmd+N, Cmd+T and Cmd+W, it lets all three be
cancelled. So they are taken outright in the capture phase, which is also what
keeps them from reaching xterm: its `attachCustomKeyEventHandler` runs at the
target and, as the comment in `TerminalView` says, returning false from it does
not stop a browser default. Measured against a scratch instance: the letter pressed
with a terminal focused arrived with `defaultPrevented`, never reached a
bubble-phase listener, and put no character into the shell's prompt
(`capture-pane`); in a dialog the same key is not prevented at all.

## Holding Cmd draws the legend

The shortcuts are only worth having if you can find them, and a printed list of
five is a list nobody reads. So holding Cmd is treated as the question "what can
I do from here", and the answer is written on the controls themselves: each
panel toggle **of the window you are in** lights its letter -- TERM**I**NAL,
T**O**DO, **F**ILES -- and the two windows a Cmd+arrow step would land in show
that arrow in front of their name. The letters are one window's because the
shortcut is: it opens a panel on the worktree that has the keyboard, and the
same three letters lit across the row would promise something the key does not
do. The arrows are the opposite case -- they are about arriving somewhere else,
so they are drawn where you would arrive. Nothing is armed by it; the keys work whether the legend is on screen or
not.

It is greyscale, and that is the colour rule rather than an accident: amber and
green are the two states you scan a row of agents for, and where a key would
take you is not one of them. The letter is `--bone` and the word around it steps
down to `--graphite` while Cmd is held -- the 1.92:1 step the interface already
puts between a title and its metadata. **The word is dimmed rather than the
letter merely brightened** because of the toggle whose panel is open: its label
is already `--bone`, so a `--bone` letter in it would be no letter at all.
Dimming is one rule that works open, hovered and plain, and the toggle keeps its
underline throughout, which is what says which panel is on screen.

`useMetaHeld` reads released from any key event reporting no Cmd, plus the
window's `blur` -- Cmd+Tab away delivers its keyup to the application you
switched to, which would otherwise leave the legend lit over a page nobody is
typing into.

The landing panes come from `active`, not from the DOM, which is the opposite of
what the stepper does and right for the opposite reason: the stepper answers
between two renders, where React's record can be a press behind, while this is
rendered, and `active` is also the only one of the two whose change re-renders
the row -- which is what makes the legend follow you as you walk.

**A legend must not move what it annotates.** Two things were measured here.
The arrow is absolutely positioned in the title's own 10px left padding, so no
name shifts when Cmd goes down (`getBoundingClientRect` identical to 0.01px with
and without). And the lit letter is wrapped so the label stays **one element**:
`.tile__toggle` is a flex row with a 4px gap for the fork glyph, so splitting
"TERMINAL" into three text nodes made three flex items and put two of those gaps
inside the word -- the button grew from 86.98px to 95 the moment Cmd went down.
Wrapped, it is 86.98 to 87.00. Weight is not used either, for the same reason.

## Every dialog cancels on Escape, and gives the keyboard back

`useEscape` is one hook per dialog, on the **window** in the capture phase with
`stopPropagation` — the same reason the stepper capture: a text field and
CodeMirror both handle Escape at the target, and the row's listeners are on the
document, so cancelling a dialog must not also abandon an edit in the pane
behind it. It only exists while a dialog is mounted, so Escape means whatever it
meant before everywhere else.

Closing one returns focus **to the pane you were in**, not to the element that
had focus when it opened: a click focuses the button it lands on, so that
element is the tab's × or the project's +, and restoring it would leave the
caret in the top bar with nothing to type into. `active` is the honest record —
it is written from focus moves inside the row, and the top bar is not part of
the row — so `App`'s `refocus()` reveals that pane again, which also brings a
window that had scrolled off the side back with the keyboard.

A removal has no pane to go back to, so it moves you on: the worktree after the
one that went, or the one before it when it was the last -- where the eye
already is, and where a Cmd+arrow step from the gap would have taken you. Read
off the row as it still stands, before the refresh drops the worktree, which is
why it can be answered at all.

**Within its own project.** The row is every project's windows in a line, so
"the next one" across the whole row is the first window of the *next project*
whenever you remove a project's last worktree — somebody else's work, and
nowhere you asked to be. With nothing awake left beside it, that project's own
pane takes the keyboard instead: it is the head of the run and it is there
whether or not anything else is, which makes it the one landing spot a removal
can always promise, and it is where you go to make the next worktree, which is
often why the last one went. The close-project path already lands this way — it
moves to the pane of the project left standing — so the two now agree. The rule
is `removalLanding` in `selectors.ts` rather than a closure in `App`, which is
what lets a test hold it: two of its four cases are the flat row's answers
written down as the wrong ones.

## The todo panel holds no state of its own

`TodoPane` fetches nothing and caches nothing: todos ride `AppSnapshot`, and
every mutation makes the server broadcast an invalidate, which refetches it.
`useChangesState` exists because git is polled and expensive;
copying that shape here would only add a second copy of the truth.

The one piece of local state is the row's **draft**, and it is load-bearing: a
field bound straight to the snapshot loses keystrokes whenever any unrelated
mutation in the app refreshes it mid-sentence. The draft holds until the server
echoes back exactly what was sent. Verified by typing into a prompt while a
`curl` created a todo on another worktree — the keystrokes and the caret survive.

**The three things you can do to a todo are the tab strip's object, stood on
end.** RUN NEXT, MOVE TO and DELETE as square segments inside one rounded shell,
seamed 2px in `--sleeve` -- `.tabgroup`'s own argument, that round pills are each
their own object while square segments inside one shell are one object divided,
and the shell holds every outer edge. They were a pill, a bare × beside it and a
quiet word underneath, then three stacked pills; a column of pills is still a
column of separate objects, and none of it had anything to do with the strip
above it.

Three details carry it. Labels are **left-aligned on the tab's own 13px leading
inset** rather than centred, so the three read down one edge and a mark could
appear down a segment's leading edge later without moving a label; the queue
position sits at the far edge with the caret for the same reason, since a number
that appears and disappears must not push its own label along. The caret is the
zZ tab's, **17px** -- it is the one mark that says a control opens a list rather
than acting on the spot, so it is the same mark in both places, and at 9px it was
a speck beside an 11px label. And the column is `min-width: 118px` rather than a
fixed width: every row comes out at 118 because no label reaches it, and a wider
font grows the slab instead of clipping a label.

Weight, not colour, still separates them -- amber means Claude is blocked on you
and green that it has come to rest, and none of the three is either -- so queued
is RUN NEXT filled in reverse, `--ink` on `--bone` at 14.46:1, which is the
loudest thing the panel can say and is spent here because a queue marker has to
be findable across a row of windows. **DELETE is the one segment that does not
lift on hover**, and that is measured rather than an oversight: `--danger` is
4.88:1 on `--level-object` and 4.14:1 on `--level-hover`, so lifting it would
cost either a second red or the colour on the only control here that destroys
something.

**The slab is exactly as tall as its three segments and stops there.** Beside a
prompt of several lines it ends well above the foot of its own row, and the space
under it is the panel. It was tried the other way -- stretched to the row, with
an empty segment taking up the slack so the slab met the bottom the way the strip
meets its bar -- and an empty segment under DELETE reads as a fourth thing you
can do to a todo, drawn and doing nothing. Measured: the slab is 72px against
prompts of 25px and 100px alike.

MOVE TO's list is `useAnchoredMenu` and `WorktreeTab`, exactly the zZ dropdown,
and it hangs off the segment's own bottom-left corner.

**Its list is this project's worktrees and no others.** A todo is work on a
repository, and another repository's worktrees are not somewhere it could be
done -- offering every worktree the IDE knows made the list longer with the
answers you would never pick, and made it need a heading per project to tell two
`main`s apart. Scoped, the headings go with it: every row belongs to the project
the todo is already in, so there is nothing for a label to disambiguate. `App`
builds the targets per project id and a tile takes its own; a project with one
worktree leaves the list empty and MOVE TO does not draw.

**A moved todo is not a sent one.** From this pane a queued todo leaving looks
identical whether the server typed it into Claude or you moved it elsewhere, and
the panel closes on the first. So a move is reported to `leftHere` the way a
delete is -- measured, moving the last queued todo away took the panel with it
and handed the keyboard to a Claude that had been sent nothing. Moving it keeps
it queued, and the server gives it a fresh place at the end of the queue it
joins: a place in a queue is only meaningful within one worktree.

The **form is at the foot of the panel**, under the queue: the list reads top to
bottom in the order it will go and the box you type into is the next line of it,
rather than sitting above its own output.

And when the **last todo** has gone to Claude the panel closes and **Claude
takes the keyboard** — the queue was typed into that agent, so that is where you
are about to be looking, and the alternative is a closing panel dropping focus
on the document. The last *todo*, not merely the last one queued: an empty queue
closed the panel with four todos still written down, in the middle of lining
them up. Two other ways of emptying it still close nothing — taking a todo out
of the queue leaves it in the list, and deleting one by hand is a click that
says you are still working in here.

## UI state

`ui` lives on the server but **belongs to the client**: it is adopted on first
load only, which is why two open tabs drift apart. That is deliberate — it fixed
a bug where a debounced write raced a refresh. Writes are debounced 200ms and
fire-and-forget, so a change made immediately before a reload can be lost. Do
not "fix" the divergence without reading why it is there.

`awake: null` means first run, not "none awake": it seeds from worktrees that
already have live sessions, so sleep arriving on a busy machine is invisible.
`scrollTo` carries a **nonce**, because asking twice for the same worktree is two
requests — opening a second panel on the tile you are already looking at changes
its width, and a bare id compares equal and scrolls nowhere.

## Motion

`--motion: 140ms`, and entry/exit are **keyframe animations, not transitions**.
React unmounts a departing node before a keep-alive effect can run, so the node
that animates out is newly created and has no previous width for a transition to
interpolate from. `tileMotion.ts` re-inserts a leaver at its remembered index for
the same reason — a moved node restarts its animation.

## Style

Two custom properties, one job each: `--font-mono` for the terminal, patch
lines, hashes, and paths — anything read character by character — and
`--font-ui` for everything the interface says in its own voice. `--signal`
(amber) means one thing only: Claude is blocked on you, and `--done` (green)
one thing only: Claude is running and has come to rest. A worktree with nothing
running has finished nothing, so it stays grey. The exceptions are a diff's
green and red and a file's syntax colour, both because they are content rather
than chrome. The `--code-*` palette is the terminal's own with its green left
out, so nothing in a source file can be mistaken for `--done` at a glance; the
editor's chrome lives in `editor/theme.ts` and not in this stylesheet, because
CodeMirror injects its own rules at a specificity a plain class rule can lose
to.

Every text colour clears 4.5:1 on every ground it lands on, including
`--level-raised`; the three greys are a ladder (13.4 : 7.0 : 5.2). Class names
describe the interface's parts (`.tile`, `.chip`, `.grid__spot`); user-visible
text never does — it says worktree, window, terminal, Claude.

The stops are **panes**: `… wt1 Claude → wt1 panel → wt2 Claude → …`, built by
flat-mapping each cell's `panes`. A worktree with nothing open contributes one
stop, one with a panel two, and a window too narrow to hold Claude one again —
all of it falls out of `panesOf` with no special case. **Scrolling stays at tile
granularity**: `panesOf` guarantees no tile is wider than the window, so
bringing the tile on screen brings the pane with it, and `wholeOnScreen` /
`nearestOffset` keep working on cells.

Arriving focuses what you would type into, through the same `number | null`
nonce `TerminalView` has always taken — Claude's terminal, the active terminal,
the new-todo box, or the files panel's editor. **Opening a panel is arriving**,
and at that panel rather than at the worktree: a click on Todo is a click on the
box you were about to type a prompt into, and it would be a strange one that
handed the keyboard to Claude instead. Closing gives it back to Claude, because
the pane that had it no longer exists. `FilesPane` decides between the
editor and its search box from **`files.path`**, which is UI state and true this
instant, not from `files.file`, which is a fetch result: keying it on the fetch
lets the search box take the keyboard, you start typing, and the editor mount a
beat later and take it back mid-word. A pane that refuses focus — a binary file,
a Claude that is not running — traps nobody, because the stepper listens on the
document and the next step still works.

`onActivate` reports the **pane**, read off the nearest `data-pane`, which both
the bar segments and the pane bodies carry — so a terminal tab reports
`terminals` and Save in the files bar reports `files`. `App`'s `activate` bails
when the pair is unchanged, and that is not a nicety: `activeId` was a string, so
rewriting it was free, while an object is not, and this now fires on every focus
move *within* a pane.

**`--level-object` is deliberately quiet.** It was `#2b3341` for a day and read
too bright across four places at once. At `#222833` it is 1.32:1 against the bar
behind the strip and 1.28:1 against the terminal under a window's bar — enough
to be a shape, and no more — while the step up to `--level-lit` *grew* from
1.33:1 to **1.55**, so the thing you are in stands out more, not less. Toning it
down also undid both things the brighter value had forced: `--graphite-dim`
clears it again at 4.53 so a window bar's metadata went back to it, and
`--danger` clears at 4.88 so the red went back to `#e5707a`. The seam moved with
it — see `--sleeve`, which is the frame now, because at `--level-raised` the
darker segments closed the seams to 1.10:1.

**One surface means "not this one", everywhere.** `--level-object` is the fill
of an inactive tab, of the project's head, of `＋ Worktree`, and of every window
bar that is not the one you are in. `--level-lit` is the exception in all four
places. The value in between that these were reaching for does not exist: going
darker than `--level-object` costs the 2px seam (1.24:1 → 1.08 at `#222936`) and
puts `--graphite-dim` under the floor on the bars (4.47), while making the head
read *worse* against the bar, which was the complaint that started it.

Note what it costs: the bar that says which window you are in went from 1.79:1
over the others to **1.33:1** — the same step the strip uses between a resting
tab and the lit one. It is legible because the tab directly above it says the
same thing.

**The window you are in says so at both ends.** The strip makes its tab the lit
one; `.tile--current` gives that window's own bar the **same** `--level-lit`,
1.79:1 above every other bar — not a rung near it, the identical surface, which
is what makes the tab and the bar one sentence rather than two. It drifted
twice: the tab went up for the strip's redesign and this stayed, then the ladder
moved it again, and the gap grew 1.07 → 1.24 → 1.33 while this paragraph went on
promising they matched.

**The three panel names are white, and one white rule says which is open.**
`TERMINAL`, `TODO` and `FILES` all read `--bone` — 11.59:1 on a quiet bar,
7.48 on the lit one — and `.tile__toggle--on` carries a 2px `--bone` underline.
It used to be the other way round: brightness said which panel was on screen
and the underline agreed underneath, except that underline was `--rule-bright`
at **1.25:1** and **1.24:1**, so it said nothing and the label carried it alone.
Moving the job to the line is what let the labels become equally legible.

That also gave the lit bar its hover back. It could not fill on hover while its
labels were `--quiet-on`, because a lift big enough to see put them on 4.11:1 —
so the pointer was said by the label brightening instead. White labels spend
that trick, but `--bone` survives a lift where the grey did not, so the fill
returns as `--level-lift`, a 10% wash of `--bone` over the lit surface: 1.28:1
over it, label still at 5.83.

Wearing the lit surface across a whole **toolbar** costs more than wearing it
across a tab, and that cost is the interesting part. `--graphite` is 3.90:1 on it
and `--graphite-dim` 2.92, so every quiet thing in that bar — project, slash,
branch, prompt, and the panel toggles — is `--quiet-on` (4.89), while `--bone`,
which the worktree's own name is in, needs nothing at 7.48. **Nothing fills on
hover there**, because there is nothing above lit to fill with: a lift big enough
to see (6% white, 1.19:1) puts `--quiet-on` back under the floor at 4.11, so the
pointer is said by the label going `--bone`, which survives any lift. `--danger`
would have been the one colour with no lighter rung to reach for, at 3.15:1 — it
turned out not to be needed, because the only red in that bar was `.tile__remove`
and nothing has rendered that since the trashcan moved into the sleep dialog. Its border is not touched: on a black page a darker edge has nothing
to be darker than, and a lighter one reads as a focus ring drawn over the
ground. It is driven by `active`, not by `scrollTo`: where you *are*, which
clicking into a window sets without the row moving, rather than where you last
navigated.

Watch selector specificity in `styles.css`: an element-scoped rule and a
class-scoped rule for the same padding cancel each other in ways that only show
up as a section that is subtly wrong.

## It installs as an app, and has no service worker

`web/public/` holds the manifest and the icons; Vite copies that directory into
`dist/` verbatim, and the server serves it with no route of its own.

**There is no service worker, and none is needed -- including for the address-bar
install.** One was added on the strength of Chrome's own installability post,
which says the ⋮ menu stopped requiring a fetch handler in desktop 112 but that
"the install prompt algorithm still requires" one. That post also says it was an
area Chrome was working to change, and by Chrome 149 it had: the app installs
from the address bar with nothing registered, observed directly. Treat the
requirement as gone and do not re-add a worker to chase it.

The worker was never what was broken. The manifest was fetched with credentials
omitted and came back 401 through the proxy, so there was no manifest and
therefore no install by any route -- see the `crossorigin` attribute on the link
in `index.html`, which is the whole fix.

Removing one, if it ever comes back, takes more than deleting the file. A
registered worker outlives its script, and `/sw.js` falls through to the SPA
handler, which answers `index.html` with a 200 -- so a browser's update check
gets HTML where it wanted JavaScript, fails, and goes on running the worker it
already has, indefinitely. `main.tsx` carried an unregister for exactly that
reason while the one this app briefly shipped was being cleared, and lost it
once every client had loaded the app again. Anyone withdrawing a worker needs
to ship that block, not just the deletion.

If a worker is ever wanted back, the constraint that made the last one safe
still holds: it must never cache the app. This IDE deploys by rebuilding
`web/dist` and restarting, and "a web change reaches them on reload" is the
promise resting on it -- a worker holding the app shell breaks that silently,
serving yesterday's JavaScript to someone who reloaded and would swear they had.

The manifest is JSON and cannot explain itself, so:

- **`id: "/"`** is the app's stable identity. Without it `id` defaults to
  `start_url`, and changing `start_url` later would install a *second* app rather
  than update the first.
- **`launch_handler: focus-existing`** is the one field doing real work. A second
  viewer competes for terminal geometry and a second client drifts apart from the
  first, since `ui` is adopted only on first load. This makes launching the
  installed app twice focus the window that is already open. It governs OS-level
  launches only — it cannot stop you opening a second browser tab by hand.
- **Two icon files, never `purpose: "any maskable"` on one.** The maskable drawing
  carries safe-zone padding and reads as a shrunken icon anywhere it is not
  masked. `icon.svg` brings its own rounded ground; `icon-maskable.svg` is square
  because the platform supplies the mask, and its grid is sized so a corner jack
  clears Chrome's 80% safe circle (1.414 × 110 + 36 = 191.6 against 204.8).
- Icons are generated by `scripts/icons.py` and **committed**. `pnpm build` must
  not need Python.

## Safe-area insets live on `#root`, and nowhere else

`viewport-fit=cover` was always in the viewport meta, but nothing read
`env(safe-area-inset-*)`, so an installed app on a phone ran under the notch and
the home indicator. The four insets are now padding on `#root`, which is the one
box every other measurement descends from. Two places they must *not* go:

- **Not in `--app-height`.** That is the visual viewport verbatim, it is what a
  pty's rows are derived from, and mixing device chrome into it would make the
  pinch-zoom bail in `trackViewport()` mean two things at once.
- **Not in `.grid`'s padding**, which looks like the obvious home for the left and
  right. That `12px` is mirrored by `GAP` in `Overview.tsx`, which places the spot
  markers and sets every tile's width; moving one without the other slides the
  markers off the tiles they mark.

`box-sizing: border-box` is what makes this free: the height stays the visible
viewport and the padding comes out of the content box.

They are funnelled through `--safe-*` custom properties rather than written
inline because **DevTools cannot simulate insets, even in device mode**. Setting
those four on `:root` from the console is the only way to see what a phone sees.
Measured that way: at 59px top and 34px bottom the bar moves to y=59 and keeps its
full 38px, the row ends 34px clear, `elementFromPoint` finds nothing at either
edge, and the terminals go 23 rows to 17 — the inset reaches the pty.

One thing is **known and unmeasured**: on iOS `env(safe-area-inset-bottom)` is a
device constant that does not drop to zero when the keyboard covers the home
indicator, so there is probably a ~34px dead band above the keyboard. Fixing it
means subtracting a keyboard height in `viewport.ts`, and that file is the most
delicate in the client — it should be done against a real phone, not guessed at
from a desktop.

## Verifying UI changes

Drive a real browser against `scripts/scratch.sh`, never the user's instance on
:8084, and close the tab when you finish — a second viewer competes for terminal
geometry. Then:

- **Ask `document.elementFromPoint()`.** Presence in the DOM is not visibility,
  and a programmatic click works fine on an element that is clipped away. The zZ
  dropdown was "verified" twice while `overflow` had eaten it — `overflow-x:
  auto` computes `overflow-y` to auto as well, so a scroller clips in both
  directions. The menu is gone and so is the `position: fixed` that rescued it,
  but the trap is the strip's, not the menu's: `.tabstrip` is still a scroller
  and `.tabgroup` is still `overflow: hidden`.
- **Sample pixels for hairlines.** A resampled screenshot blends a 1px divider
  out of existence; one was reported missing twice and was there both times.
- **Do not claim animation timing.** The headless clock races —
  `getAnimations()[0].currentTime` jumped 0→117ms in 10ms of wall time. Existence,
  duration and the interpolated property are checkable; timing is not.
- **Read `scrollLeft` late.** Reading it right after setting it returns a
  partly-applied value.
- **Prove the wheel with a real gesture**, `page.mouse.wheel` over the element,
  not by reasoning about `inner()`. Read `.grid`'s `scrollLeft` before and
  after, and remember the axes are not symmetric: a downward gesture must leave
  the row where it is, while a sideways one over a pane with nothing to scroll
  sideways steps it a spot.
- **Syntax colour is in generated class names.** `HighlightStyle` emits its own
  (`ͼ5`, `ͼ9`); there is no `.tok-keyword` to look for. Read the computed colour
  of a span inside `.cm-line` instead.
- **Terminal text is in a canvas.** `tmux -S <socket> capture-pane -p -t <name>`
  is how you read it, and how focus handover was confirmed. Synthetic
  `dispatchEvent` once passed while Shift+Enter was broken in the real browser.
- **A missing file is a 200, not a 404.** The server answers anything it cannot
  find with `index.html`, so a mistyped manifest or icon path comes back as HTML
  with a success code and fails later as a parse error. Check the *content type*
  and decode the bytes, and run a positive control against a path you know is
  absent to prove the check discriminates.
- **Safe-area insets cannot be simulated.** Device mode does not synthesise
  `env()`; override the `--safe-*` properties on `:root` instead.
