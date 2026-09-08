import type { Session, Worktree } from '@ide-n-dream/shared'
import { TerminalView } from '../terminal/TerminalView.js'

/**
 * Label each terminal with what it is running.
 *
 * `bash`, `vim`, `npm` says something; a position in a list does not. When two
 * terminals are running the same thing the label alone stops distinguishing
 * them, so those — and only those — get a counter appended.
 */
export const terminalLabels = (terminals: Session[]): string[] => {
  const names = terminals.map((terminal) => terminal.command?.trim() || 'shell')
  const totals = new Map<string, number>()
  for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1)
  const seen = new Map<string, number>()
  return names.map((name) => {
    if ((totals.get(name) ?? 0) < 2) return name
    const nth = (seen.get(name) ?? 0) + 1
    seen.set(name, nth)
    return `${name} ${nth}`
  })
}

export interface TerminalsTileProps {
  worktree: Worktree
  terminals: Session[]
  /** Selected terminal id, if the stored one still exists. */
  activeTerminalId: string | null
  fontSize: number
  onSelect: (sessionId: string) => void
  onNew: () => void
  onClose: (sessionId: string) => void
}

/**
 * One tile holding every terminal of a worktree, selected by a tab strip.
 *
 * A tile rather than a pane: it is laid out by the same rules as a Claude tile,
 * so it gets the same 80-column floor and wraps the same way. Its header lists
 * the terminals because that is the only place they are reachable now.
 */
export const TerminalsTile = ({
  worktree,
  terminals,
  activeTerminalId,
  fontSize,
  onSelect,
  onNew,
  onClose,
}: TerminalsTileProps): React.ReactElement => {
  const active = terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0]
  const labels = terminalLabels(terminals)

  return (
    <div className="tile tile--terminals">
      <div className="tile__head">
        <span className="tile__name">{worktree.name}</span>
        <span className="tile__branch">terminals</span>
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
      </div>
      <div className="tile__screen">
        {active ? (
          <TerminalView session={active} primary={true} fontSize={fontSize} />
        ) : (
          <div className="tile__idle">
            <p className="tile__idle-text">No terminals open in this worktree.</p>
            <button className="btn" onClick={onNew}>
              New terminal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
