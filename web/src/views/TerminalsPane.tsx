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
}: TerminalsTabsProps): React.ReactElement => {
  const active = selected(terminals, activeTerminalId)
  const labels = terminalLabels(terminals)

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
