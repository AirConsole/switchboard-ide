import { Fragment, useEffect, useMemo, useRef } from 'react'
import type { SyntaxNode } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { api } from '../api.js'

/**
 * CommonMark plus GitHub's four: tables, task lists, strikethrough, autolinks.
 *
 * The parser is `@lezer/markdown`, which is already in the tree -- it is what
 * highlights a Markdown file in the editor next door, through
 * `@codemirror/language-data`. Two parsers for one grammar would be two answers
 * to "is this a heading", and the raw view and the rendered one have to agree.
 */
const markdown = parser.configure(GFM)

/**
 * Punctuation the source wrote and the reader never sees.
 *
 * Only for node types nothing below handles: a `Link`'s own `URL` is read as
 * the href rather than dropped, so the list is consulted last and never first.
 */
const MARKS = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'LinkMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'CodeInfo',
  'LinkTitle',
  'LinkLabel',
  'URL',
  'TaskMarker',
  'TableDelimiter',
])

/** What the renderer needs besides the tree: where the file is, and who to tell. */
interface Ctx {
  text: string
  /** The file's own directory with its trailing slash, `''` at the root. */
  dir: string
  worktreeId: string
  /** Reference definitions, `[1]: https://…`, by their lowercased label. */
  refs: Map<string, string>
  /** Open another file in this panel: what a link into the repository means. */
  onOpen: (path: string) => void
}

const src = (node: SyntaxNode, ctx: Ctx): string => ctx.text.slice(node.from, node.to)

/**
 * A run without the space its marks left behind.
 *
 * `### Third` leaves the space after the hashes in the gap text, and a closing
 * `###` leaves one before it. Invisible on screen, since the browser collapses
 * it, and wrong everywhere else -- the heading's text is what a reader copies.
 */
const trimRun = (parts: React.ReactNode[]): React.ReactNode[] => {
  const out = [...parts]
  const first = out[0]
  if (typeof first === 'string') out[0] = first.replace(/^\s+/, '')
  const last = out[out.length - 1]
  if (typeof last === 'string') out[out.length - 1] = last.replace(/\s+$/, '')
  return out.filter((part) => part !== '')
}

/** What a rendered run says, for the places that need words and not elements. */
const plainText = (parts: React.ReactNode[]): string =>
  parts.filter((part): part is string => typeof part === 'string').join('')

const child = (node: SyntaxNode, name: string): SyntaxNode | null => {
  for (let it = node.firstChild; it !== null; it = it.nextSibling) {
    if (it.name === name) return it
  }
  return null
}

/**
 * A link's target, resolved against the file it was written in.
 *
 * `<...>` wrapping and `%20` are both the source's business and not the
 * reader's, and a malformed escape decodes to itself rather than throwing --
 * this is a file someone was in the middle of editing.
 */
const targetOf = (raw: string): string => {
  const bare = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
  try {
    return decodeURIComponent(bare.trim())
  } catch {
    return bare.trim()
  }
}

