# web

React, xterm.js, and plain CSS with custom properties. No component library, no
CSS framework, no state library — `store.ts` is a subscription over a plain
object, and that is enough.

```
App.tsx              projects -> groups -> the row; every dialog; UI state writes
store.ts / socket.ts the snapshot, and the one WebSocket
api.ts               REST calls, typed against shared/
components/TopBar    project groups, awake tabs, the zZ dropdown
views/Overview       the row: spot arithmetic, scrolling, what fits
views/TerminalsPane  a worktree's terminals and their tab strip
views/GitPane        changes, commits, diffs
terminal/TerminalView  one xterm bound to one session
views/overviewLayout   MIN_PANE_COLUMNS, PANE_CHROME_WIDTH, measureMonoCharWidth
views/useNearViewport  whether a tile is close enough to mount its terminal
views/tileMotion       keeps a departing tile alive while it animates out
```

## The row is a grid of spots

`Overview.tsx` holds the only layout arithmetic:

```ts
spots = max(1, floor((width - GAP) / (minPaneWidth + GAP)))
pitch = (width - GAP) / spots          // a spot plus the gap after it
tileWidth = panes * pitch - GAP        // a tile swallows the gaps it covers
```

Two consequences to preserve. **Every tile starts on a spot boundary**, so
scrolling to `spot * pitch` lands a tile flush at the left edge and no tile is
ever shown half-cut; the snap points are one out-of-flow `.grid__spot` marker
per spot. And **a tile wider than the window is collapsed, not squeezed**:
`panesOf` drops Claude's pane first, then the oldest expansions, keeping the
newest `capacity` panels — which is why `ui.panels` is stored in opening order.
A panel the layout could not keep is *closed* (`onCollapsePanels`), not left
open with nothing behind it, so a toggle never lies about what is on screen.

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

## The wheel is not a keyboard

On the alternate screen xterm.js turns a wheel notch into an Up or Down arrow
and sends it as input — iTerm does the same, and in a terminal that owns the
whole window it is reasonable. Here the wheel belongs to the row, and the
pointer is over some tile whenever you scroll it, so that translation delivered
arrow keys into whichever agent happened to be under the cursor — no click, no
focus — and Claude reads Up as "recall the last prompt". `TerminalView`
cancels it with a custom wheel handler, and only it: an app that has actually
turned mouse reporting on still gets its wheel events. Measured with a stand-in
agent that logs its stdin.

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
running has finished nothing, so it stays grey. A diff's green and red are the
single exception to the rule, because a patch is content.

Every text colour clears 4.5:1 on every ground it lands on, including
`--slab-raised`; the three greys are a ladder (13.4 : 7.0 : 5.2). Class names
describe the interface's parts (`.tile`, `.chip`, `.grid__spot`); user-visible
text never does — it says worktree, window, terminal, Claude.

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
- **Terminal text is in a canvas.** `tmux -S <socket> capture-pane -p -t <name>`
  is how you read it, and how focus handover was confirmed. Synthetic
  `dispatchEvent` once passed while Shift+Enter was broken in the real browser.
