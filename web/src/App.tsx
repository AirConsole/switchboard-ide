import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from './api.js'
import { bindSocketToStore, useStore } from './store.js'
import { TopBar } from './components/TopBar.js'
import { UpdateBanner } from './components/UpdateBanner.js'
import { useNarrow } from './components/useNarrow.js'
import { LoginScreen } from './components/LoginScreen.js'
import { OpenProjectDialog } from './components/OpenProjectDialog.js'
import { CloseProjectDialog } from './components/CloseProjectDialog.js'
import { RemoveWorktreeDialog } from './components/RemoveWorktreeDialog.js'
import { MACHINE_KEY, Overview, WELCOME_KEY, projectKey, type PaneKind } from './views/Overview.js'
import { ancestorsOf } from './views/FilesPane.js'
import { SleepWorktreeDialog, type SleepOptions } from './components/SleepWorktreeDialog.js'
import {
  worktreeToWakeOnOpen,
  claudeSession,
  drainTakesKeyboard,
  orderWorktrees,
  queuedTodoCount,
  removalLanding,
  removalAsks,
  removalQuestions,
  terminalSessions,
  titleFor,
  worktreeStatus,
} from './selectors.js'
import type { MoveTarget } from './views/TodoPane.js'
import { softKeys, useSoftKeyboard } from './terminal/softKeyboard.js'
import {
  MACHINE_WORKTREE_ID,
  type FilesMode,
  type PanelName,
  type Project,
  type UiState,
  type Worktree,
} from '@switchboard/shared'

/** A project and its worktrees, split into the awake ones and the sleeping. */
export interface ProjectGroup {
  project: Project
  awake: Worktree[]
  asleep: Worktree[]
}


/**
 * Which machine a version skew says to update, from the error the gateway
 * sent: `outdated` is `here` or `there`, and `host` is the linked machine's
 * key. Anything else is not a skew and offers nothing.
 */
const skewOf = (err: unknown): { host: string | null } | undefined => {
  if (!(err instanceof ApiError) || err.code !== 'protocol-mismatch') return undefined
  const { outdated, host } = err.details
  if (outdated === 'here') return { host: null }
  if (outdated === 'there' && typeof host === 'string') return { host }
  return undefined
}

