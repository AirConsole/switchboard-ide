import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Worktree } from '@switchboard/shared'
import { api } from '../api.js'
import { WorktreeTab } from '../components/WorktreeTab.js'
import { useAnchoredMenu } from '../components/useAnchoredMenu.js'
import { useListKeys } from '../components/useListKeys.js'
import type { TodoView, WorktreeStatus } from '../selectors.js'
import { COMMIT_LABEL } from './keyLegend.js'

/** A worktree a todo can be moved to, with everything its tab needs to say. */
export interface MoveTarget {
  worktree: Worktree
  status: WorktreeStatus
  /** How much is already parked there -- the thing you want to know before adding to it. */
  queued: number
  sleeping: boolean
}

/**
 * What a worktree is going to be asked to do next.
 *
 * A todo is a prompt. RUN NEXT hands it to the server,
 * which types it into this worktree's Claude once Claude has come to rest and
 * then deletes it -- so the queue drains whether or not this browser is open,
 * and a todo that is still here is one that has not been sent.
 *
 * Nothing here fetches. Todos ride the snapshot, and every mutation makes the
 * server broadcast an invalidate which refetches it, so a hook like the changes
 * pane's would only be a second copy of state that can disagree with the first.
 */
export interface TodoPaneProps {
  worktreeId: string
  todos: TodoView[]
  /** Whether this worktree has a live Claude; a queue with none waits. */
  claudeRunning: boolean
  /**
   * Where a todo here can go: this project's own worktrees, this one included --
   * the pane drops itself, so callers do not each have to.
   *
   * This project's and no other. A todo is work on a repository, and another
   * repository's worktrees are not somewhere it could be done; offering them
   * made the list longer with the answers you would never pick, and made it
   * need a heading per project to tell two `main`s apart.
   */
  moveTo: MoveTarget[]
  /**
   * The worktree's last todo has gone to Claude and the list is empty.
   *
   * The panel was opened to line work up; with nothing left in it the pane is a
   * list nobody asked to see, and it is holding a spot in the row.
   */
  onQueueDrained: () => void
  /** Focus the new-todo box when this changes; the row stepped into here. */
  focus?: number | null
}