/** `a/b/../c.md` -> `a/c.md`, so a relative link names the path git would. */
const resolvePath = (dir: string, ref: string): string => {
  const out: string[] = []
  // A leading slash means the worktree's root here: there is no site to be the
  // root of, and the only other thing it could mean is the whole filesystem.
  const parts = (ref.startsWith('/') ? ref.slice(1) : dir + ref).split('/')
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** Schemes a browser may be handed. Everything else is drawn as its own text. */
const OUTWARD = /^(https?|mailto):/i

/**
 * What a link points at, and therefore what clicking it can do.
 *
 * Three answers, and the third is the interesting one: a relative target is a
 * path in this worktree, so the link opens that file in this same panel. That
 * is what a link between two files in a repository means -- `server/CLAUDE.md`
 * from the root one is the next page, not an address.
 *
 * A fragment on its own is `null`: rendering it as something clickable would
 * promise a jump to a heading this pane does not give its headings ids for.
 */
const hrefOf = (
  node: SyntaxNode,
  ctx: Ctx,
  label: string,
): { kind: 'out'; url: string } | { kind: 'file'; path: string } | null => {
  const url = child(node, 'URL')
  const labelled = child(node, 'LinkLabel')
  const raw =
    url !== null
      ? targetOf(src(url, ctx))
      : (ctx.refs.get((labelled !== null ? src(labelled, ctx).slice(1, -1) : label).toLowerCase()) ??
        '')
  if (raw === '' || raw.startsWith('#')) return null
  if (OUTWARD.test(raw)) return { kind: 'out', url: raw }
  // Any other scheme -- `data:`, `javascript:`, `vscode:` -- is not something
  // this pane hands to the browser. A colon before the first slash is the test
  // a relative path can never accidentally pass.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  const path = resolvePath(ctx.dir, raw.split('#')[0]?.split('?')[0] ?? '')
  return path === '' ? null : { kind: 'file', path }
}

/**
 * The text of everything inside a node, minus its punctuation.
 *
 * The gaps between children are the text: `@lezer/markdown` marks up the
 * delimiters and leaves the words themselves as the space in between, so a
 * renderer that only visited nodes would draw a page of empty tags.
 */
const inlineOf = (node: SyntaxNode, ctx: Ctx): React.ReactNode[] => {
  const out: React.ReactNode[] = []
  let at = node.from
  for (let it = node.firstChild; it !== null; it = it.nextSibling) {
    if (it.from > at) out.push(ctx.text.slice(at, it.from))
    at = Math.max(at, it.to)
    const drawn = inlineNode(it, ctx, out.length)
    if (drawn !== null) out.push(drawn)
  }
  if (node.to > at) out.push(ctx.text.slice(at, node.to))
  return out
}

const inlineNode = (node: SyntaxNode, ctx: Ctx, key: number): React.ReactNode => {
  switch (node.name) {
    case 'Emphasis':
      return <em key={key}>{inlineOf(node, ctx)}</em>
    case 'StrongEmphasis':
      return <strong key={key}>{inlineOf(node, ctx)}</strong>
    case 'Strikethrough':
      return <s key={key}>{inlineOf(node, ctx)}</s>
    case 'InlineCode':
      return (
        <code key={key} className="md__code">
          {inlineOf(node, ctx)}
        </code>
      )
    // The backslash is the mark; what it escaped is the text.
    case 'Escape':
      return src(node, ctx).slice(1)
    case 'HardBreak':
      return <br key={key} />
    case 'Autolink': {
      const url = child(node, 'URL')
      const text = url === null ? src(node, ctx) : src(url, ctx)
      return OUTWARD.test(text) ? (
        <a key={key} className="md__link" href={text} target="_blank" rel="noreferrer noopener">
          {text}
        </a>
      ) : (
        text
      )
    }
    case 'Link': {
      const label = inlineOf(node, ctx)
      const target = hrefOf(node, ctx, plainText(label))
      if (target === null) return <Fragment key={key}>{label}</Fragment>
      if (target.kind === 'out') {
        return (
          <a
            key={key}
            className="md__link"
            href={target.url}
            target="_blank"
            rel="noreferrer noopener"
            title={target.url}
          >
            {label}
          </a>
        )
      }
      return (
        <button
          key={key}
          className="md__link"
          onClick={() => ctx.onOpen(target.path)}
          title={target.path}
        >
          {label}
        </button>
      )
    }
    case 'Image':
      return image(node, ctx, key)
    /*
     * HTML in the file is shown as the HTML it is, never as what it would do.
     *
     * This origin is the one that can type into every running agent, so a
     * `<script>` or an `onerror=` in a file an agent just wrote is not
     * something a preview may hand to the parser. Drawing the source instead
     * needs no sanitiser to be right, and it is also the honest answer: the
     * pane is showing you the file.
     */
    case 'HTMLTag':
    case 'Comment':
    case 'ProcessingInstruction':
      return (
        <code key={key} className="md__raw">
          {src(node, ctx)}
        </code>
      )
    default:
      // Punctuation last: everything above claimed the marks it needed first.
      return MARKS.has(node.name) ? null : <Fragment key={key}>{inlineOf(node, ctx)}</Fragment>
  }
}

/**
 * A picture the file names, drawn only if it is a file in this worktree.
 *
 * In-repo images go through `/raw`, which serves them under a `sandbox` CSP
 * from our own origin -- the same route the files pane already draws a `.png`
 * with, and the same extension table decides what is an image at all.
 *
 * A remote one is drawn as a link instead, deliberately. Fetching a URL a file
 * names is an outbound request the file chose and the reader did not: opening
 * a document would tell whoever wrote it that you opened it, with room in the
 * URL for whatever else it wanted to say. Badges and screenshots are the cost;
 * the link is still there to click.
 *
 * No rev in the URL, unlike the panel's own image view: there is no poll on
 * this file's images to key one off. `/raw` answers `no-store`, so nothing is
 * kept -- a regenerated image is right again the next time the pane mounts.
 */
const image = (node: SyntaxNode, ctx: Ctx, key: number): React.ReactNode => {
  const alt = plainText(inlineOf(node, ctx))
  const target = hrefOf(node, ctx, alt)
  if (target === null) return <Fragment key={key}>{alt}</Fragment>
  if (target.kind === 'out') {
    return (
      <a
        key={key}
        className="md__link"
        href={target.url}
        target="_blank"
        rel="noreferrer noopener"
        title={target.url}
      >
        {alt === '' ? target.url : alt}
      </a>
    )
  }
  return (
    <img
      key={key}
      className="md__image"
      src={api.rawFileUrl(ctx.worktreeId, target.path)}
      alt={alt}
      title={target.path}
    />
  )
}

/** The lines of a code block: its `CodeText`, or the fence's inside. */
const codeOf = (node: SyntaxNode, ctx: Ctx): string => {
  const body = child(node, 'CodeText')
  return body === null ? '' : src(body, ctx)
}

/**
 * The cells of one table row, including the ones that are not there.
 *
 * An empty cell produces no `TableCell` node at all, so collecting the cells
 * would silently shift every column after it left -- measured on
 * `| 1 |  | 3 |`, which parses as cell, delimiter, delimiter, cell. The
 * delimiters are what say where a cell is, so the row is walked as the slots
 * between them, and a slot nothing filled is an empty cell.
 */
const rowCells = (row: SyntaxNode): (SyntaxNode | null)[] => {
  const cells: (SyntaxNode | null)[] = [null]
  let first = true
  let leading = false
  let trailing = false
  for (let it = row.firstChild; it !== null; it = it.nextSibling) {
    if (it.name === 'TableDelimiter') {
      if (first) leading = true
      cells.push(null)
      trailing = true
    } else if (it.name === 'TableCell') {
      cells[cells.length - 1] = it
      trailing = false
    }
    first = false
  }
  // A row written with the outer pipes has an empty slot at each end.
  if (leading) cells.shift()
  if (trailing) cells.pop()
  return cells
}

type Align = 'left' | 'center' | 'right'

/** `| --- | --:| :-: |` -- the one row of a table that is not content. */
const alignOf = (row: SyntaxNode | null, ctx: Ctx): Align[] => {
  if (row === null) return []
  return src(row, ctx)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => {
      const spec = cell.trim()
      if (spec.startsWith(':') && spec.endsWith(':')) return 'center'
      return spec.endsWith(':') ? 'right' : 'left'
    })
}

