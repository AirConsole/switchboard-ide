# web

React, xterm.js, and plain CSS with custom properties. No component library, no
CSS framework, no state library — `store.ts` is a subscription over a plain
object, and that is enough.

```
App.tsx              projects -> groups -> the row; every dialog; UI state writes
store.ts / socket.ts the snapshot, and the one WebSocket
api.ts               REST calls, typed against shared/
components/TopBar    the tab strip: project groups, tabs, zZ dropdown, usage bars
views/Overview       the row: spot arithmetic, scrolling, what fits
views/TodoPane       a worktree's todos, and RUN NEXT
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
grow feet to run into it; these are **pills**, round at the bottom as well as
the top, floating in the sleeve with 3px of it under them. The feet went with
the ground they ran into: the page is black and the tab you are in is the lit
one, so there is nothing to be continuous with — and they cost a 12px overhang
across each neighbour's click target that needed `pointer-events: none` to be
safe, and a `z-index` on two states to paint in the right order. Both are gone;
every tab now owns its own width at its left edge, its centre and its right,
`elementFromPoint`-measured.

What is **not** copied is Chrome's colour. A tab group there picks a hue; here
the sleeve is grey, and the only colour on a tab is its state bullet: amber
blocked on you, green done, grey working, a hollow ring when nothing is running.
Identity is not what colour is for in this interface.

The pieces, and why each is the way it is:

- **A project is a tab group** — a `--sleeve` sleeve, flush with the bar's foot
  and inset 3px at the top, with the project's name in a pill. The pill *is* the
  project's mark, so there is no separate square any more, and it is `--rule`:
  a rung up from the trough it sits in, since a darker pill on a ground this
  dark is 1.15:1 and no pill at all.
- **The tab you are in is `--tab-on`**, the lightest thing on the strip and the
  only tab carrying a fill, 1.54:1 above the trough it floats in. The bar's
  bottom rule is still a background rather than a border, which is what let the
  active tab paint over it when it had feet.
- **Every tab carries a fill**, `--rule` at rest, 1.18:1 above the trough — a
  small step, as all of them are here, but the difference between a shape and no
  shape. They used to be the trough showing through, with only their label to
  say a tab was there. A 2px gap in the sleeve keeps two of them from reading as
  one shape with a seam, which is what retired Chrome's separator: a 1px mark
  hung off each tab's left edge and hidden either side of the active and hovered
  ones, three rules doing what a gap does.
- **Removal only asks what it has to.** `removalQuestions` reads the same two
  counts the tab shows: uncommitted work is what makes git refuse without
  `--force`, and unmerged commits are what make deleting the branch a decision.
  A clean worktree is not offered a "discard changes" box to rule out, a branch
  the default branch already has goes with the worktree rather than being put to
  a vote, and when neither is left to ask the removal dialog does not open at
  all — the sleep dialog's button drops its ellipsis and does it.
- **What is running is told, not asked.** `removalWarnings` covers what git
  knows nothing about: a Claude that is working or waiting on you, todos queued
  behind it, terminals still running. Each is one red line (`--danger`, the
  colour of the button they lead to; amber means an agent is blocked on you and
  nothing else), and none is a checkbox, because there is nothing to decide —
  they go whatever you answer. They are also what makes the dialog open for a
  worktree that is clean and merged: without them, a click removed an agent
  mid-turn with four todos behind it and asked nothing. Only a worktree that is
  clean, merged, running nothing and holding nothing goes without the dialog.
- **The + says what it does when it is the only one.** With one project open it
  is `+ New worktree`, because it is the only + on the bar and one project's
  tabs never fill the strip; with several, each sleeve carries its own and the
  label would be the same three words repeated across the bar, so they stay
  glyphs and the tooltip names the project.
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
- **The zZ dropdown is the same tabs, stacked.** A sleeping worktree is one of
  these tabs that happens not to be in the row, so it is drawn by the same
  `tab()`: the sleeve under it, the bullet, the zZ, the name and its marks, the
  hover panel — only fully round rather than square-shouldered, since nothing in
  a list stands on a floor. It used to invent a row of its own, with the state
  spelled out in words and the prompt on a second line, which made one worktree
  look like two different objects depending on where you met it; both facts are
  still there, on the bullet and in the title. The menu takes its width from its
  widest row up to 420px, where the strip caps a tab at 200: this is a list with
  one job, and a sleeper is the worktree you have least chance of recognising.
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
  black, the tabs are pills, and `--tab-on` (`#333c4b`) is simply the lit one —
  1.54:1 above `--sleeve`, the trough it floats in, and 1.66:1 above the bar,
  against 1.17:1 when the tab you were in was the dark one. It stops there
  because `--graphite` — what everything quiet on a tab is written in, and it
  lands on this ground on that tab — is 4.54:1 against it; one more rung is
  under the floor.
- **Hover lifts the fill a rung, and only the fill.** `--rule-bright` is 1.22:1
  above a resting tab, on the way to `--tab-on`, which is where a hover should
  point. The label deliberately stays `--graphite`: the tab you are in is only
  1.06:1 lighter than a hovered one, so lighting the label on hover too would
  leave nothing to tell them apart. Bright text is what "you are in this one"
  means, and it outranks an echo of the pointer.
