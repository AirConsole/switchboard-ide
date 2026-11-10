/**
 * A project's pane folding into the window beside it, and coming back out.
 *
 * A bar for the window's edge and a chevron towards it (`in`, on the pane:
 * it goes right, into the window) or away from it (`out`, in the window's
 * corner: it comes back out to the left). One shape both ways, so the button
 * that brings the pane back reads as the undo of the one that put it away.
 * Drawn like `PanelIcon`, at the chrome's hairline weight in `currentColor`.
 */
export const FoldIcon = ({ dir }: { dir: 'in' | 'out' }): React.ReactElement => (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {dir === 'in' ? (
      <>
        <path d="M5 4.5 8.5 8 5 11.5" />
        <path d="M12 3v10" />
      </>
    ) : (
      <>
        <path d="M11 4.5 7.5 8 11 11.5" />
        <path d="M4 3v10" />
      </>
    )}
  </svg>
)