export interface TodoBarProps {
  todos: TodoView[]
  claudeRunning: boolean
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * A textarea that is exactly as tall as its text.
 *
 * The prompt is the body of the row, and a fixed-height box with its own
 * scrollbar inside a pane that already scrolls is two scrollbars for one piece
 * of text. Re-measured on width too: opening another panel changes this tile's
 * width without anything here re-rendering.
 */
const useAutoGrow = (value: string): React.RefObject<HTMLTextAreaElement | null> => {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const fit = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    /*
     * Plus the border. `scrollHeight` counts padding but not border, while
     * `height` under border-box counts both, so assigning one to the other
     * leaves the box two pixels short of its own text and it scrolls by a
     * line's descender -- measured at 21 against 19.
     */
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }
  useLayoutEffect(fit, [value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
    // Once per mount. Without the array this tore down and rebuilt an observer
    // on every render of every row, which is every keystroke in any of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return ref
}

/**
 * One todo.
 *
 * Both fields are real form controls at rest rather than text that swaps for an
 * input when clicked: clicking then puts the caret where you clicked, there is
 * no remount to lose focus to, and "editable in place" is literally true.
 */
const TodoRow = ({
  view,
  queuedCount,
  claudeRunning,
  moveTo,
  onError,
  onLeaving,
}: {
  view: TodoView
  queuedCount: number
  claudeRunning: boolean
  /** This project's other worktrees, already without this one. */
  moveTo: MoveTarget[]
  onError: (message: string | null) => void
  /**
   * Say so before it goes, so a vanishing todo is not read as one that ran.
   * Deleting one and moving one to another worktree both look, from here,
   * exactly like the server typing it into Claude and dropping it.
   */
  onLeaving: (id: string) => void
}): React.ReactElement => {
  const { todo, position } = view
  /*
   * What is being typed, or null when the server's text is what is shown.
   *
   * Every mutation anywhere in the app refetches the snapshot, so a field bound
   * straight to `todo` loses keystrokes whenever an unrelated change lands
   * mid-sentence. The draft holds until the server echoes it back.
   */
  const [draft, setDraft] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  // Escape has to be able to abandon an edit before the blur it causes saves it,
  // and a blur handler's closure still sees the old draft.
  const abandon = useRef(false)

  const prompt = draft ?? todo.prompt
  const grow = useAutoGrow(prompt)
  const move = useAnchoredMenu<HTMLButtonElement>()
  const runNext = useRef<HTMLButtonElement | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  /*
   * Out of the prompt and onto the row's first action, which is where ← came
   * in from. The blur this causes is what saves the edit (or, after Escape,
   * throws it away), so leaving the text and committing it are one gesture.
   */
  const backToActions = (): void => {
    runNext.current?.focus()
  }

  /*
   * Into the prompt from the actions, with the caret at the end -- where you
   * would be to add to it, which is what going back into a prompt is for.
   */
  const intoPrompt = (): void => {
    const field = grow.current
    if (!field) return
    field.focus()
    const end = field.value.length
    field.setSelectionRange(end, end)
  }

  /*
   * Where the keyboard goes when this row is deleted from under it. Deleting is
   * a click that removes the thing that has focus, and a focus left on nothing
   * is a list the arrows no longer walk -- so it moves first, to the same
   * action on the row below, or above when this was the last, or the box you
   * add the next one in.
   */
  const handOff = (): void => {
    const row = rowRef.current
    if (!row) return
    const pick = (other: Element | null): HTMLElement | null =>
      other?.querySelector<HTMLElement>('.todo__remove') ?? null
    const next =
      pick(row.nextElementSibling) ??
      pick(row.previousElementSibling) ??
      row.closest('.todo')?.querySelector<HTMLElement>('.todo__new .todo__prompt') ??
      null
    next?.focus()
  }

  // The server agreed with what we sent: hand control back to the snapshot.
  useEffect(() => {
    if (sent === null) return
    if (todo.prompt === sent) {
      setSent(null)
      setDraft(null)
    }
  }, [todo.prompt, sent])

  const commit = (): void => {
    if (abandon.current) {
      abandon.current = false
      setDraft(null)
      return
    }
    if (draft === null) return
    const next = draft.trim()
    // An emptied prompt is not a way to delete a todo -- that is what the
    // delete button is for -- so it reverts rather than being refused.
    if (next === '' || next === todo.prompt) {
      setDraft(null)
      return
    }
    setSent(next)
    void api.patchTodo(todo.id, { prompt: next }).catch((err: unknown) => {
      setSent(null)
      setDraft(null)
      onError(errorText(err))
    })
  }

  const queued = position !== null

  return (
    <div className={queued ? 'todo__row todo__row--queued' : 'todo__row'} ref={rowRef}>
      {/*
       * The three things you can do to a todo: the tab strip's own object,
       * stood on end.
       *
       * Square segments inside one rounded shell, seamed 2px in --sleeve. Round
       * pills are each their own object, so a column of them is a column of
       * objects that happen to be near each other; this is one object divided,
       * which is the argument `.tabgroup` already makes about the strip.
       *
       * It is exactly as tall as the three, and does not run down to meet a
       * taller prompt: an empty segment under DELETE is a fourth thing you can
       * do to a todo, drawn and doing nothing.
       */}
      <div
        className="todo__controls"
        onKeyDown={(event) => {
          // ← leaves the actions for the text they act on, which is drawn to
          // their left -- and on a phone, above them, which is still "back".
          if (event.key !== 'ArrowLeft') return
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          event.preventDefault()
          intoPrompt()
        }}
      >
        <button
          ref={runNext}
          className={queued ? 'todo__act todo__next todo__next--on' : 'todo__act todo__next'}
          aria-pressed={queued}
          onClick={() => {
            onError(null)
            void api.patchTodo(todo.id, { queued: !queued }).catch((err: unknown) => {
              onError(errorText(err))
            })
          }}
          title={
            queued
              ? 'Queued: typed into Claude here once it comes to rest. Click to take it out.'
              : 'Queue this to be typed into Claude here once it comes to rest.'
          }
        >
          Run next
          {/* At the segment's far edge, where the caret is, rather than after
              the word: the three labels read down one left edge, and a number
              appearing must not push its own label along. It is a queue
              position, so it means nothing when this is the only thing in the
              queue. */}
          {queued && queuedCount > 1 && <span className="todo__at">{position}</span>}
        </button>
        {/*
         * Where this piece of work actually belongs: RUN NEXT hands the prompt
         * to the agent this todo is already parked against, and this decides
         * which agent that is. The caret is what says it opens a list rather
         * than doing something on the spot.
         */}
        {moveTo.length > 0 && (
          <button
            ref={move.anchor}
            className="todo__act todo__move"
            onClick={move.toggle}
            title="Move this todo to another worktree"
            aria-expanded={move.at !== null}
          >
            Move to
            <span className="todo__caret" aria-hidden="true">
              {'\u25be'}
            </span>
          </button>
        )}
        <button
          className="todo__act todo__remove"
          onClick={(event) => {
            if (document.activeElement === event.currentTarget) handOff()
            onError(null)
            onLeaving(todo.id)
            void api.deleteTodo(todo.id).catch((err: unknown) => {
              onError(errorText(err))
            })
          }}
          title="Delete this todo"
        >
          Delete
        </button>
      </div>
      {move.at !== null && (
        /*
         * The same tabs the top bar draws, stacked -- the sleeping-worktrees
         * dropdown's shape exactly, for the same reason it has it: a worktree
         * met here has to be the object you know from the strip, saying the
         * same things about itself. What is already queued there is on the tab,
         * which is what you want to know before adding to it. Every row is one
         * of this project's own worktrees, so nothing has to say which project
         * it belongs to.
         *
         * The click that moves it is the tab's own; this closes the menu behind
         * it, on the way out so the move has already been asked for.
         */
        <div
          className="menu menu--tabs"
          ref={move.menu}
          style={{ left: move.at.left, top: move.at.top }}
          onClick={move.close}
        >
          {moveTo.map((target) => (
            <WorktreeTab
              key={target.worktree.id}
              worktree={target.worktree}
              status={target.status}
              queued={target.queued}
              sleeping={target.sleeping}
              title={`Move this todo to ${target.worktree.name}`}
              onPick={() => {
                onError(null)
                onLeaving(todo.id)
                void api
                  .patchTodo(todo.id, { worktreeId: target.worktree.id })
                  .catch((err: unknown) => onError(errorText(err)))
              }}
            />
          ))}
        </div>
      )}
      <textarea
        className="todo__prompt"
        ref={grow}
        value={prompt}
        rows={1}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          /*
           * Enter is a newline here: this is the text Claude will be given, and
           * it is often several lines. Cmd+Enter is done -- it saves, and hands
           * the keyboard to RUN NEXT, the thing you most likely edited the
           * prompt in order to do. Escape is the same exit with the edit thrown
           * away.
           */
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            backToActions()
          }
          if (event.key === 'Escape') {
            abandon.current = true
            backToActions()
          }
        }}
      />
      {queued && !claudeRunning && (
        <span className="todo__wait">Waiting for Claude to be running here</span>
      )}
      {todo.lastError !== undefined && <span className="todo__wait">{todo.lastError}</span>}
    </div>
  )
}