const HEADINGS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
}

/** Every block child of a container, in order. */
const blocksOf = (node: SyntaxNode, ctx: Ctx): React.ReactNode[] => {
  const out: React.ReactNode[] = []
  for (let it = node.firstChild; it !== null; it = it.nextSibling) {
    const drawn = blockNode(it, ctx, out.length)
    if (drawn !== null) out.push(drawn)
  }
  return out
}

const blockNode = (node: SyntaxNode, ctx: Ctx, key: number): React.ReactNode => {
  const level = HEADINGS[node.name]
  if (level !== undefined) {
    const Tag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[level - 1] ?? 'h1'
    return (
      <Tag key={key} className={`md__h md__h${level}`}>
        {trimRun(inlineOf(node, ctx))}
      </Tag>
    )
  }
  switch (node.name) {
    case 'Paragraph':
      return (
        <p key={key} className="md__p">
          {inlineOf(node, ctx)}
        </p>
      )
    case 'FencedCode':
    case 'CodeBlock':
      return (
        <pre key={key} className="md__pre">
          <code>{codeOf(node, ctx)}</code>
        </pre>
      )
    case 'BulletList':
      return (
        <ul key={key} className="md__list">
          {blocksOf(node, ctx)}
        </ul>
      )
    case 'OrderedList': {
      // The number the author started at, which is the one thing an ordered
      // list can say that its own order cannot.
      const mark = child(node.firstChild ?? node, 'ListMark')
      const start = mark === null ? 1 : Number.parseInt(src(mark, ctx), 10)
      return (
        <ol key={key} className="md__list" start={Number.isFinite(start) ? start : 1}>
          {blocksOf(node, ctx)}
        </ol>
      )
    }
    case 'ListItem':
      // A task item is told apart here rather than in CSS, because the box it
      // draws stands where the bullet would and the bullet has to go.
      return (
        <li key={key} className={child(node, 'Task') === null ? 'md__item' : 'md__item md__item--task'}>
          {blocksOf(node, ctx)}
        </li>
      )
    /*
     * A task is an inline run, not a block: `- [x] done` parses as a `Task`
     * holding the marker and the words, with no paragraph around them. The box
     * is drawn rather than a real checkbox because there is nothing to submit
     * and nothing to tick -- the file is where that is written -- and a native
     * one arrives in the browser's own blue.
     */
    case 'Task': {
      const marker = child(node, 'TaskMarker')
      const done = marker !== null && src(marker, ctx).toLowerCase() !== '[ ]'
      return (
        <Fragment key={key}>
          <span
            className={done ? 'md__check md__check--on' : 'md__check'}
            aria-hidden="true"
          />
          {inlineOf(node, ctx)}
        </Fragment>
      )
    }
    case 'Blockquote':
      return (
        <blockquote key={key} className="md__quote">
          {blocksOf(node, ctx)}
        </blockquote>
      )
    case 'HorizontalRule':
      return <hr key={key} className="md__rule" />
    case 'Table': {
      let align: Align[] = []
      const head: React.ReactNode[] = []
      const body: React.ReactNode[] = []
      for (let it = node.firstChild; it !== null; it = it.nextSibling) {
        if (it.name === 'TableDelimiter') align = alignOf(it, ctx)
      }
      for (let it = node.firstChild; it !== null; it = it.nextSibling) {
        if (it.name !== 'TableHeader' && it.name !== 'TableRow') continue
        const header = it.name === 'TableHeader'
        const cells = rowCells(it).map((cell, column) => {
          const Cell = header ? 'th' : 'td'
          return (
            <Cell key={column} style={{ textAlign: align[column] ?? 'left' }}>
              {cell === null ? '' : inlineOf(cell, ctx)}
            </Cell>
          )
        })
        const row = <tr key={header ? 'head' : body.length}>{cells}</tr>
        if (header) head.push(row)
        else body.push(row)
      }
      return (
        <table key={key} className="md__table">
          {head.length > 0 && <thead>{head}</thead>}
          <tbody>{body}</tbody>
        </table>
      )
    }
    // See the note on inline HTML: shown as the source it is, never parsed.
    case 'HTMLBlock':
    case 'CommentBlock':
    case 'ProcessingInstructionBlock':
      return (
        <pre key={key} className="md__pre md__pre--raw">
          <code>{src(node, ctx)}</code>
        </pre>
      )
    // A definition, not content: `[1]: https://…` is how the links above it
    // were written, and the reader has already been shown its effect.
    case 'LinkReference':
      return null
    default:
      return MARKS.has(node.name) ? null : <Fragment key={key}>{inlineOf(node, ctx)}</Fragment>
  }
}

