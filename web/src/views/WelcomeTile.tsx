export interface WelcomeTileProps {
  onOpenProject: () => void
  /** Go to the machine's terminal, the window to the right of this one. */
  onGoToMachine: () => void
}

/**
 * The first window, while nothing is open: what to do, and the two ways to do
 * it.
 *
 * It replaced a screen that said *No project open* -- a statement of absence
 * where an instruction belongs, and the first sentence this interface said to
 * anybody. It is a window in the row rather than a screen of its own for one
 * reason: one way out of here is the machine's terminal, which is the window
 * immediately to the right, and a sentence can only point at that if it is
 * true. On a phone, where the row is one window per screen, "to the right" is
 * the swipe you would make anyway.
 *
 * It names *starting* a project first, because a machine with nothing on it is
 * the common case here -- a cloud machine on its first day -- and the dialog
 * already treats a path that does not exist as intent to begin one there. That
 * was reachable and unsaid: the offer only appeared once you had typed a path
 * nobody would type without knowing it would work.
 */
export const WelcomeTile = ({
  onOpenProject,
  onGoToMachine,
}: WelcomeTileProps): React.ReactElement => (
  <div className="tile tile--welcome">
    <div className="tile__body">
      <div className="tile__pane" data-pane="welcome:welcome">
        <div className="empty">
          <h1 className="empty__title">Open a project</h1>
          <p className="empty__body">
            A project is any directory inside a git repository. Every branch you work on becomes a
            worktree with its own Claude, its own terminals and its own window in this row — and
            they keep running whether or not this page is open.
          </p>
          <button className="btn" onClick={onOpenProject}>
            Open project
          </button>
          <p className="empty__body">
            Nothing on this machine yet? Type a path that does not exist and it is created and
            made into a repository — or clone one in{' '}
            <button className="link" onClick={onGoToMachine}>
              the terminal to the right
            </button>{' '}
            and open that.
          </p>
        </div>
      </div>
    </div>
  </div>
)