/** The add form, which is also what an empty panel shows. */
const NewTodo = ({
  worktreeId,
  onError,
  focus,
}: {
  worktreeId: string
  onError: (message: string | null) => void
  /** Take the keyboard when this changes; the row stepped into this pane. */
  focus: number | null
}): React.ReactElement => {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  /*
   * The same ref the auto-grow uses: it already points at this textarea, so a
   * second one only for focus would be two names for one thing.
   */
  const grow = useAutoGrow(prompt)

  useEffect(() => {
    if (focus === null) return
    grow.current?.focus()
  }, [focus, grow])

  const add = (): void => {
    if (prompt.trim() === '' || busy) return
    setBusy(true)
    onError(null)
    void api
      .createTodo(worktreeId, { prompt: prompt.trim() })
      .then(() => setPrompt(''))
      .catch((err: unknown) => onError(errorText(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="todo__new">
      <textarea
        className="todo__prompt"
        ref={grow}
        value={prompt}
        rows={1}
        placeholder="The prompt to give Claude next"
        spellCheck={false}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) add()
          /*
           * ↑ with the caret at the very start is the one arrow a textarea has
           * no use for, so it means the list above -- the same key the files
           * panel's search box uses for the same thing. Anywhere else in the
           * text it is the caret's.
           */
          if (event.key === 'ArrowUp' && !event.metaKey && !event.ctrlKey && !event.altKey) {
            const field = event.currentTarget
            if (field.selectionStart !== 0 || field.selectionEnd !== 0) return
            const buttons = field
              .closest('.todo')
              ?.querySelectorAll<HTMLElement>('.todo__list .todo__act')
            const last = buttons?.[buttons.length - 1]
            if (!last) return
            event.preventDefault()
            last.focus()
          }
        }}
      />
      <div className="todo__newfoot">
        {/* Cmd on a Mac and Ctrl elsewhere: the handler above takes either, and
            the label is no use to somebody whose keyboard has the other one. */}
        <span className="todo__hint">Enter for a new line, {COMMIT_LABEL}+Enter to add</span>
        {/* The form's own action, so it wears the solid button: the quiet one
            is for dismissing things, and here it read as disabled even when it
            was not. */}
        <button className="btn" onClick={add} disabled={busy || prompt.trim() === ''}>
          Add todo
        </button>
      </div>
    </div>
  )
}

