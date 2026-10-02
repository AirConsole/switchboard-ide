import type { Worktree } from '@switchboard/shared'

/**
 * What this worktree is about, in the words you asked for it in, and what you
 * have said since.
 *
 * It was one line in the window's bar holding the newest prompt, and after any
 * piece of work the newest prompt is "merge and deploy" -- which says what the
 * worktree was told last and nothing about what it is for. So the task, the
 * newest prompt that set one (`isTask` in shared), gets up to three lines of
 * its own above Claude, and the "yes" and "deploy" that steered it follow on a
 * line beneath, wrapping only once they no longer fit.
 *
 * Above Claude rather than in the bar because three lines do not fit in a bar,
 * and above Claude rather than above the window because Claude is what it
 * describes: an asleep worktree keeps it, a terminal beside it does not repeat
 * it. Gone while the soft keys are up -- see `.taskstrip` -- since a phone with
 * its keyboard open has no height to spend on a reminder.
 *
 * A machine too old to say which prompt was the task sends the newest one only,
 * and that is shown as the task: what the bar used to show, in its new place.
 */
export const TaskStrip = ({ worktree }: { worktree: Worktree }) => {
  const task = worktree.task ?? worktree.prompt
  if (task === undefined) return null
  const followUps = worktree.task === undefined ? [] : (worktree.followUps ?? [])
  return (
    <div className="taskstrip">
      <p className="taskstrip__task" title={task}>
        {task}
      </p>
      {followUps.length > 0 && (
        <ol className="taskstrip__followups">
          {/* Only the newest few travel, so say when there were more before them. */}
          {worktree.earlierFollowUps === true && (
            <li className="taskstrip__followup taskstrip__followup--earlier" title="Earlier follow-ups">
              …
            </li>
          )}
          {followUps.map((followUp, index) => (
            <li key={index} className="taskstrip__followup" title={followUp}>
              {followUp}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
