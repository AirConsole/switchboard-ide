import type { Session, Worktree, WorktreeTodo } from '@switchboard/shared'
import { ForkIcon } from './ForkIcon.js'
import {
  claudeSession,
  queuedTodoCount,
  stateLabel,
  worktreeStatus,
  type WorktreeStatus,
} from '../selectors.js'

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
 * What a row says: its name and its dirty count.
 *
 * A fragment of spans rather than a box of its own, because a row's body is
 * already the box.
 *
 * It does not name the branch. A worktree is nearly always on the branch it is
 * named after, so it was a second copy of the name most of the time and every
 * tab paid width for it. The window's own bar names the branch, and so does a
 * row's title.
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
        state bar -- those already mean "blocked on you" and "done", and a third
        meaning on either would make them argue. */}
    {queued > 0 ? <span className="tab__queued">{queued} queued</span> : null}
  </>
)

export interface WorktreeRowProps {
  worktree: Worktree
  /** Asleep rows wake on click and carry no ×; there is nothing to put away. */
  sleeping: boolean
  sessions: Session[]
  todos: WorktreeTodo[]
  /** The row id that currently has the keyboard, so one row can read as lit. */
  activeId: string | null
  onWake: (worktreeId: string) => void
  onReveal: (worktreeId: string) => void
  onSleep: (worktreeId: string) => void
}

/**
 * One worktree, as a row.
 *
 * It is the top bar's tab and the project pane's list item, which is one
 * component because they are one object met in two places -- a worktree is not
 * a different thing for being listed vertically. Only the container differs,
 * and only in CSS: `.tabgroup` lays these out in a line and the pane's list
 * stacks them, off the same `.tab*` classes.
 *
 * It was a closure inside the top bar's `Group`, and lifting it out cost
 * nothing because it never read anything else -- no ref, no DOM geometry, and
 * nothing about the project. The five things it does need are its props.
 */
export const WorktreeRow = ({
  worktree,
  sleeping,
  sessions,
  todos,
  activeId,
  onWake,
  onReveal,
  onSleep,
}: WorktreeRowProps): React.ReactElement => {
  const queued = queuedTodoCount(todos, worktree.id)
  return (
    <span
      className={[
        'tab',
        sleeping ? 'tab--asleep' : 'tab--awake',
        statusClass(worktreeStatus(sessions, worktree.id)),
        // Where you are. A sleeping worktree is nowhere, whatever the row was
        // last asked for -- it has no window to be in.
        !sleeping && worktree.id === activeId ? 'tab--active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        className="tab__body"
        onClick={() => (sleeping ? onWake(worktree.id) : onReveal(worktree.id))}
        title={[
          worktree.path,
          ...(worktree.branch && worktree.branch !== worktree.name
            ? [`on ${worktree.branch}`]
            : []),
          stateLabel(claudeSession(sessions, worktree.id)),
          ...(worktree.prompt ? [`“${worktree.prompt}”`] : []),
          ...(worktree.dirty
            ? [`${worktree.dirty} uncommitted change${worktree.dirty === 1 ? '' : 's'}`]
            : []),
          ...(worktree.unmerged
            ? [
                `${worktree.unmerged} commit${worktree.unmerged === 1 ? '' : 's'} not on the default branch`,
              ]
            : []),
          ...(queued > 0 ? [`${queued} queued to run next here`] : []),
          sleeping ? 'Asleep — click to wake it' : 'Click to bring its window into view',
        ].join('\n')}
      >
        {/* The state is the bar down the row's leading edge, drawn by `.tab`
            itself rather than by anything in here -- see styles.css. It is on
            every row, asleep or not: sleeping does not mean stopped, Claude can
            be left running, so a sleeper blocked on you has to be able to say
            so. The zZ is the other fact. */}
        {sleeping && (
          <span className="tab__zz" aria-hidden="true">
            zZ
          </span>
        )}
        <span className="tab__label">
          <WorktreeLabel worktree={worktree} queued={queued} />
        </span>
      </button>
      {/* Already asleep, so there is nothing to put away and no × to do it
          with. Waking it is what its body is for. */}
      {!sleeping && (
        <button
          className="tab__close"
          onClick={() => onSleep(worktree.id)}
          title={`Put ${worktree.name} away`}
          aria-label={`Put ${worktree.name} away`}
        >
          &times;
        </button>
      )}
    </span>
  )
}