export const App = (): React.ReactElement => {
  const { projects, worktrees, sessions, todos, ui, loaded, error, failure, authed, signedIn, refresh, setUi, setError, setFailure } =
    useStore()

  const [showOpenProject, setShowOpenProject] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [closingProject, setClosingProject] = useState<string | null>(null)
  const [sleeping, setSleeping] = useState<string | null>(null)
  /**
   * A request to bring a worktree's tile into view.
   *
   * Carries a counter, because asking twice for the same worktree has to be two
   * requests: opening a second panel on a tile you already scrolled to changes
   * its width again, and a bare id would compare equal and scroll nowhere.
   *
   * Deliberately not persisted -- it is a consequence of the click you just
   * made, not a fact about the layout. Restoring one on load would scroll you
   * somewhere for a reason that no longer exists.
   *
   * It names a worktree and nothing about where to put it: the row moves as
   * far as it takes to show the whole of that one, and no further. Every way
   * of asking -- a tab, a step, waking, opening a panel -- means the same
   * thing by it.
   */
  const [scrollTo, setScrollTo] = useState<{
    id: string
    /** Which pane of it to hand the keyboard to. */
    pane: PaneKind
    nonce: number
    /**
     * Whether to hand it the keyboard at all.
     *
     * False where the keyboard is drawn on the glass and is not up: taking it
     * there *opens* it, over half the window you were going to look at. See
     * `reveal`.
     */
    focus: boolean
  } | null>(null)
  /**
   * The worktree you are in.
   *
   * Not the same thing as the last scroll request, though navigating is one way
   * to arrive: clicking into a terminal, a tab strip or a panel puts you in
   * that worktree without asking the row to move, and the bar has to say so.
   * It is also what a Cmd+arrow step counts from, so stepping continues from
   * the window you clicked into rather than from the one you last navigated to.
   */
  /**
   * Where you are, to the pane.
   *
   * A Cmd+arrow step counts from here, and the walk now runs through panes as
   * well as worktrees -- so knowing the worktree is no longer enough to say
   * what the next stop is.
   */
  const [active, setActive] = useState<{ id: string; pane: PaneKind } | null>(null)
  /*
   * A phone. Asked once here and handed to both halves of the interface -- the
   * bar, which becomes a hamburger, and the row, which drops its gaps -- so the
   * two cannot disagree about what a phone is. CSS is told the answer through
   * `data-narrow` on `.app` rather than being given the number again.
   */
  const narrow = useNarrow()
  /**
   * Focus moved; remember where, unless it is where we already were.
   *
   * The identity check is not a nicety. `activeId` was a string, so writing the
   * same one back was free -- an object is not, and this fires on every focus
   * move *within* a pane, of which there are many: clicking from a search box
   * to a result, tabbing along a tab strip. Without the guard each one
   * re-renders the whole row, and the row holds live terminals.
   */
  /* Whether the soft keyboard is up. It decides one thing: see `reveal`. */
  const keyboardUp = useSoftKeyboard()
  /*
   * The same answer for the callbacks that are memoised on purpose -- the two
   * that write a scroll request without going through `reveal`, because both
   * setters are stable and they must not be rebuilt every render. A closure
   * over `keyboardUp` would be the value as it was when they were built.
   */
  const keyboardUpRef = useRef(keyboardUp)
  keyboardUpRef.current = keyboardUp

  const activate = useCallback((id: string, pane: PaneKind): void => {
    setActive((previous) =>
      previous?.id === id && previous.pane === pane ? previous : { id, pane },
    )
  }, [])

  /**
   * Go to a pane: mark it, bring it on screen, and hand it the keyboard.
   *
   * **Except where the keyboard is drawn on the glass and is not up.** There,
   * taking the keyboard *opens* it: arriving at a worktree would throw a
   * keyboard over half the screen you had just swiped to, and on the one you
   * came from it had been away. So on a coarse pointer with no soft keyboard
   * showing, this arrives without focus -- the tab lights, the window bar
   * lights, the row moves, and nothing pops up. Tap into the window and the
   * keyboard comes back, which is the gesture that asks for it.
   *
   * A phone with a hardware keyboard attached is the case this gets wrong: the
   * pointer is coarse and no soft keyboard is ever shown, so arriving never
   * takes focus and Tab is the way in. There is no way to ask a browser whether
   * a keyboard is attached, and the alternative -- opening the on-screen
   * keyboard on every swipe -- is the complaint this fixes.
   */
  const reveal = (id: string, pane: PaneKind = 'claude'): void => {
    setActive({ id, pane })
    const takeKeyboard = !softKeys() || keyboardUp
    setScrollTo((previous) => ({
      id,
      pane,
      nonce: (previous?.nonce ?? 0) + 1,
      focus: takeKeyboard,
    }))
  }

  /**
   * A dialog closed: put the keyboard back where you were.
   *
   * Back to the *pane*, not to the element that had focus when the dialog
   * opened -- that element is the control you clicked to open it, since a click
   * focuses a button, and restoring it would leave the caret in the top bar
   * with nothing to type into. `active` is the honest answer to "what was
   * focused before": it is maintained from focus moves inside the row, and the
   * top bar is not part of the row, so opening a dialog does not disturb it.
   *
   * Through `reveal`, so a worktree scrolled off the side comes back with the
   * keyboard -- and `reveal` moves the row by the fewest units it needs, which
   * is none when the window is already in front of you.
   */
  const refocus = (): void => {
    if (active !== null) reveal(active.id, active.pane)
  }

  /*
   * A message pinned to a window that is no longer in the row.
   *
   * It would be kept for ever and shown again if that worktree came back --
   * about something you did to it minutes or days ago. Closing a project or
   * removing a worktree is the common way in.
   */
  useEffect(() => {
    const where = failure?.where
    if (where === undefined || where === null || where === MACHINE_KEY) return
    if (!worktrees.some((worktree) => worktree.id === where)) setFailure(null)
  }, [failure, worktrees, setFailure])

  /**
   * Amber or green in the title when any worktree anywhere is -- asleep and on
   * a linked machine included, since an agent blocked on you is blocked on you
   * wherever it is. That is `titleFor`; this only hands it every worktree.
   */
  useEffect(() => {
    document.title = titleFor(worktrees.map((worktree) => worktreeStatus(sessions, worktree.id)))
  }, [worktrees, sessions])

  /*
   * A file dropped anywhere but the files tree does nothing.
   *
   * The browser's own answer to a dropped file is to *navigate to it*, which
   * here means the IDE is replaced by somebody's screen recording and every
   * terminal on screen is gone -- the sessions survive, being tmux, but the
   * page has to be loaded again. The tree accepts a drop on purpose (see
   * `FilesPane`); this is what makes a near miss cost nothing instead.
   *
   * Taking `dragover` is what makes a drop *possible*, which reads backwards
   * until you know the default: refusing the drag means the browser handles the
   * drop itself, and handling it means we can decline to do anything.
   */
  useEffect(() => {
    const swallow = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files') !== true) return
      event.preventDefault()
      if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  useEffect(() => {
    const unbind = bindSocketToStore()
    void refresh()
    return unbind
  }, [refresh])

  /**
   * An action of yours failed: say so, and say it where it happened.
   *
   * `where` is the row key of the window it was about, so the message is drawn
   * inside that window -- a linked machine that needs updating is a fact about
   * *its* worktrees, and saying it across the whole app told you less, not
   * more. It stays until dismissed: refreshes arrive constantly, and this used
   * to be cleared by the next one before anybody could read it.
   */
  const failIn =
    (where: string | null) =>
    (err: unknown): void =>
      setFailure({ message: err instanceof Error ? err.message : String(err), where, update: skewOf(err) })
  const fail = failIn(null)

  /*
   * The current UI state, for callbacks that must keep one identity across
   * renders. `openPath` is handed to every tile in the row, and rebuilding it
   * on each render would restart the files hook's effects everywhere at once.
   */
  const uiRef = useRef(ui)
  uiRef.current = ui

  /*
   * Where the keyboard is, for callbacks that must not be rebuilt when it
   * moves. `queueDrained` is the one that matters: the drain effect depends on
   * its identity, and reading `active` directly would give it a new one every
   * time focus moved anywhere in the row.
   */
  const activeRef = useRef(active)
  activeRef.current = active

  /**
   * A wake or sleep that has been clicked and not yet read back.
   *
   * The machine the worktree lives on is the one that decides (see
   * `Worktree.awake`), so the click is a request -- and a poll landing before
   * it is answered would carry the old value and flick the window back for a
   * beat. What was clicked wins until the refresh after the request replaces
   * it.
   */
  const [pendingAwake, setPendingAwake] = useState<ReadonlyMap<string, boolean>>(new Map())
  const pendingAwakeRef = useRef(pendingAwake)
  pendingAwakeRef.current = pendingAwake

  /**
   * Which worktrees are awake: what each one's machine says.
   *
   * A machine too old to say is read the way a first run used to be -- awake if
   * anything is running in it.
   */
  const awake = useMemo(
    () =>
      new Set(
        worktrees
          .filter(
            (w) =>
              pendingAwake.get(w.id) ?? w.awake ?? sessions.some((s) => s.worktreeId === w.id),
          )
          .map((w) => w.id),
      ),
    [pendingAwake, worktrees, sessions],
  )

  /**
   * Projects in the order they were opened, each split into awake and asleep.
   *
   * Every registered project is open -- there is no active one -- so the top
   * bar shows them all and the row shows every awake worktree across them.
   */
  const groups = useMemo<ProjectGroup[]>(
    () =>
      projects.map((project) => {
        const mine = orderWorktrees(worktrees.filter((w) => w.projectId === project.id))
        return {
          project,
          awake: mine.filter((w) => awake.has(w.id)),
          asleep: mine.filter((w) => !awake.has(w.id)),
        }
      }),
    [projects, worktrees, awake],
  )

  /*
   * Forget the per-worktree UI of worktrees that are gone.
   *
   * `onRemoved` clears `panels` for the one you removed, and nothing clears
   * anything for a worktree removed outside the IDE -- so the open file, the
   * expanded directories, the chosen terminal and the files mode accumulated
   * for every worktree that ever existed, and all of it is persisted to the
   * server and to localStorage on every change.
   *
   * Only once the snapshot has actually loaded: before that `worktrees` is
   * empty, and pruning against it would wipe the lot.
   */
  useEffect(() => {
    if (!loaded || worktrees.length === 0) return
    const known = new Set(worktrees.map((worktree) => worktree.id))
    const prune = <T,>(map: Record<string, T>): Record<string, T> | null => {
      const kept = Object.fromEntries(Object.entries(map).filter(([id]) => known.has(id)))
      return Object.keys(kept).length === Object.keys(map).length ? null : (kept as Record<string, T>)
    }
    const panels = prune(ui.panels)
    const active = prune(ui.activeTerminalByWorktree)
    const open = prune(ui.openPathByWorktree)
    const expanded = prune(ui.expandedByWorktree)
    const modes = prune(ui.filesModeByWorktree)
    const files = prune(ui.openFilesByWorktree)
    if (!panels && !active && !open && !expanded && !modes && !files) return
    setUi({
      ...(panels ? { panels } : {}),
      ...(active ? { activeTerminalByWorktree: active } : {}),
      ...(open ? { openPathByWorktree: open } : {}),
      ...(expanded ? { expandedByWorktree: expanded } : {}),
      ...(modes ? { filesModeByWorktree: modes } : {}),
      ...(files ? { openFilesByWorktree: files } : {}),
    })
  }, [loaded, worktrees, ui, setUi])

  /** Every awake worktree, in the order the row shows them. */
  const rowWorktrees = useMemo(() => groups.flatMap((group) => group.awake), [groups])

  /*
   * Where you are, remembered as you move -- see the arrival below, which reads
   * it back. Not until that arrival has happened, or the first window to take
   * focus on load would overwrite the one it is about to go back to.
   */
  useEffect(() => {
    if (!started.current || active === null || active.id === WELCOME_KEY) return
    if (uiRef.current.activeWorktree === active.id) return
    setUi({ activeWorktree: active.id })
  }, [active, setUi])

  /**
   * Where a todo can be moved to, per project: that project's own worktrees, in
   * the top bar's own order.
   *
   * By project because a todo is work on a repository, and another repository's
   * worktrees are not somewhere it could be done. Sleeping ones are in, and
   * that is the point -- parking work against an agent you are not running
   * today is most of what a todo is for, and the row only holds the awake ones.
   */
  const moveTo = useMemo<Record<string, MoveTarget[]>>(
    () =>
      Object.fromEntries(
        groups.map((group) => [
          group.project.id,
          [
            ...group.awake.map((worktree) => ({ worktree, sleeping: false })),
            ...group.asleep.map((worktree) => ({ worktree, sleeping: true })),
          ].map(({ worktree, sleeping }) => ({
            worktree,
            sleeping,
            status: worktreeStatus(sessions, worktree.id),
            queued: queuedTodoCount(todos, worktree.id),
          })),
        ]),
      ),
    [groups, sessions, todos],
  )

  /**
   * Say which way these are going, then ask their machines to make it so.
   *
   * The pending mark is dropped once the refresh after the request has landed,
   * whichever way it went: on success the snapshot now says the same thing, and
   * on failure it says what is actually true.
   */
  const changeAwake = (ids: string[], value: boolean, request: Promise<unknown>): void => {
    setPendingAwake((current) => {
      const next = new Map(current)
      for (const id of ids) next.set(id, value)
      return next
    })
    void request
      .catch(fail)
      .then(refresh)
      .finally(() =>
        setPendingAwake((current) => {
          const next = new Map(current)
          for (const id of ids) if (next.get(id) === value) next.delete(id)
          return next
        }),
      )
  }

  /*
   * On arrival, the window you were in when you left, and otherwise the first
   * worktree -- and its Claude has the keyboard.
   *
   * The remembered one only if the row still has it: a worktree put to sleep
   * or removed since, on this machine or another, is somewhere you cannot be.
   * It was only ever the first worktree, and a reload in the middle of the row
   * dropped you back at its start with the window you had been in off screen.
   *
   * Once, and only once there is something to point at -- the first render
   * happens before the snapshot lands. After that the active window is
   * whatever you last navigated to, and this must not keep dragging it back.
   */
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !loaded) return
    // Absent in a `ui` stored before this was remembered.
    const id = ui.activeWorktree ?? null
    const pane: PaneKind | null =
      id === null
        ? null
        : id === MACHINE_KEY
          ? 'machine'
          : groups.some((group) => projectKey(group.project.id) === id)
            ? 'project'
            : rowWorktrees.some((worktree) => worktree.id === id)
              ? 'claude'
              : null
    const first = rowWorktrees[0]
    if (pane === null && first === undefined) return
    started.current = true
    if (id !== null && pane !== null) reveal(id, pane)
    else if (first !== undefined) reveal(first.id)
    // `reveal` is rebuilt every render and this fires once, so it is not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, rowWorktrees])

  /**
   * Wake a worktree: bring back its tile and its agent.
   *
   * The server does the part a client cannot -- resuming the conversation that
   * was stopped rather than starting a blank one -- and we scroll to it, since
   * with several worktrees awake it may well arrive off the side of the row.
   */
  const wake = (worktreeId: string): void => {
    changeAwake([worktreeId], true, api.wakeWorktree(worktreeId))
    reveal(worktreeId)
  }

  /**
   * A worktree is gone: drop everything this client remembered about it.
   *
   * "Where you are" included -- it would otherwise point at a window that is
   * not there, which is what a Cmd+arrow step counts from. Shared by the two
   * ways of removing one, the dialog and the straight-through delete, because
   * what has to be forgotten does not depend on how many questions were asked.
   */
  const forgetWorktree = (worktreeId: string): void => {
    const panels = { ...ui.panels }
    delete panels[worktreeId]
    // Its awake mark went with it, on its own machine.
    setUi({ panels })
    /*
     * If you were in the one that went, move into its neighbour -- see
     * `removalLanding`, which is where the rule and its reasons live. Read off
     * the row as it stands, which still holds the worktree being removed: the
     * refresh below is what drops it, and by then this has already said where
     * to go. Leaving `active` null instead is what used to happen, and it left
     * the keyboard on the document with every window still full of terminals.
     */
    if (active?.id === worktreeId) {
      const landing = removalLanding(groups, worktreeId)
      if (landing === null) setActive(null)
      else if (landing.kind === 'worktree') reveal(landing.id)
      else reveal(projectKey(landing.id), 'project')
    }
    void refresh()
  }

  /**
   * Sleep a worktree: give back its space and, unless told otherwise, its
   * processes.
   */
  const sleep = (worktreeId: string, keep: SleepOptions): void => {
    setSleeping(null)
    changeAwake([worktreeId], false, api.sleepWorktree(worktreeId, keep))
  }

  const startClaude = (worktreeId: string): void => {
    const existing = claudeSession(sessions, worktreeId)
    // A worktree has one Claude session. If it exited, revive that one in place
    // -- respawning keeps its tmux session and history -- rather than leaving a
    // dead session behind and stacking a second one beside it.
    if (existing && existing.liveness !== 'dead') return
    // Through wake either way, so a restart continues the conversation for the
    // same reason waking does.
    void api.wakeWorktree(worktreeId).then(refresh).catch(failIn(worktreeId))
  }

  /**
   * The machine's own terminal: one shell, in your home directory.
   *
   * The same route every other terminal is made through, with the reserved
   * worktree id the server answers by skipping the worktree lookup entirely
   * (`MACHINE_WORKTREE_ID`). Nothing about it is stored in `ui`: there is one,
   * so there is no selection to remember, and the layout pruner has nothing of
   * it to throw away when the worktrees change.
   */
  const machineTerminal = (): void => {
    void api
      .createSession({ worktreeId: MACHINE_WORKTREE_ID, kind: 'shell' })
      .then(refresh)
      .catch(failIn(MACHINE_KEY))
  }

  const newTerminal = (worktreeId: string): void => {
    // The wire calls it a shell -- the pane runs $SHELL -- while the interface
    // calls it a terminal.
    void api
      .createSession({ worktreeId, kind: 'shell' })
      .then((session) => {
        // Read at write time, not from the render that started the request:
        // spawning a terminal takes a tmux round trip, and a selection made in
        // another window while it was in flight came back undone.
        setUi({
          activeTerminalByWorktree: {
            ...useStore.getState().ui.activeTerminalByWorktree,
            [worktreeId]: session.id,
          },
        })
        return refresh()
      })
      .catch(failIn(worktreeId))
  }

  /**
   * Close a terminal, and the panel with it when that was the last one.
   *
   * The panel is the terminals, not a container for them: with none left there
   * is nothing for it to show, and a pane saying so is a pane you then have to
   * close by hand. So the tile narrows on the same click, and the keyboard goes
   * back to that worktree's Claude -- the terminal that had it is gone, and
   * `reveal` is what hands it over.
   *
   * Checked before the kill, while the session is still in the snapshot: one
   * left means this is it.
   */
  const closeTerminal = (worktreeId: string, sessionId: string): void => {
    if (terminalSessions(sessions, worktreeId).length <= 1) {
      setUi({
        panels: {
          ...ui.panels,
          [worktreeId]: (ui.panels[worktreeId] ?? []).filter((panel) => panel !== 'terminals'),
        },
      })
      reveal(worktreeId)
    }
    void api.killSession(sessionId).then(refresh).catch(failIn(worktreeId))
  }

  /**
   * Show one of a worktree's panels, or close the one that is showing.
   *
   * One at a time: a worktree is Claude and at most one panel, so a tile is one
   * column or two and the whole of it fits a window that could only ever hold
   * part of it before. Opening replaces rather than appends, which is also what
   * makes the toggles a set of alternatives instead of a row of switches.
   */
  /**
   * Go to a worktree's agent, which is what its tab means.
   *
   * A tab used to reveal the tile and ask for Claude's pane, and on a narrow
   * window that asked for a pane which is not rendered: with a panel open
   * `panesOf` gives the whole tile to the panel, so the keyboard was handed to
   * nothing while `active` pointed at a pane that did not exist -- and the
   * Cmd+arrow walk counts from `active`. Closing the panel first makes Claude
   * exist again, which is the only way the promise can be kept.
   *
   * Deliberately not what `reveal` does everywhere: the Cmd+arrow walk steps
   * through *panes*, and a panel that shut itself as you stepped into it would
   * be a stop you could never reach. Waking, creating and `refocus` keep their
   * own meaning too -- a dialog closing must put you back where you were,
   * panel and all.
   */
  const revealClaude = (worktreeId: string): void => {
    // Skipped when there is nothing open, so a tab click on a plain worktree
    // does not cost a debounced UI write and a row re-render.
    if ((ui.panels[worktreeId] ?? []).length > 0) {
      setUi({ panels: { ...ui.panels, [worktreeId]: [] } })
    }
    reveal(worktreeId, 'claude')
  }

  const togglePanel = (worktreeId: string, panel: PanelName): void => {
    const open = ui.panels[worktreeId] ?? []
    const wasOpen = open.includes(panel)
    setUi({ panels: { ...ui.panels, [worktreeId]: wasOpen ? [] : [panel] } })
    /*
     * The tile just changed width, so bring the whole of it back into view --
     * and hand the keyboard to what was just opened, which is the pane you
     * asked for and the one you are about to type into: the new-todo box, the
     * files panel's editor or its finder, the terminal. Closing gives it back
     * to Claude, because the pane that had it no longer exists.
     */
    reveal(worktreeId, wasOpen ? 'claude' : panel)
    // The panel is only useful with something in it.
    if (panel === 'terminals' && !wasOpen && terminalSessions(sessions, worktreeId).length === 0) {
      newTerminal(worktreeId)
    }
  }

  /**
   * A worktree's last terminal has exited.
   *
   * The same close `closeTerminal` does, for the terminal that closed itself:
   * the server drops a shell session as soon as its pane dies, and a panel with
   * no terminals in it is a column holding a spot in the row for nothing. So
   * typing `exit` narrows the window exactly as clicking the × does, and the
   * keyboard goes back to that worktree's Claude -- the pane it was in no
   * longer exists, and leaving focus on the document would take the arrow keys
   * with it.
   *
   * Not while the worktree is on its way to sleep: sleeping kills its terminals
   * too, and this would read that as the panel closing itself and forget the
   * panel the worktree is supposed to wake up with. `awake` loses it on the
   * click, before the sessions go.
   */
  const terminalsGone = useCallback(
    (worktreeId: string): void => {
      const ui = uiRef.current
      if (pendingAwakeRef.current.get(worktreeId) === false) return
      if (useStore.getState().worktrees.find((w) => w.id === worktreeId)?.awake === false) return
      setUi({
        panels: {
          ...ui.panels,
          [worktreeId]: (ui.panels[worktreeId] ?? []).filter((panel) => panel !== 'terminals'),
        },
      })
      // Written out rather than calling `reveal`, for the reason given below:
      // both setters are stable, and `reveal` is a fresh function every render.
      setActive({ id: worktreeId, pane: 'claude' })
      setScrollTo((previous) => ({
        id: worktreeId,
        pane: 'claude',
        nonce: (previous?.nonce ?? 0) + 1,
        // The same rule `reveal` keeps, read now rather than closed over: a
        // soft keyboard that is down must not be opened by arriving.
        focus: !softKeys() || keyboardUpRef.current,
      }))
    },
    [setUi],
  )

  /**
   * A worktree's todo queue has emptied itself into Claude.
   *
   * The panel was open to line work up; with the queue drained it is a list
   * nobody asked to see, holding a spot in the row. Closed the way closing the
   * last terminal closes its panel -- but without `reveal`, because that click
   * is one you just made and this is a server typing a prompt into a window you
   * may not even be looking at. Dragging the row over to it would be the row
   * moving for something you did not do.
   */
  const queueDrained = useCallback(
    (worktreeId: string): void => {
      setUi({
        panels: {
          ...ui.panels,
          [worktreeId]: (ui.panels[worktreeId] ?? []).filter((panel) => panel !== 'todo'),
        },
      })
      /*
       * ...and the keyboard goes with it, but only out of the pane that is
       * going: see `drainTakesKeyboard`. A queue drains on the server whether
       * or not a browser is open, so this fires in windows you are not in --
       * and it used to scroll the row to them and take the caret out of
       * whatever you were writing.
       *
       * Written out rather than calling `reveal`, whose identity changes every
       * render and would defeat the memoisation the drain effect depends on;
       * both setters are stable, and `active` is read through a ref for the
       * same reason.
       */
      if (!drainTakesKeyboard(activeRef.current, worktreeId)) return
      setActive({ id: worktreeId, pane: 'claude' })
      setScrollTo((previous) => ({
        id: worktreeId,
        pane: 'claude',
        nonce: (previous?.nonce ?? 0) + 1,
        // The same rule `reveal` keeps, read now rather than closed over: a
        // soft keyboard that is down must not be opened by arriving.
        focus: !softKeys() || keyboardUpRef.current,
      }))
    },
    [ui.panels, setUi],
  )

  /**
   * Open a file in a worktree's files panel.
   *
   * Opening also expands the directories above it, which is what makes a
   * restored file visible in the tree without the expansion having to be
   * derived from the path -- and leaves collapsing an ancestor working
   * normally, which a derived set would quietly undo.
   *
   * Stable between renders, because it is handed to every tile and a fresh
   * identity each render would re-run the files hook for every worktree.
   */
  const openPath = useCallback(
    (worktreeId: string, path: string): void => {
      const ui = uiRef.current
      const was = ui.expandedByWorktree[worktreeId] ?? []
      const opened = new Set([...was, ...ancestorsOf(path)])
      /*
       * In Files mode the file also joins the tabs above the editor, which is
       * what makes the pane exist at all. Only in Files mode: picking a changed
       * file in Changes opens its diff, and collecting diffs as tabs is not
       * what the list is for. It joins on the mode switch instead, below.
       */
      const tabs = ui.openFilesByWorktree[worktreeId] ?? []
      const keeps = (ui.filesModeByWorktree[worktreeId] ?? 'files') === 'files'
      const next = keeps && path !== '' && !tabs.includes(path) ? [...tabs, path] : tabs
      setUi({
        openPathByWorktree: { ...ui.openPathByWorktree, [worktreeId]: path },
        expandedByWorktree: { ...ui.expandedByWorktree, [worktreeId]: [...opened] },
        ...(next === tabs ? {} : { openFilesByWorktree: { ...ui.openFilesByWorktree, [worktreeId]: next } }),
      })
    },
    [setUi],
  )

  /**
   * Close one of a worktree's open files.
   *
   * The keyboard goes to the tab on the right, falling back to the left, which
   * is the rule every tab strip has; closing the last one empties the list and
   * takes the editor with it, leaving the panel as the tree alone.
   */
  const closeFile = useCallback(
    (worktreeId: string, path: string): void => {
      const ui = uiRef.current
      const tabs = ui.openFilesByWorktree[worktreeId] ?? []
      const at = tabs.indexOf(path)
      if (at === -1) return
      const next = tabs.filter((file) => file !== path)
      const patch: Partial<UiState> = {
        openFilesByWorktree: { ...ui.openFilesByWorktree, [worktreeId]: next },
      }
      if (ui.openPathByWorktree[worktreeId] === path) {
        const heir = next[at] ?? next[at - 1] ?? ''
        patch.openPathByWorktree = { ...ui.openPathByWorktree, [worktreeId]: heir }
      }
      setUi(patch)
    },
    [setUi],
  )

  /**
   * Which face a worktree's files panel shows.
   *
   * Stable between renders for the same reason `openPath` is: it is handed to
   * every tile in the row, and a fresh identity each render would restart the
   * panel's effects for every worktree at once.
   */
  const filesMode = useCallback(
    (worktreeId: string, mode: FilesMode): void => {
      const ui = uiRef.current
      const patch: Partial<UiState> = {
        filesModeByWorktree: { ...ui.filesModeByWorktree, [worktreeId]: mode },
      }
      /*
       * The one selection serves all three modes, so arriving in Files with a
       * file picked in Changes has to give that file a tab -- otherwise the
       * editor would have nothing to sit under and the panel would close on
       * the file you just asked to read.
       */
      const path = ui.openPathByWorktree[worktreeId] ?? ''
      const tabs = ui.openFilesByWorktree[worktreeId] ?? []
      if (mode === 'files' && path !== '' && !tabs.includes(path)) {
        patch.openFilesByWorktree = { ...ui.openFilesByWorktree, [worktreeId]: [...tabs, path] }
      }
      setUi(patch)
    },
    [setUi],
  )

  /**
   * Whether Markdown opens rendered rather than as its source.
   *
   * One switch for the whole IDE, so it takes no worktree: what it records is
   * whether the reader reads the Markdown in this repository or edits it, and
   * that is not a fact about any one worktree. Stable between renders for the
   * reason its neighbours are -- it is handed to every tile in the row.
   */
  const markdownPreview = useCallback(
    (on: boolean): void => {
      setUi({ markdownPreview: on })
    },
    [setUi],
  )

  /**
   * A step was taken with the keyboard, while the count still means something.
   *
   * Through `uiRef` for the reason its neighbours are: one identity across
   * renders, so the row's key handler is not torn down and rebound every time
   * anything else in `ui` moves. The row stops calling this at the threshold,
   * so this cannot run away.
   */
  const stepTaken = useCallback((): void => {
    setUi({ stepsTaken: uiRef.current.stepsTaken + 1 })
  }, [setUi])

  /**
   * Open a directory and everything above it, expanding nothing else.
   *
   * What picking a directory out of the search results means: you asked for a
   * place, so the tree has to be showing it once the query goes. `toggleDir`
   * cannot do this -- it is one directory at a time, and two calls in a render
   * both read the same `uiRef`, so the second would drop the first.
   */
  const expandDir = useCallback(
    (worktreeId: string, dir: string): void => {
      const ui = uiRef.current
      const was = ui.expandedByWorktree[worktreeId] ?? []
      const opened = new Set([...was, ...ancestorsOf(dir), dir])
      setUi({ expandedByWorktree: { ...ui.expandedByWorktree, [worktreeId]: [...opened] } })
    },
    [setUi],
  )

  /** Expand or collapse one directory of a worktree's file tree. */
  const toggleDir = useCallback(
    (worktreeId: string, dir: string): void => {
      const ui = uiRef.current
      const was = ui.expandedByWorktree[worktreeId] ?? []
      const next = was.includes(dir) ? was.filter((d) => d !== dir) : [...was, dir]
      setUi({ expandedByWorktree: { ...ui.expandedByWorktree, [worktreeId]: next } })
    },
    [setUi],
  )

  /*
   * Before `loaded`, because `loaded` goes true in the refresh catch as well --
   * keying on it alone drops a signed-out browser into the main view with an
   * empty row and no way to act. Replaces the view rather than overlaying it: a
   * row of tiles that looks alive and can no longer refresh is the failure this
   * project keeps fixing elsewhere.
   */
  if (authed === false) return <LoginScreen onSignedIn={signedIn} />

  if (!loaded) {
    return (
      <div className="empty">
        <p className="empty__body">Loading…</p>
      </div>
    )
  }

  const topBar = (
    <TopBar
      groups={groups}
      sessions={sessions}
      todos={todos}
      onOpenProject={() => setShowOpenProject(true)}
      /*
       * The project's name is its pane's tab: this walks you there and hands
       * over the caret, the same as clicking a worktree's tab. Closing the
       * project is in that pane now rather than on a × up here.
       */
      onRevealProject={(project) => reveal(projectKey(project.id), 'project')}
      onRevealMachine={() => reveal(MACHINE_KEY, 'machine')}
      onWake={wake}
      onReveal={revealClaude}
      activeId={active?.id ?? null}
    />
  )

  const dialogs = (
    <>
      {showOpenProject && (
        <OpenProjectDialog
          onClose={() => {
            setShowOpenProject(false)
            refocus()
          }}
          onOpened={(project) => {
            setShowOpenProject(false)
            void refresh().then(() => {
              if (project === undefined) return
              const { worktrees, sessions } = useStore.getState()
              const first = worktreeToWakeOnOpen(project.id, worktrees, sessions)
              if (first !== null) wake(first)
            })
          }}
        />
      )}
      {closingProject && projects.some((p) => p.id === closingProject) && (
        <CloseProjectDialog
          project={projects.find((p) => p.id === closingProject)!}
          worktrees={worktrees.filter((w) => w.projectId === closingProject)}
          sessions={sessions}
          onCancel={() => {
            setClosingProject(null)
            refocus()
          }}
          onClose={(sleep) => {
            /*
             * If you were standing in something that project owned, move into
             * whatever is left. Closing is a button *inside* that project's own
             * pane now, so `active` reliably names a cell that is about to go --
             * and an `active` pointing at nothing leaves the keyboard on the
             * document and blanks the Cmd legend. The same reasoning as
             * `forgetWorktree`, one level up.
             */
            const mine = new Set(
              worktrees.filter((w) => w.projectId === closingProject).map((w) => w.id),
            )
            if (active !== null && (active.id === projectKey(closingProject) || mine.has(active.id))) {
              const left = groups.find((g) => g.project.id !== closingProject)
              if (left === undefined) setActive(null)
              else reveal(projectKey(left.project.id), 'project')
            }
            setClosingProject(null)
            /*
             * Stopping everything also puts its worktrees to sleep, which the
             * project's machine records as part of closing it -- so re-opening
             * starts them asleep rather than claiming agents that were killed.
             */
            const request = api.closeProject(closingProject, { sleep })
            if (sleep) changeAwake([...mine], false, request)
            else void request.then(refresh).catch(fail)
          }}
        />
      )}
      {sleeping && worktrees.some((w) => w.id === sleeping) && (
        <SleepWorktreeDialog
          worktree={worktrees.find((w) => w.id === sleeping)!}
          sessions={sessions}
          todos={todos}
          onClose={() => {
            setSleeping(null)
            refocus()
          }}
          onSleep={(keep) => sleep(sleeping, keep)}
          /*
           * Putting a worktree away and getting rid of it are the same
           * question asked with different force, so they are asked in the same
           * place: the trashcan that used to live in the window's own bar is
           * gone, and this hands over to the dialog that does the deleting --
           * when that dialog has anything to ask. A worktree with nothing
           * uncommitted and nothing unmerged loses nothing by going, so the
           * second dialog would be two clicks to answer no questions, and this
           * one has already asked.
           */
          onDelete={() => {
            const worktree = worktrees.find((w) => w.id === sleeping)
            setSleeping(null)
            if (worktree === undefined) return
            if (removalAsks(worktree, sessions, todos)) {
              setRemoving(worktree.id)
              return
            }
            void api
              .removeWorktree(worktree.id, {
                force: false,
                deleteBranch: removalQuestions(worktree).branchGoesAnyway,
                deleteRemoteBranch: removalQuestions(worktree).remoteBranchGoesAnyway,
              })
              .then(() => forgetWorktree(worktree.id))
              .catch(fail)
          }}
        />
      )}
      {removing && worktrees.some((w) => w.id === removing) && (
        <RemoveWorktreeDialog
          worktree={worktrees.find((w) => w.id === removing)!}
          sessions={sessions}
          todos={todos}
          onClose={() => {
            setRemoving(null)
            refocus()
          }}
          onRemoved={() => {
            forgetWorktree(removing)
            setRemoving(null)
          }}
        />
      )}
    </>
  )

  /*
   * No early return for "nothing open" any more.
   *
   * It used to replace the row with a screen that said *No project open*, and
   * that screen had nowhere to go: the way to get a repository onto a machine
   * that has none is a terminal, and every terminal here belonged to a
   * worktree. The row now carries the invitation as its first window and the
   * machine's own terminal as the next one, so the sentence "clone it in the
   * terminal to the right" is literally true -- see `WelcomeTile`.
   */

  return (
    <div className="app" data-narrow={narrow ? '' : undefined}>
      {topBar}

      {/*
        * Everything said across the whole app, in one grid row of its own. The
        * grid is the bar and then the row of windows; a banner placed straight
        * in it took the windows' `1fr` track and pushed the row into an
        * implicit one below the screen -- measured, a one-line banner drawn
        * 373px tall with the windows under it and out of reach. Empty, this is
        * a track of height zero.
        */}
      <div className="app__notices">
        {/* A newer Switchboard on origin, and the page reloaded onto it once it is running. */}
        <UpdateBanner />

        {/*
          * The page being out of touch, or an action that belongs to no window.
          * Everything that *is* about a window is said in it -- see `failure`.
          */}
        {(error ?? (failure?.where === null ? failure.message : null)) !== null && (
          <div className="banner">
            {error ?? failure?.message}
            <button
              className="banner__dismiss"
              onClick={() => {
                setError(null)
                setFailure(null)
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      <Overview
        narrow={narrow}
        /* Said in the window it is about, and kept until dismissed. */
        failure={failure?.where === null ? null : (failure ?? null)}
        onDismissFailure={() => setFailure(null)}
        onMachineTerminal={machineTerminal}
        onOpenProject={() => setShowOpenProject(true)}
        worktrees={rowWorktrees}
        projects={projects}
        todos={todos}
        moveTo={moveTo}
        sessions={sessions}
        panels={ui.panels}
        activeTerminalByWorktree={ui.activeTerminalByWorktree}
        openPathByWorktree={ui.openPathByWorktree}
        openFilesByWorktree={ui.openFilesByWorktree}
        expandedByWorktree={ui.expandedByWorktree}
        filesModeByWorktree={ui.filesModeByWorktree}
        markdownPreview={ui.markdownPreview}
        stepsTaken={ui.stepsTaken}
        groups={groups}
        onWake={wake}
        onSleep={setSleeping}
        onCloseProject={setClosingProject}
        scrollTo={scrollTo}
        active={active}
        onActivate={activate}
        onStart={startClaude}
        onReveal={reveal}
        onRevealClaude={revealClaude}
        onTogglePanel={togglePanel}
        onQueueDrained={queueDrained}
        onCreated={(worktreeId) => {
          // A worktree you just made is one you want to work in, so its machine
          // records it awake as it creates it -- and it is scrolled to, since
          // the row may be long.
          reveal(worktreeId)
          void refresh()
        }}
        onSelectTerminal={(worktreeId, sessionId) =>
          setUi({
            activeTerminalByWorktree: {
              ...ui.activeTerminalByWorktree,
              [worktreeId]: sessionId,
            },
          })
        }
        onNewTerminal={newTerminal}
        onOpenPath={openPath}
        onCloseFile={closeFile}
        onToggleDir={toggleDir}
        onExpandDir={expandDir}
        onFilesMode={filesMode}
        onMarkdownPreview={markdownPreview}
        onStepTaken={stepTaken}
        onCloseTerminal={closeTerminal}
        onNoTerminalsLeft={terminalsGone}
      />

      {dialogs}
    </div>
  )
}
