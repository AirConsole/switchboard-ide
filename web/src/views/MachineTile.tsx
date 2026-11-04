import { useEffect, useRef, type RefObject } from 'react'
import type { Session } from '@switchboard/shared'
import { PanelIcon } from '../components/PanelIcon.js'
import { useAnchoredMenu } from '../components/useAnchoredMenu.js'
import { machineHostOf } from '../selectors.js'
import { TerminalView } from '../terminal/TerminalView.js'
import { useNearViewport } from './useNearViewport.js'
import { TileFailure } from './Overview.js'
import type { Failure } from '../store.js'

/** A machine a terminal can be opened on: this one (null), or a linked one's key. */
export interface MachineChoice {
  key: string | null
  name: string
}

export interface MachineTileProps {
  /** An action about this window that failed, if there is one. */
  failure: Failure | null
  onDismissFailure: () => void
  /** This window's terminal, while it is running. */
  session: Session | undefined
  /**
   * A second or later terminal, in a window of its own. It closes rather than
   * offering to start again: the machine's first window is the one that is
   * always there.
   */
  extra: boolean
  fontSize: number
  /** The row, so this window can tell whether it is worth building a terminal. */
  scroller: RefObject<HTMLElement | null>
  /** Take the keyboard when this changes; the row stepped into this window. */
  focus: number | null
  /** Whether this is the window the row says you are in. */
  current: boolean
  onStart: () => void
  /** Another terminal, in a new window at the far end, on the machine given. */
  onAnother: (host: string | null) => void
  /** Where the + can open one: this machine first, then each linked one. */
  machines: MachineChoice[]
  /** End this terminal; its window goes with it. */
  onClose: (sessionId: string) => void
  onReveal: () => void
}

/**
 * The machine's own window: one shell, in your home directory.
 *
 * Every other terminal here belongs to a worktree, and the things you do
 * *before* a worktree exists have nowhere to happen -- cloning the repository
 * you are about to open is the one everybody hits, on a fresh install, with
 * nothing on screen but an invitation to open a project that is not on the
 * machine yet. So the row ends with the box the row is running on.
 *
 * One terminal and no tab strip, deliberately: this is a place you go to do
 * one thing and leave. A second one is a second *window*, to the right, made
 * by the + in the bar -- side by side is what you want two of these for, a
 * build in one and something watching it in the other, and a tab would hide
 * the one you are not typing in. If the first exits, its pane offers to start
 * another rather than disappearing -- the window is part of the row's shape,
 * and a row whose far end comes and went would be a row you cannot learn. The
 * ones after it do go, with their shell or their ×.
 */
export const MachineTile = ({
  failure,
  onDismissFailure,
  session,
  extra,
  fontSize,
  scroller,
  focus,
  current,
  onStart,
  onAnother,
  machines,
  onClose,
  onReveal,
}: MachineTileProps): React.ReactElement => {
  /*
   * Which machine this window's terminal is on. A linked machine's terminals
   * are windows here as well, named by that machine, since "This machine" on
   * a shell somewhere else is the one thing it must not say.
   */
  const host = session === undefined ? null : (machineHostOf(session) ?? null)
  const where =
    host === null ? 'This machine' : (machines.find((one) => one.key === host)?.name ?? 'A linked machine')
  /*
   * With a machine linked, the + asks which: a terminal there is the reason
   * to link one as often as its projects are. With none it opens one here
   * straight away, as it always did -- a menu of one is a click for nothing.
   */
  const pick = useAnchoredMenu<HTMLButtonElement>()
  const startRef = useRef<HTMLButtonElement | null>(null)
  const tileRef = useRef<HTMLDivElement | null>(null)
  /*
   * The same budget every other terminal keeps: a WebGL context and a render
   * loop are not spent on a window off the side of the scrollport. See
   * `useNearViewport`.
   */
  const near = useNearViewport(tileRef, scroller)
  /*
   * The same arrangement `IdleClaude` has, for the same reason: a step that
   * lands in a window with nothing running has to land on something, or the
   * walk cannot leave again -- it reads which pane holds the keyboard.
   */
  useEffect(() => {
    if (focus === null || session !== undefined) return
    startRef.current?.focus()
  }, [focus, session])

  return (
    <div className={`tile tile--machine${current ? ' tile--current' : ''}`} ref={tileRef}>
      {/* No hostname for this one: it is always the machine serving the page,
          and "This machine" is the true and shortest thing it can say. A
          linked machine's terminal says that machine's name. */}
      <div
        className="tile__bar"
        title={
          host === null
            ? 'A terminal on this machine, in your home directory'
            : `A terminal on ${where}, in your home directory there`
        }
        onClick={onReveal}
      >
        <div className="tile__seg">
          <span className="tile__machine-icon" aria-hidden="true">
            <PanelIcon panel="terminals" className="topbar__icon" />
          </span>
          <span className="tile__name">{where}</span>
          {/* What it is for, in the words of what you do in it: the only window
              in the row that is not a worktree says so rather than being told
              apart by its shape alone. */}
          <span className="tile__prompt">
            {extra ? (session?.command ?? 'another terminal') : 'a terminal in your home directory'}
          </span>
        </div>
        <div className="tile__controls">
          <button
            className="tile__toggle"
            ref={pick.anchor}
            aria-expanded={machines.length > 1 ? pick.at !== null : undefined}
            onClick={(event) => {
              // The new window takes the row and the keyboard; this one's
              // reveal would only race it there.
              event.stopPropagation()
              if (machines.length > 1) pick.toggle()
              else onAnother(null)
            }}
            title={
              machines.length > 1
                ? 'Another terminal, on this machine or a linked one, in a window to the right'
                : 'Another terminal on this machine, in a window to the right'
            }
          >
            <span aria-hidden="true">+</span>
          </button>
          {pick.at !== null && (
            <div
              ref={pick.menu}
              className="menu"
              role="menu"
              style={{ left: pick.at.left, top: pick.at.top }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="menu__label">New terminal on</div>
              {machines.map((machine) => (
                <button
                  key={machine.key ?? ''}
                  className="menu__item"
                  role="menuitem"
                  onClick={() => {
                    pick.close()
                    onAnother(machine.key)
                  }}
                >
                  {machine.name}
                </button>
              ))}
            </div>
          )}
          {extra && session !== undefined && (
            <button
              className="tile__toggle tile__away"
              onClick={(event) => {
                event.stopPropagation()
                onClose(session.id)
              }}
              title="Close this terminal"
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
      </div>
      {failure !== null && <TileFailure failure={failure} onDismiss={onDismissFailure} />}
      <div className="tile__body">
        <div className="tile__pane">
          {session === undefined ? (
            <div className="tile__idle">
              <p className="tile__idle-text">
                A terminal on this machine, for the work that comes before a project — cloning a
                repository, looking at a disk, killing something.
              </p>
              <button className="btn" ref={startRef} onClick={onStart}>
                Start a terminal
              </button>
            </div>
          ) : (
            near && (
              <TerminalView session={session} primary={true} fontSize={fontSize} focus={focus} />
            )
          )}
        </div>
      </div>
    </div>
  )
}
