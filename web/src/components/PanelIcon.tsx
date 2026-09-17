import type { PanelName } from '@switchboard/shared'

/**
 * A panel's toggle, said in one glyph.
 *
 * The words are what the toggles say wherever there is room -- they are
 * unambiguous and they carry the letter the Cmd legend lights. These are for
 * the widths where the words cost more than they are worth: three of them come
 * to about 200px of a bar that is the whole 390px screen on a phone, and what
 * they take it from is the worktree's own name.
 *
 * Drawn at the chrome's own hairline weight in `currentColor`, like
 * `OpenProjectIcon` and `ForkIcon`, so a toggle's lit and quiet states reach
 * the glyph without a second rule. 16px rather than the fork's 12: these stand
 * where a word stood, not beside one.
 */
export const PanelIcon = ({ panel }: { panel: PanelName }): React.ReactElement => (
  <svg
    className="tile__glyph"
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {panel === 'terminals' && (
      /* A prompt: the chevron and the line you type on, which is what a
         terminal looks like from across a room. */
      <>
        <path d="M2.4 4.2 5.6 7.4 2.4 10.6" />
        <path d="M7.8 11.4h5.8" />
      </>
    )}
    {panel === 'todo' && (
      /* Three lines with one ticked -- a list where something has been done to
         the first item, which is what RUN NEXT does to this one. */
      <>
        <path d="M2.3 4.6 3.6 5.9 6 3.3" />
        <path d="M8.4 4.8h5.3M2.6 9.2h11.1M2.6 12.6h7.6" />
      </>
    )}
    {panel === 'files' && (
      /* A page with its corner turned: the file, not a folder -- the panel
         opens on what changed in one, not on a directory. */
      <>
        <path d="M4 2.3h5l3 3v8.4H4z" />
        <path d="M9 2.4v3.1h3" />
      </>
    )}
  </svg>
)
