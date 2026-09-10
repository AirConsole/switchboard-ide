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
the reference — `chrome/browser/ui/tabs/tab_style.cc` gives a 10px top radius,
a 12px bottom radius for the feet, and a 2px separator 16px tall — scaled into
the 38px bar.

What is **not** copied is Chrome's colour. A tab group there picks a hue; here
the sleeve is grey, and the only colour on a tab is its state bullet: amber
blocked on you, green done, grey working, a hollow ring when nothing is running.
Identity is not what colour is for in this interface.

The pieces, and why each is the way it is:

- **A project is a tab group** — a `--slab-raised` sleeve, flush with the bar's
  foot and inset 3px at the top, with the project's name in a filled pill. The
  pill *is* the project's mark, so there is no separate square any more.
- **The tab you are in is `--ink`**, the ground the row of windows sits on, with
  two masked pseudo-elements as feet. The bar's bottom rule is a background
  rather than a border precisely so the active tab can paint over it: a
  descendant paints above its parent's background and below its border, and the
  whole point of Chrome's active tab is that there is no line between it and
  what is below.
- **The feet need `pointer-events: none`.** Each hangs 12px over the tab beside
  it; without it they swallow that tab's first 12px, which `elementFromPoint`
  reports. They also need `z-index` on the active and hovered tab, because among
  positioned siblings the later one paints on top and the tab to the right
  covered the active tab's right foot.
- **Inactive tabs have no shape** until hovered, when they get a rounded panel
  in `--rule`. Separators sit between two inactive tabs only and vanish either
  side of the active tab and the hovered one.
- **The × opens the sleep dialog**, which is also where deleting lives — so the
  worktree's own toolbar has no trashcan. A tab is therefore a `<span>` wrapper
  with two buttons inside it: a `<button>` inside a `<button>` is not HTML.
- **A tab says whether work is left in the worktree**, in one slot: the dirty
  count when there is one, otherwise a fork glyph when the branch has commits
  the default branch does not. Committed and uncommitted work answer the same
  question, and the count is the more urgent answer, so it wins the slot. The
  **Files toggle in a window's own bar carries the same slot** — `ForkIcon` is
  shared for exactly that reason — because it is the control you click to look
  at the answer, and two glyphs for one fact would be two things to learn.
- **A tab does not name the branch.** A worktree is nearly always on the branch
  it is named after, so it was a second copy of the name most of the time and
  every tab paid width for it. The dropdown still names it, where a sleeping
  worktree is hardest to recognise, and so does the window's own bar.
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
- **Contrast pins two rules.** `--graphite-dim` measures 4.42:1 on `--rule` and
  3.62:1 on `--rule-bright`, both under the floor, so everything quiet steps up
  to `--graphite` while a hover ground is under it, and the pill's × is
  `--graphite` with `--danger` only on a hover that brings its own `--ink`.

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

**The files panel is one unit while it is only its tree**, and that is the single
exception to "nothing may ask for one unit". The floor of two exists to keep the
80-column promise, and that promise is about panes you read *code* in — a
terminal, a diff, the editor. A tree is chrome: names at a few levels of indent,
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
is hidden. While a query is present the sidebar is a flat list of hits, and
opening one expands its ancestors -- so clearing the box leaves the tree already
opened onto the file you found.

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
  pane, measured. Two symptoms, one cause: `.cm-scroller` then has nothing to
  scroll, so the file would not scroll; and with nothing scrollable under the
  pointer, `inner()` finds no candidate and the row takes every wheel, so
  scrolling the file slid the whole row of windows sideways.
- **The tree must stay a scroller** (`overflow-y: auto`) for the same second
  reason -- it is what `inner()` looks for so a wheel over it does not reach the
  row. Still true with the file column gone, and checked with a real wheel over
  a tree-only panel: the tree moved 61px and `.grid`'s `scrollLeft` stayed at 0.
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

This is not the wheel rule in reverse. A wheel over a tile means "scroll the
row", which is why turning it into keystrokes was wrong; a finger inside a pane
has no other meaning.

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
rather than sitting above its own output. And when the last queued todo has gone
to Claude the panel closes and **Claude takes the keyboard** — the queue was
typed into that agent, so that is where you are about to be looking, and the
alternative is a closing panel dropping focus on the document.

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
the new-todo box, or the files panel's editor. `FilesPane` decides between the
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
  after: a pane whose content does not scroll hands the wheel to the row, and
  that reads as the row drifting sideways while you scroll a file.
- **Syntax colour is in generated class names.** `HighlightStyle` emits its own
  (`ͼ5`, `ͼ9`); there is no `.tok-keyword` to look for. Read the computed colour
  of a span inside `.cm-line` instead.
- **Terminal text is in a canvas.** `tmux -S <socket> capture-pane -p -t <name>`
  is how you read it, and how focus handover was confirmed. Synthetic
  `dispatchEvent` once passed while Shift+Enter was broken in the real browser.
