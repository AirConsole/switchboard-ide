import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { TodoView } from '../selectors.js'

/**
 * What a worktree is going to be asked to do next.
 *
 * A todo is a prompt with an optional title. RUN NEXT hands it to the server,
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
  })
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
}: {
  view: TodoView
  queuedCount: number
  claudeRunning: boolean
  onError: (message: string | null) => void
}): React.ReactElement => {
  const { todo, position } = view
  /*
   * What is being typed, or null when the server's text is what is shown.
   *
   * Every mutation anywhere in the app refetches the snapshot, so a field bound
   * straight to `todo` loses keystrokes whenever an unrelated change lands
   * mid-sentence. The draft holds until the server echoes it back.
   */
  const [draft, setDraft] = useState<{ title: string; prompt: string } | null>(null)
  const [sent, setSent] = useState<{ title: string; prompt: string } | null>(null)
  // Escape has to be able to abandon an edit before the blur it causes saves it,
  // and a blur handler's closure still sees the old draft.
  const abandon = useRef(false)

  const title = draft?.title ?? todo.title ?? ''
  const prompt = draft?.prompt ?? todo.prompt
  const grow = useAutoGrow(prompt)

  // The server agreed with what we sent: hand control back to the snapshot.
  useEffect(() => {
    if (sent === null) return
    if ((todo.title ?? '') === sent.title && todo.prompt === sent.prompt) {
      setSent(null)
      setDraft(null)
    }
  }, [todo.title, todo.prompt, sent])

  const commit = (): void => {
    if (abandon.current) {
      abandon.current = false
      setDraft(null)
      return
    }
    if (draft === null) return
    const nextTitle = draft.title.trim()
    const nextPrompt = draft.prompt.trim()
    // An emptied prompt is not a way to delete a todo -- that is what the
    // delete button is for -- so it reverts rather than being refused.
    if (nextPrompt === '') {
      setDraft(null)
      return
    }
    if (nextTitle === (todo.title ?? '') && nextPrompt === todo.prompt) {
      setDraft(null)
      return
    }
    setSent({ title: nextTitle, prompt: nextPrompt })
    void api
      .patchTodo(todo.id, { title: nextTitle === '' ? null : nextTitle, prompt: nextPrompt })
      .catch((err: unknown) => {
        setSent(null)
        setDraft(null)
        onError(errorText(err))
      })
  }

  const edit = (patch: Partial<{ title: string; prompt: string }>): void =>
    setDraft({ title, prompt, ...patch })

  const queued = position !== null

  return (
    <div className={queued ? 'todo__row todo__row--queued' : 'todo__row'}>
      <input
        className="todo__title"
        value={title}
        placeholder="Untitled"
        spellCheck={false}
        onChange={(event) => edit({ title: event.target.value })}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            abandon.current = true
            event.currentTarget.blur()
          }
        }}
      />
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
        onChange={(event) => edit({ prompt: event.target.value })}
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
}: {
  worktreeId: string
  onError: (message: string | null) => void
}): React.ReactElement => {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const grow = useAutoGrow(prompt)

  const add = (): void => {
    if (prompt.trim() === '' || busy) return
    setBusy(true)
    onError(null)
    void api
      .createTodo(worktreeId, { title: title.trim() || undefined, prompt: prompt.trim() })
      .then(() => {
        setTitle('')
        setPrompt('')
      })
      .catch((err: unknown) => onError(errorText(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="todo__new">
      <input
        className="todo__title"
        value={title}
        placeholder="Title (optional)"
        spellCheck={false}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') add()
        }}
      />
      <textarea
        className="todo__prompt"
        ref={grow}
        value={prompt}
        rows={1}
        placeholder="What should Claude do next here?"
        spellCheck={false}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) add()
        }}
      />
      <div className="todo__newfoot">
        <span className="todo__hint">Enter for a new line, Cmd+Enter to add</span>
        <button className="btn btn--quiet" onClick={add} disabled={busy || prompt.trim() === ''}>
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
}: TodoPaneProps): React.ReactElement => {
  const [error, setError] = useState<string | null>(null)
  const queuedCount = todos.filter((view) => view.position !== null).length

  return (
    <div className="todo">
      <NewTodo worktreeId={worktreeId} onError={setError} />
      {error !== null && <p className="todo__empty">{error}</p>}
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
            />
          ))
        )}
      </div>
    </div>
  )
}
