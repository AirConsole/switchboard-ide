import type { Worktree } from '@switchboard/shared'
import { ForkIcon } from './ForkIcon.js'
import type { WorktreeStatus } from '../selectors.js'

/** The tab class for a status: what colour its leading bar is, if any. */
export const statusClass = (status: WorktreeStatus): string =>
  status === 'needs-you'
    ? 'tab--needs'
    : status === 'working'
      ? 'tab--working'
      : status === 'idle'
        ? 'tab--idle'
        : 'tab--off'

/**
 * What a tab says: its name and its dirty count.
 *
 * A fragment of spans rather than a box of its own, because a tab's body is
 * already the box.
 *
 * It does not name the branch. A worktree is nearly always on the branch it is
 * named after, so it was a second copy of the name most of the time and every
 * tab paid width for it; the dropdown used to make an exception, and does not
 * any more now that its rows are tabs. The window's own bar names the branch,
 * and so does a tab's title.
 */
const WorktreeLabel = ({
  worktree,
  queued,
}: {
  worktree: Worktree
  queued: number
}): React.ReactElement => (
  <>
    <span className="tab__name">{worktree.name}</span>
    {worktree.dirty ? (
      <span className="tab__dirty">{worktree.dirty}&plusmn;</span>
    ) : worktree.unmerged ? (
      <ForkIcon className="tab__fork" />
    ) : null}
    {/* Said in the same quiet channel as the dirty count, because it is the same
        kind of fact: how much work is parked here. Not in colour and not on the
        bullet -- those already mean "blocked on you" and "done", and a third
        meaning on either would make them argue. */}
    {queued > 0 ? <span className="tab__queued">{queued} queued</span> : null}
  </>
)

/**
 * One worktree, as the object you meet everywhere.
 *
 * It lives in three places now -- the strip, the sleeping-worktrees dropdown,
 * and the list a todo is moved into -- and it has to be the same thing in all
 * of them. Each used to draw its own row, and a worktree then looked like a
 * different object depending on where you ran into it: the state spelled out in
 * words here, a bullet there. Everything a tab knows how to say -- the state on
 * its leading bar, the zZ, the dirty count, the fork, what is queued behind it
 * -- it says wherever it is drawn.
 */
export const WorktreeTab = ({
  worktree,
  status,
  queued,
  sleeping,
  active = false,
  title,
  onPick,
  onClose,
}: {
  worktree: Worktree
  status: WorktreeStatus
  /** How much is parked against it: said in the label, never in colour. */
  queued: number
  sleeping: boolean
  /** Where you are. Only ever true in the strip. */
  active?: boolean
  /** The hover panel, built by whoever is drawing it: it says what a click does. */
  title: string
  onPick: () => void
  /** The ×, where there is something to put away. */
  onClose?: { title: string; run: () => void }
}): React.ReactElement => (
  <span
    className={[
      'tab',
      sleeping ? 'tab--asleep' : 'tab--awake',
      statusClass(status),
      active ? 'tab--active' : '',
    ]
      .filter(Boolean)
      .join(' ')}
  >
    <button className="tab__body" onClick={onPick} title={title}>
      {/* The state is the bar down the tab's leading edge, drawn by `.tab`
          itself rather than by anything in here -- see styles.css. It is on
          every tab, asleep or not: sleeping does not mean stopped, Claude
          can be left running, so a sleeper blocked on you has to be able to
          say so from the bar. The zZ is the other fact. */}
      {sleeping && (
        <span className="tab__zz" aria-hidden="true">
          zZ
        </span>
      )}
      <span className="tab__label">
        <WorktreeLabel worktree={worktree} queued={queued} />
      </span>
    </button>
    {onClose && (
      <button
        className="tab__close"
        onClick={onClose.run}
        title={onClose.title}
        aria-label={onClose.title}
      >
        &times;
      </button>
    )}
  </span>
)