- **Brightness says which tab you are in**, which is Chrome's other half of the
  job — its unselected titles are dim and its selected one is bright, and that
  difference does as much work as the tab's shape. Every tab here used to be
  `--bone`, so the *only* thing saying where you were was that 1.28:1 fill. The
  resting label is `--graphite` (6.98:1 on the sleeve) and the active tab's is
  `--bone` (8.71:1 on `--tab-on`): 1.92:1 between the two labels, against 1.0
  before. What that channel used to carry — awake or asleep — costs nothing to
  give up, since every tab in the strip is awake except the one that says
  "zZ 3" in words.
- **Contrast pins two more rules.** Everything quiet on a tab is `--graphite`,
  one value that clears the floor on all three of a tab's grounds (6.98 sleeve,
  5.89 hovered, 4.54 on the active tab, which is the light one and so the
  tightest). And the pill's × turns `--danger` with no ground under it: 4.77:1
  on the pill's own `--rule`, against 3.90 if the hover lit a `--rule-bright`
  ring behind it.

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

**The files panel is one unit while it is only its tree**, and the new-worktree
placeholder is one always. They are the two exceptions to "nothing may ask for
one unit", and both are chrome rather than something you read code in: the floor
of two exists to keep the 80-column promise, and that promise is about panes you
read *code* in — a terminal, a diff, the editor. The placeholder holds a +, a
label and a sentence, none of which is better for being 80 columns wide, and at
two it was a whole empty pane parked at the end of a row you scroll precisely
because there is never enough of it. A tree is chrome: names at a few levels of indent,
its own floor 158px, against a unit that measures 336px at 2400px and 403px on a
phone. So `panesOf` asks `filesContentOpen` before it asks `PANE_UNITS`, and a
worktree browsing its files is three units where one reading a file is five —
measured, 1011px and 1694px at 2400px. Two things fall out of that and must stay
true: a panel that asks for *less* than the floor cannot settle for less still
(`least` is `min(wants, 2, capacity)`, not `min(2, capacity)`), and a panel alone
on the window takes `capacity` rather than what it asked for, or a phone would
show a tree down one half of the screen and nothing down the other.

A panel asks and settles. Files wants three units but takes two rather than
cost you Claude's pane on a window with only four — a narrower editor beats no
agent — and only when even two will not fit is Claude dropped, which is the
phone rule.

Two consequences to preserve. **Every tile starts on a unit boundary**, so
scrolling to `unit * pitch` lands a tile flush at the left edge and no tile is
ever shown half-cut; the snap points are one out-of-flow `.grid__spot` marker
per unit. And **a tile wider than the window is collapsed, not squeezed**:
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

`measureMonoCharWidth` is **floored** on purpose. xterm rasterises glyphs into
an atlas and blits per cell, so a cell is a whole number of pixels: canvas says
8.429px where xterm lays out 8. This value now decides how many tiles the window
divides into, and 5% of slack costs a whole tile in some width bands.
`PANE_CHROME_WIDTH` tracks `.tile__pane`'s padding — change one, change both.

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
vertical drag on a terminal sends those, half a pane's worth of drag to the
page; horizontal drags are left to the row. `.term-host` carries
`touch-action: pan-x` so the browser hands over the vertical axis instead of
claiming it for a pan that has nowhere to go.

This is not the wheel rule in reverse. Turning the wheel into keystrokes was
wrong because the wheel is how you scroll what is under the pointer; a finger
inside a pane has no other meaning.

**Scrolling down never moves the row.** It used to: a terminal on the alternate
screen has nothing of its own to scroll, so a downward wheel over most of a
window would otherwise do nothing, and the row was offered the gesture instead.
That loses to what it costs -- reading down a diff and running off its end threw
the row sideways, and so did a stray graze over a terminal. Only a *sideways*
gesture moves the row, stepped by the spot because `scroll-snap-type: x
mandatory` drags anything shorter back (measured: a 120px nudge snapped to where
it started, a 600px flick landed a spot along). Anything with sideways scrolling
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
one that went, or the one before it when it was the last in the row -- where the
eye already is, and where a Cmd+arrow step from the gap would have taken you.
Read off the row as it still stands, before the refresh drops the worktree,
which is why it can be answered at all.

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
`--slab-raised`; the three greys are a ladder (13.4 : 7.0 : 5.2). Class names
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

**The window you are in says so at both ends.** The strip makes its tab the lit
one; `.tile--current` gives that window's own bar `--rule-bright`, 1.45:1 above
every other bar and one rung under `--tab-on`, so the tab and the bar read as
the same lit surface at the two ends of the same sentence. Everything quiet in
that bar goes up a rung with it — `--graphite-dim` is 3.62:1 on it, under the
floor, so the project, the branch and the prompt are `--graphite` there
(4.83:1). Its border is not touched: on a black page a darker edge has nothing
to be darker than, and a lighter one reads as a focus ring drawn over the
ground. It is driven by `active`, not by `scrollTo`: where you *are*, which
clicking into a window sets without the row moving, rather than where you last
navigated.

Watch selector specificity in `styles.css`: an element-scoped rule and a
class-scoped rule for the same padding cancel each other in ways that only show
up as a section that is subtly wrong.

## Verifying UI changes

Drive a real browser against `scripts/scratch.sh`, never the user's instance on
:8084, and close the tab when you finish — a second viewer competes for terminal
geometry. Then:

- **Ask `document.elementFromPoint()`.** Presence in the DOM is not visibility,
  and a programmatic click works fine on an element that is clipped away. A
  dropdown here was "verified" twice while `overflow` had eaten it — note that
  `overflow-x: auto` computes `overflow-y` to auto too, which is why the menu is
  `position: fixed` off the trigger's rect.
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
