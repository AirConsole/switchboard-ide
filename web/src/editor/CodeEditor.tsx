import { useEffect, useRef } from 'react'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import {
  Compartment,
  EditorState,
  Prec,
  type ChangeSpec,
  type Extension,
} from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { editorHighlight, editorTheme } from './theme.js'
import { loadedLanguageFor, languageFor } from './language.js'

/** The file as it is on disk. Never the buffer -- see the note on the editor. */
export interface EditorFile {
  path: string
  text: string
}

export interface CodeEditorProps {
  file: EditorFile
  /**
   * Unsaved text to restore into a newly built document, read exactly once.
   *
   * A getter rather than the string, so it cannot be mistaken for a controlled
   * value and is never read during render.
   */
  draft: () => string | null
  onChange: (text: string) => void
  onSave: () => void
  /**
   * Take the keyboard when this changes, and when it is already set at mount.
   *
   * A number rather than a flag, and a prop rather than a ref, for the reasons
   * `TerminalView` gives: the same editor can be asked for twice running, and
   * it may not be mounted when the request arrives -- this one is loaded
   * lazily, so a request can land while its chunk is still in flight. Reading
   * it in an effect is what closes both gaps.
   */
  focus?: number | null
  /**
   * Put the cursor on this line of this file, once per nonce, and scroll it to
   * the middle -- a content search hit being opened. Carries the path because
   * the request arrives before the file does, and must not land on the file
   * that was showing while it loaded.
   */
  goto?: { path: string; line: number; nonce: number } | null
  /**
   * What the editor spends beside the code, whenever it changes: the
   * line-number gutter and the scrollbar.
   *
   * The pane budgets 80 columns *plus* this, and neither part can be a
   * constant. The gutter is as wide as the line count, so a thousand-line
   * file's four digits took the eightieth column -- measured at 79.19. The
   * scrollbar is the platform's: `scrollbar-width: thin` is an overlay of no
   * width in some browsers and a real 11 to 15px in others, so a file that fit
   * here wrapped on a machine whose scrollbars take room. Only this side of
   * the layout can see either, so it hands the sum over and the pane takes it
   * out of the tree beside it.
   */
  onChromeWidth?: (px: number) => void
}

/**
 * The one edit that turns `a` into `b`.
 *
 * Replacing the whole document would be correct and would also throw the cursor
 * to the end of the file, because CodeMirror maps a position inside a replaced
 * range to the end of whatever replaced it. Trimming the common prefix and
 * suffix leaves everything outside the changed region at exactly the offset it
 * already had -- which is the entire point of following a file while reading it.
 *
 * Trimming at a UTF-16 code unit can split a surrogate pair. Harmless: both
 * halves sit inside the replaced range and are re-inserted, so the result is
 * identical either way.
 */
const oneEdit = (a: string, b: string): ChangeSpec | null => {
  if (a === b) return null
  const max = Math.min(a.length, b.length)
  let head = 0
  while (head < max && a.charCodeAt(head) === b.charCodeAt(head)) head++
  let tail = 0
  while (
    tail < max - head &&
    a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)
  ) {
    tail++
  }
  return { from: head, to: a.length - tail, insert: b.slice(head, b.length - tail) }
}

/** How far from its old line number the reader's line is looked for. */
const ANCHOR_SEARCH_LINES = 200

/**
 * Take what is now on disk, and put the cursor back where it was reading.
 *
 * `oneEdit` keeps the cursor by itself whenever the change is one contiguous
 * region that the cursor sits outside of, which is the common case -- an agent
 * rewriting one function. It cannot when a file changes in two places at once,
 * an import added at the top and a function at the bottom, because the single
 * region spanning both swallows everything between them and CodeMirror maps a
 * position inside a replaced range to the end of whatever replaced it.
 *
 * So the line being read is remembered by its text and looked for again,
 * nearest its old number first. That is what a reader means by their place: the
 * line they were on, not an offset into a file that has moved underneath them.
 * When the cursor's own line is what changed there is nothing to anchor to, and
 * the old line number is the honest fallback.
 */
