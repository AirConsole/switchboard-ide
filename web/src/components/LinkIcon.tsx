/**
 * A project that lives on a linked machine.
 *
 * It replaced the machine's own name in front of the project's. That name was
 * the only word on the head nobody was scanning for, and it cost the head up
 * to 96px on every linked project -- the width the strip gives up first. The
 * question the head has to answer at a glance is "here or not here", and a
 * glyph answers that; *which* machine is in the title and the accessible name,
 * where it is one hover away.
 *
 * A chain link, because linking is what the open dialog calls it -- the same
 * word for the act and the mark. Drawn like `ForkIcon`: hairlines in
 * currentColor, so it sits in the head's own grey and takes no colour; where a
 * project lives is not one of the two things a row of agents is scanned for.
 */
export const LinkIcon = ({ machine }: { machine: string }): React.ReactElement => (
  <svg
    className="tabgroup__host"
    viewBox="0 0 16 16"
    width={12}
    height={12}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    role="img"
    aria-label={`on ${machine}`}
  >
    {/* Two open links hooked through each other, on the diagonal. */}
    <path d="M6.6 9.4 9.4 6.6" />
    <path d="M7.3 4.4l1.2-1.2a2.8 2.8 0 0 1 4 4l-1.2 1.2" />
    <path d="M8.7 11.6l-1.2 1.2a2.8 2.8 0 0 1-4-4l1.2-1.2" />
  </svg>
)