/** `[label]: url` definitions, which can sit anywhere and be used anywhere. */
const referencesIn = (tree: SyntaxNode, ctx: Ctx): Map<string, string> => {
  const refs = new Map<string, string>()
  const cursor = tree.cursor()
  do {
    if (cursor.name !== 'LinkReference') continue
    const node = cursor.node
    const label = child(node, 'LinkLabel')
    const url = child(node, 'URL')
    if (label === null || url === null) continue
    refs.set(src(label, ctx).slice(1, -1).toLowerCase(), targetOf(src(url, ctx)))
  } while (cursor.next())
  return refs
}

export interface MarkdownProps {
  /** The file's text, exactly as the editor would have been handed it. */
  text: string
  /** Its worktree-relative path, which is what a relative link resolves against. */
  path: string
  worktreeId: string
  /** Open another file in this panel: a link into the repository is a page. */
  onOpen: (path: string) => void
  /**
   * Take the keyboard when this changes, for the reason `CodeEditor` does.
   *
   * Arriving in a panel is arriving, and here that means the page itself: it
   * is the scroller, so a focused one answers the arrows and Page keys. That
   * is the whole of what a rendered file can do with a keyboard, and without
   * it stepping into a document is stepping into something you then have to
   * reach for the mouse to read.
   */
  focus?: number | null
}

/**
 * A Markdown file, rendered.
 *
 * Built out of React elements rather than a string of HTML, which is the whole
 * of why there is no sanitiser here: there is no path by which anything in the
 * file becomes markup. Every piece of it is either a tag this file chose or
 * text, and the two never trade places -- see the note on HTML above.
 *
 * The tree is memoised on the text, so the two-second poll on the open file
 * re-parses only when the file has actually moved.
 */
export const Markdown = ({
  text,
  path,
  worktreeId,
  onOpen,
  focus = null,
}: MarkdownProps): React.ReactElement => {
  const pageRef = useRef<HTMLDivElement | null>(null)
  const body = useMemo(() => {
    const tree = markdown.parse(text).topNode
    const cut = path.lastIndexOf('/')
    const ctx: Ctx = {
      text,
      dir: cut === -1 ? '' : path.slice(0, cut + 1),
      worktreeId,
      refs: new Map(),
      onOpen,
    }
    // Definitions first: a reference link may be written above the definition
    // it uses, and usually is.
    ctx.refs = referencesIn(tree, ctx)
    return blocksOf(tree, ctx)
  }, [text, path, worktreeId, onOpen])

  useEffect(() => {
    if (focus === null) return
    pageRef.current?.focus()
  }, [focus])

  // `tabIndex={-1}`: reachable when the row hands it the keyboard, and not a
  // stop on the way through the panel with Tab, which belongs to the tree.
  return (
    <div className="md" ref={pageRef} tabIndex={-1}>
      {body}
    </div>
  )
}

export default Markdown
