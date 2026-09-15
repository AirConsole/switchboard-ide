import { useEffect, useRef } from 'react'
import type { Session } from '@switchboard/shared'
import { TerminalView } from '../terminal/TerminalView.js'
import { terminalLabels } from './terminalLabels.js'

export interface TerminalsTabsProps {
  terminals: Session[]
  /** Selected terminal id, if the stored one still exists. */
  activeTerminalId: string | null
  onSelect: (sessionId: string) => void
  onNew: () => void
  onClose: (sessionId: string) => void
  /** The last terminal has gone; see the effect below. */
  onNoneLeft: () => void
}

/** The selected terminal, falling back to the first. */
const selected = (terminals: Session[], activeTerminalId: string | null): Session | undefined =>
  terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0]

/**
 * The terminals panel's controls, for the worktree's bar.
 *
 * They belong in the bar rather than in a strip of their own: the bar runs
 * across the whole tile, so sitting in the segment above the terminals pane is
 * what says these tabs drive that pane and not the Claude session beside it.
 */
export const TerminalsTabs = ({
  terminals,
  activeTerminalId,
  onSelect,
  onNew,
  onClose,
  onNoneLeft,
}: TerminalsTabsProps): React.ReactElement => {
  const active = selected(terminals, activeTerminalId)
  const labels = terminalLabels(terminals)

  /*
   * The panel goes when its last terminal does.
   *
   * A terminal that exits is closed for you -- the server drops the session the
   * moment its pane dies -- so typing `exit` and clicking the × end the same
   * way, panel included: with none left this is an empty column with a `+` in
   * it, which is exactly what closing the last one by hand already removes.
   *
   * On the transition, never on a count that is merely zero. Opening the panel
   * on a worktree with no terminals creates one, and for the length of that
   * round trip the panel is open and empty -- measured at 212ms, from the strip
   * appearing to the tab landing in it. Closing on a bare zero would undo the
   * click that opened it, every time.
   */
  const count = terminals.length
  const had = useRef(count)
  useEffect(() => {
    const before = had.current
    had.current = count
    if (before > 0 && count === 0) onNoneLeft()
  }, [count, onNoneLeft])

  return (
    <div className="termtabs">
      {terminals.map((terminal, index) => (
        <span
          key={terminal.id}
          className={terminal.id === active?.id ? 'termtab termtab--active' : 'termtab'}
        >
          <button
            className="termtab__pick"
            onClick={() => onSelect(terminal.id)}
            title={terminal.attachCommand}
          >
            {labels[index]}
            {terminal.liveness === 'dead' ? ' · exited' : ''}
          </button>
          <button
            className="termtab__close"
            onClick={() => onClose(terminal.id)}
            title={`Close ${labels[index]}`}
            aria-label={`Close terminal ${labels[index]}`}
          >
            &times;
          </button>
        </span>
      ))}
      <button
        className="termtab termtab--add"
        onClick={onNew}
        title="New terminal"
        aria-label="New terminal"
      >
        +
      </button>
    </div>
  )
}

export interface TerminalsScreenProps {
  terminals: Session[]
  activeTerminalId: string | null
  fontSize: number
  /** Hand the active terminal the keyboard when this changes. */
  focus?: number | null
}

/** The terminals panel's pane: whichever terminal the tabs have selected. */
export const TerminalsScreen = ({
  terminals,
  activeTerminalId,
  fontSize,
  focus = null,
}: TerminalsScreenProps): React.ReactElement | null => {
  const active = selected(terminals, activeTerminalId)
  /*
   * No empty state. Closing the last terminal closes the panel with it -- see
   * `closeTerminal` in App -- so "no terminals here" is not a thing this pane
   * has to say. If one is killed from somewhere else the pane goes blank for a
   * moment with the tab strip's `+` still above it, which is the whole of the
   * recovery.
   */
  if (!active) return null
  return <TerminalView session={active} primary={true} fontSize={fontSize} focus={focus} />
}
