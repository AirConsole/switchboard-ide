import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { TodoView } from '../selectors.js'

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
  onError,
  onDeleting,
}: {
  view: TodoView
  queuedCount: number
  claudeRunning: boolean
  onError: (message: string | null) => void
  /** Say so before deleting, so a vanishing todo is not read as one that ran. */
  onDeleting: (id: string) => void
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
    <div className={queued ? 'todo__row todo__row--queued' : 'todo__row'}>
      <div className="todo__controls">
        <button
          className={queued ? 'todo__next todo__next--on' : 'todo__next'}
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
          {/* The number is a queue position, so it means nothing when this is
              the only thing in the queue. */}
          Run next{queued && queuedCount > 1 ? ` (${position})` : ''}
        </button>
        <button
          className="todo__remove"
          onClick={() => {
            onError(null)
            onDeleting(todo.id)
            void api.deleteTodo(todo.id).catch((err: unknown) => {
              onError(errorText(err))
            })
          }}
          title="Delete this todo"
          aria-label="Delete todo"
        >
          &times;
        </button>
      </div>
      <textarea
        className="todo__prompt"
        ref={grow}
        value={prompt}
        rows={1}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          // Enter is a newline here: this is the text Claude will be given, and
          // it is often several lines.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            abandon.current = true
            event.currentTarget.blur()
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
        }}
      />
      <div className="todo__newfoot">
        <span className="todo__hint">Enter for a new line, Cmd+Enter to add</span>
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
  onQueueDrained,
  focus,
}: TodoPaneProps): React.ReactElement => {
  const [error, setError] = useState<string | null>(null)
  const queued = todos.filter((view) => view.position !== null)
  const queuedCount = queued.length

  /*
   * Close the panel once the last todo has gone.
   *
   * "Gone" has to mean *sent*, which from here looks like a queued todo
   * disappearing -- the server deletes one as it types it in. Two other ways to
   * empty the queue must not close anything: taking a todo out of the queue
   * leaves it in the list, and deleting one by hand is a click that says you
   * are still working in here.
   *
   * And an empty *queue* is not enough either: RUN NEXT on one of five todos
   * emptied the queue and took the panel away with four still written down, in
   * the middle of lining them up. So the list has to be empty too -- the panel
   * goes when there is nothing left in it to look at.
   */
  const queuedIds = queued.map((view) => view.todo.id).join(',')
  const deletedHere = useRef(new Set<string>())
  const previous = useRef<string[]>([])
  useEffect(() => {
    const before = previous.current
    const ids = queuedIds === '' ? [] : queuedIds.split(',')
    previous.current = ids
    if (before.length === 0 || ids.length > 0 || todos.length > 0) return
    const gone = (id: string): boolean => !todos.some((view) => view.todo.id === id)
    if (before.some((id) => gone(id) && !deletedHere.current.has(id))) onQueueDrained()
    // `todos` is read for what is left, and changes with `queuedIds` anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedIds, onQueueDrained])

  return (
    <div className="todo">
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
              onError={setError}
              onDeleting={(id) => deletedHere.current.add(id)}
            />
          ))
        )}
      </div>
      {error !== null && <p className="todo__empty">{error}</p>}
      <NewTodo worktreeId={worktreeId} onError={setError} focus={focus ?? null} />
    </div>
  )
}