/**
 * The panel's own controls, in the window's bar.
 *
 * Says the one thing the list cannot say when the panel is scrolled or the
 * window is narrow: how much is queued, and whether anything is going to
 * happen to it.
 */
export const TodoBar = ({ todos, claudeRunning }: TodoBarProps): React.ReactElement => {
  const queued = todos.filter((view) => view.position !== null).length
  return (
    <div className="todo__bar">
      {queued > 0 && <span className="todo__count">{queued} queued</span>}
      {queued > 0 && !claudeRunning && <span className="todo__count">waiting for Claude</span>}
    </div>
  )
}

export const TodoPane = ({
  worktreeId,
  todos,
  claudeRunning,
  moveTo,
  onQueueDrained,
  focus,
}: TodoPaneProps): React.ReactElement => {
  const [error, setError] = useState<string | null>(null)
  // Moving a todo to where it already is is not a move; a project with one
  // worktree leaves nothing here, and the button does not draw.
  const elsewhere = moveTo.filter((target) => target.worktree.id !== worktreeId)
  const queued = todos.filter((view) => view.position !== null)
  const queuedCount = queued.length

  /*
   * Close the panel once the last todo has gone.
   *
   * "Gone" has to mean *sent*, which from here looks like a queued todo
   * disappearing -- the server deletes one as it types it in. Three other ways
   * to empty the queue must not close anything: taking a todo out of the queue
   * leaves it in the list, and deleting one by hand or moving the last one to
   * another worktree are both clicks that say you are still working in here --
   * measured, moving a queued todo away took the panel with it and handed the
   * keyboard to a Claude that had been sent nothing.
   *
   * And an empty *queue* is not enough either: RUN NEXT on one of five todos
   * emptied the queue and took the panel away with four still written down, in
   * the middle of lining them up. So the list has to be empty too -- the panel
   * goes when there is nothing left in it to look at.
   */
  const queuedIds = queued.map((view) => view.todo.id).join(',')
  /** Todos this browser sent away itself: deleted, or moved to another worktree. */
  const leftHere = useRef(new Set<string>())
  const previous = useRef<string[]>([])
  useEffect(() => {
    const before = previous.current
    const ids = queuedIds === '' ? [] : queuedIds.split(',')
    previous.current = ids
    if (before.length === 0 || ids.length > 0 || todos.length > 0) return
    const gone = (id: string): boolean => !todos.some((view) => view.todo.id === id)
    if (before.some((id) => gone(id) && !leftHere.current.has(id))) onQueueDrained()
    // `todos` is read for what is left, and changes with `queuedIds` anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedIds, onQueueDrained])

  /*
   * The panel is a list of buttons, walked one button at a time.
   *
   * ↑ and ↓ go to the next action whichever row it is on -- RUN NEXT, MOVE TO,
   * DELETE, then the next todo's RUN NEXT -- because the actions are drawn as
   * one column, and a column is walked down, not across. ← goes into that
   * todo's prompt (see `intoPrompt`), and Cmd+Enter or Escape comes back out
   * onto its RUN NEXT. ↓ past the last action reaches the box you add the next
   * todo in, and ↑ from the start of that box comes back.
   *
   * A row's prompt is not a stop. It is a textarea, where every arrow belongs to
   * the caret, so a walk that stopped in one could not leave it again; you go
   * in with ← and out with Cmd+Enter instead, which says what you meant. The
   * new-todo box is a stop only as the end of the walk, for the same reason:
   * once in it, ↑ at its start is the only arrow that leaves.
   */
  const box = useRef<HTMLDivElement | null>(null)
  useListKeys(box, {
    rows: '.todo__list .todo__act, .todo__new .todo__prompt',
  })

  return (
    <div className="todo" ref={box}>
      {/*
       * The list first and the form under it, the way anything you add to a
       * running list is written: what is already queued reads top to bottom in
       * the order it will go, and the box you type into is the last thing in
       * that order rather than sitting above its own output.
       */}
      <div className="todo__list">
        {todos.length === 0 ? (
          <p className="todo__empty">Nothing queued for this worktree.</p>
        ) : (
          todos.map((view) => (
            <TodoRow
              key={view.todo.id}
              view={view}
              queuedCount={queuedCount}
              claudeRunning={claudeRunning}
              moveTo={elsewhere}
              onError={setError}
              onLeaving={(id) => leftHere.current.add(id)}
            />
          ))
        )}
      </div>
      {error !== null && <p className="todo__empty">{error}</p>}
      <NewTodo worktreeId={worktreeId} onError={setError} focus={focus ?? null} />
    </div>
  )
}
