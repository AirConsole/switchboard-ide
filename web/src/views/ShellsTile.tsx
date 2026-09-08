import type { Session, Worktree } from '@ide-n-dream/shared'
import { TerminalView } from '../terminal/TerminalView.js'

export interface ShellsTileProps {
  worktree: Worktree
  shells: Session[]
  /** Selected shell id, if the stored one still exists. */
  activeShellId: string | null
  fontSize: number
  onSelectShell: (sessionId: string) => void
  onNewShell: () => void
  onCloseShell: (sessionId: string) => void
}

/**
 * One tile holding every shell of a worktree, selected by a tab strip.
 *
 * A tile rather than a pane: it is laid out by the same rules as a Claude tile,
 * so it gets the same 80-column floor and wraps the same way. Its header lists
 * the shells because that is the only place they are reachable now.
 */
export const ShellsTile = ({
  worktree,
  shells,
  activeShellId,
  fontSize,
  onSelectShell,
  onNewShell,
  onCloseShell,
}: ShellsTileProps): React.ReactElement => {
  const active = shells.find((shell) => shell.id === activeShellId) ?? shells[0]

  return (
    <div className="tile tile--shells">
      <div className="tile__head">
        <span className="tile__name">{worktree.name}</span>
        <span className="tile__branch">shells</span>
        <div className="shelltabs">
          {shells.map((shell, index) => (
            <span
              key={shell.id}
              className={
                shell.id === active?.id ? 'shelltab shelltab--active' : 'shelltab'
              }
            >
              <button
                className="shelltab__pick"
                onClick={() => onSelectShell(shell.id)}
                title={shell.attachCommand}
              >
                {/* Shells are interchangeable, so they are numbered rather than
                    named -- a name would imply a difference that is not there. */}
                {index + 1}
                {shell.liveness === 'dead' ? '·exited' : ''}
              </button>
              <button
                className="shelltab__close"
                onClick={() => onCloseShell(shell.id)}
                title={`Close shell ${index + 1}`}
                aria-label={`Close shell ${index + 1}`}
              >
                &times;
              </button>
            </span>
          ))}
          <button
            className="shelltab shelltab--add"
            onClick={onNewShell}
            title="New shell"
            aria-label="New shell"
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
            <p className="tile__idle-text">No shells open in this worktree.</p>
            <button className="btn" onClick={onNewShell}>
              New shell
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
