import { useEffect, useRef, type RefObject } from 'react'
import type { Session } from '@switchboard/shared'
import { PanelIcon } from '../components/PanelIcon.js'
import { TerminalView } from '../terminal/TerminalView.js'
import { useNearViewport } from './useNearViewport.js'
import { TileFailure } from './Overview.js'
import type { Failure } from '../store.js'

export interface MachineTileProps {
  /** An action about this window that failed, if there is one. */
  failure: Failure | null
  onDismissFailure: () => void
  /** The machine's one terminal, while it is running. */
  session: Session | undefined
  fontSize: number
  /** The row, so this window can tell whether it is worth building a terminal. */
  scroller: RefObject<HTMLElement | null>
  /** Take the keyboard when this changes; the row stepped into this window. */
  focus: number | null
  /** Whether this is the window the row says you are in. */
  current: boolean
  onStart: () => void
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
 * One terminal and no tab strip, deliberately. A worktree's terminals are a
 * place you work, and you want several; this is a place you go to do one thing
 * and leave. If it exits, the pane offers to start another rather than
 * disappearing -- the window is part of the row's shape, and a row whose far
 * end comes and went would be a row you cannot learn.
 */
export const MachineTile = ({
  failure,
  onDismissFailure,
  session,
  fontSize,
  scroller,
  focus,
  current,
  onStart,
  onReveal,
}: MachineTileProps): React.ReactElement => {
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
      {/* No hostname: this is always the machine serving the page, and a linked
          machine's own terminal is not merged into this row. "This machine" is
          the true and shortest thing it can say. */}
      <div
        className="tile__bar"
        title="A terminal on this machine, in your home directory"
        onClick={onReveal}
      >
        <div className="tile__seg">
          <span className="tile__machine-icon" aria-hidden="true">
            <PanelIcon panel="terminals" className="topbar__icon" />
          </span>
          <span className="tile__name">This machine</span>
          {/* What it is for, in the words of what you do in it: the only window
              in the row that is not a worktree says so rather than being told
              apart by its shape alone. */}
          <span className="tile__prompt">a terminal in your home directory</span>
        </div>
      </div>
      {failure !== null && <TileFailure failure={failure} onDismiss={onDismissFailure} />}
      <div className="tile__body">
        <div className="tile__pane" data-pane="machine:machine">
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