const followDisk = (view: EditorView, text: string): void => {
  const before = view.state.doc.toString()
  const change = oneEdit(before, text)
  if (change === null) return

  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const anchor = line.text
  const column = head - line.from
  const wasAt = line.number

  // No scrollIntoView: following a file must not yank the viewport about.
  view.dispatch({ changes: change })

  const doc = view.state.doc
  let found = 0
  for (let step = 0; step <= ANCHOR_SEARCH_LINES && found === 0; step++) {
    for (const candidate of step === 0 ? [wasAt] : [wasAt - step, wasAt + step]) {
      if (candidate < 1 || candidate > doc.lines) continue
      if (doc.line(candidate).text === anchor) {
        found = candidate
        break
      }
    }
  }
  const target = doc.line(Math.min(Math.max(found === 0 ? wasAt : found, 1), doc.lines))
  view.dispatch({
    selection: { anchor: target.from + Math.min(column, target.length) },
  })
}

/**
 * One CodeMirror view over one file.
 *
 * **Uncontrolled, deliberately.** It is handed the file as it is on disk and
 * reports its buffer back; it is never handed the buffer again. That is what
 * keeps a keystroke from re-rendering the whole tile -- and the tile holds two
 * live terminals.
 *
 * `basicSetup` is not used. In a pane eighty columns wide it would add an
 * autocompletion popup out of nowhere, a second gutter for folding, a search
 * panel that is an entire unstyled UI, and a default highlight style that ours
 * would then have to out-precedence. What is left below is the list that earns
 * its place.
 */
