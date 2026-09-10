/**
 * Commits here that the default branch has not.
 *
 * The fork glyph, because that is what it means: this branch has gone its own
 * way and nothing has brought it back yet. It stands where the dirty count
 * stands and only when there is none -- committed work and uncommitted work are
 * the same question, "is there anything of yours still in here", and the count
 * is the more urgent of the two answers.
 *
 * Hairlines at the chrome's own weight in currentColor, so it sits in whatever
 * quiet channel its neighbours are in -- the counts on a tab, the toggle's own
 * label in a window's bar -- rather than shouting from it. It is drawn in two
 * places for one reason: the tab and the Files toggle are both answering "is
 * there anything left in this worktree", so they have to answer it in the same
 * glyph or the reader has to learn two.
 */
export const ForkIcon = ({
  className,
  size = 14,
}: {
  className: string
  /** Sized to the text beside it: 14 against the tab's 13, 12 against the
      toggle's 11. */
  size?: number
}): React.ReactElement => (
  <svg
    className={className}
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    aria-hidden="true"
  >
    {/*
      Two heads above a shared trunk: GitHub's `repo-forked` way up, which is
      the one people have seen ten thousand times. It was drawn upside down --
      trunk at the top, splitting downwards -- on the argument that a fork
      diverging reads better going down; rotated 180° here, coordinates and
      arc sweeps both, rather than with a `transform`, so what the file says
      is what is on screen.
    */}
    <circle cx="4.4" cy="3.6" r="1.7" />
    <circle cx="11.6" cy="3.6" r="1.7" />
    <circle cx="8" cy="12.4" r="1.7" />
    <path d="M8 9.3v1.4" />
    <path d="M4.4 5.3v1.3a2.7 2.7 0 0 0 2.7 2.7h1.8a2.7 2.7 0 0 0 2.7-2.7V5.3" />
  </svg>
)