export const CodeEditor = ({
  file,
  draft,
  onChange,
  onSave,
  focus = null,
  goto = null,
  onChromeWidth,
}: CodeEditorProps): React.ReactElement => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** What the view currently shows, so the two kinds of update can be told apart. */
  const shownRef = useRef<EditorFile | null>(null)
  /** The path the newest language request was for; see the reconfigure below. */
  const wantedRef = useRef('')
  /**
   * The view was just built, so the effect below has nothing to follow yet.
   *
   * Both effects run on a mount, in order, and the second one would find the
   * same file it was built from and dispatch the disk text into it -- throwing
   * away the draft the first one had just restored. That is only reachable
   * because an editor can now be unmounted while it is dirty: flipping a
   * Markdown file to Preview and back lost the edit, and the draft went with
   * it, because the write back through `onChange` said the buffer now matched
   * disk.
   */
  const freshRef = useRef(false)
  const language = useRef(new Compartment()).current
  /** The extension list, so swapping to another file can rebuild with it. */
  const extensionsRef = useRef<Extension[] | null>(null)

  // Props are read through refs so the view is built once and never rebuilt
  // because a callback identity changed.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  const draftRef = useRef(draft)
  draftRef.current = draft

  const fileRef = useRef(file)
  fileRef.current = file

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const extensions: Extension[] = [
      /*
       * Save has to win outright, and nothing may reach the browser's own Save
       * dialog. `Prec.highest` puts it ahead of the default keymap, and
       * `preventDefault` is what stops Chrome offering to save the page.
       */
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current()
              return true
            },
          },
        ]),
      ),
      /*
       * Line numbers and wrapping justify each other. Wrapping is right in a
       * pane this narrow -- code is routinely a hundred characters and the
       * alternative is constant horizontal scrolling -- but wrapping alone
       * makes a continuation line indistinguishable from a new statement.
       * CodeMirror numbers logical lines and leaves continuations blank, which
       * resolves exactly that, and it is also how you find the line an agent
       * just named.
       */
      lineNumbers(),
      EditorView.lineWrapping,
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      editorHighlight,
      editorTheme,
      language.of(loadedLanguageFor(fileRef.current.path) ?? []),
      /*
       * Deliberately absent: `closeBrackets` (this pane is for two-character
       * corrections, and an auto-inserted paren is a surprise to undo) and
       * `indentWithTab` (Tab is how you get back out to the file list, which is
       * also CodeMirror's own accessibility advice).
       */
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        // Only on a real change: this fires for every selection move too, and
        // `toString()` on a large document is not free.
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      }),
    ]

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: draftRef.current() ?? fileRef.current.text,
        extensions,
      }),
    })
    viewRef.current = view
    shownRef.current = fileRef.current
    extensionsRef.current = extensions
    freshRef.current = true

    return () => {
      view.destroy()
      viewRef.current = null
      shownRef.current = null
    }
    // Built once. Everything that changes afterwards is dispatched into it.
  }, [language])

  /*
   * Two ways the document changes, and they are not the same thing.
   *
   * A different file gets a whole new state, because carrying the history
   * across files would let Cmd+Z undo one file's contents into another's --
   * data loss, not an inconvenience. The same file that moved on disk gets the
   * smallest edit that turns what is shown into what is there, with no
   * `scrollIntoView`, so neither the cursor nor the scroll offset moves.
   */
  useEffect(() => {
    const view = viewRef.current
    const shown = shownRef.current
    if (!view || !shown) return
    // Built from this very file a moment ago, draft and all; see `freshRef`.
    if (freshRef.current) {
      freshRef.current = false
      return
    }

    if (shown.path !== file.path) {
      const extensions = extensionsRef.current ?? []
      view.setState(EditorState.create({ doc: draft() ?? file.text, extensions }))
      view.dispatch({ effects: language.reconfigure(loadedLanguageFor(file.path) ?? []) })
    } else if (draft() === null) {
      followDisk(view, file.text)
    }
    /*
     * Not while there is an unsaved edit, which is the rule the poll behind
     * this already keeps: *the document you are editing must not be rewritten
     * underneath you.* The poll stops asking once there is a draft, so this
     * only fires on the path the poll cannot see -- an editor **remounted**
     * onto a file it is already holding edits for, where `file` is a fresh
     * object with the same path and the same disk text. Following it there
     * replaced the draft the editor had just been created with, and the
     * resulting update reported a document identical to disk, which is how the
     * edit was thrown away rather than kept: measured, 608 characters typed and
     * 602 written back, one frame later.
     */
    shownRef.current = file
    // `draft` is read once per document, on purpose; it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, language])

  /*
   * The grammar, once it has been fetched.
   *
   * The token guards the obvious race: two quick file switches, and the slower
   * of the two loads lands last and would otherwise highlight the open file
   * with the wrong language.
   */
  useEffect(() => {
    wantedRef.current = file.path
    if (loadedLanguageFor(file.path) !== null) return
    void languageFor(file.path).then((support) => {
      const view = viewRef.current
      if (!view || support === null || wantedRef.current !== file.path) return
      view.dispatch({ effects: language.reconfigure(support) })
    })
  }, [file.path, language])

  /*
   * After the effect that swaps documents, so the line is looked for in the
   * file it names rather than the one it replaced.
   */
  const wentTo = useRef<number | null>(null)
  useEffect(() => {
    const view = viewRef.current
    if (!view || goto === null || goto.path !== file.path || wentTo.current === goto.nonce) return
    wentTo.current = goto.nonce
    const doc = view.state.doc
    const line = doc.line(Math.min(Math.max(goto.line, 1), doc.lines))
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
  }, [goto, file])

  /*
   * The gutter and the scrollbar, measured rather than assumed -- see
   * `onChromeWidth`.
   *
   * An observer, because both change without React: a file's line count is the
   * document's, so the gutter widens past a thousand lines and narrows when
   * another file is dispatched into the same view, and the scrollbar arrives
   * the moment a document is taller than the pane. The scroller's content box
   * is what a scrollbar takes room out of, which is why observing it catches
   * one appearing; `getBoundingClientRect` for the gutter's fractional width,
   * since flooring here would cost the column this exists to protect.
   */
  const chromeRef = useRef(onChromeWidth)
  chromeRef.current = onChromeWidth
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const gutters = host.querySelector('.cm-gutters')
    const scroller = host.querySelector<HTMLElement>('.cm-scroller')
    if (!gutters || !scroller) return
    const report = (): void =>
      chromeRef.current?.(
        gutters.getBoundingClientRect().width + (scroller.offsetWidth - scroller.clientWidth),
      )
    report()
    // jsdom has no ResizeObserver, and a test that mounts an editor is not
    // testing the layout: the one measurement above still happens there.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(gutters)
    observer.observe(scroller)
    return () => observer.disconnect()
    // The host holds one view for its lifetime, and the view keeps one gutters
    // and one scroller across documents, so this subscribes once.
  }, [file.path])

  /*
   * Declared after the effect that builds the view, so on a fresh mount there
   * is something to focus by the time this runs.
   */
  useEffect(() => {
    if (focus === null) return
    viewRef.current?.focus()
  }, [focus])

  return <div className="files__cm" ref={hostRef} />
}

export default CodeEditor
