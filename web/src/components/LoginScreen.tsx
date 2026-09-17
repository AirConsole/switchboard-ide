import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { ApiError } from '../api.js'

/**
 * The one screen you see before anything else.
 *
 * **No colour.** The interface is greyscale except for the two questions you
 * scan a row of agents for -- amber means an agent is blocked on you, green
 * means one has finished -- and a typo on a login form is neither. The
 * surprising answer here is said by going bright rather than by going amber,
 * which is the same rule the branch-name hint already follows.
 *
 * It says nothing about the machine: no host name, no server name, no whether a
 * password has been set. An unauthenticated caller learns only that a
 * Switchboard answers here, which the form itself already tells them.
 */
export const LoginScreen = ({ onSignedIn }: { onSignedIn: () => void }): React.ReactElement => {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** Seconds left on the throttle, or 0. Counted down so the wait is legible. */
  const [waitFor, setWaitFor] = useState(0)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
  }, [])

  useEffect(() => {
    if (waitFor <= 0) return
    /*
     * A number ticking down once a second is information, not motion: it
     * answers "is this stuck or is it counting", which is the only question a
     * disabled button raises. The design rule bans animation, not clocks --
     * deliberately noted here so it is not deleted as decoration.
     */
    const timer = window.setTimeout(() => setWaitFor((n) => n - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [waitFor])

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (busy || waitFor > 0 || password === '') return
      setBusy(true)
      setMessage(null)
      try {
        await api.login(password)
        setPassword('')
        onSignedIn()
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          const retry = Number((err.details as { retryAfter?: unknown } | undefined)?.retryAfter)
          setWaitFor(Number.isFinite(retry) && retry > 0 ? retry : 20)
          setMessage('Too many attempts.')
        } else if (err instanceof ApiError && err.status === 503) {
          // The one case worth being specific about, because no amount of
          // typing fixes it and the fix is a command on the machine itself.
          setMessage('No password is set on this server. Run `pnpm password` on it.')
        } else {
          // The same sentence whether the password is wrong or none is set, so
          // the form is not an oracle for which machine is worth attacking.
          setMessage('That is not the password.')
        }
        field.current?.select()
      } finally {
        setBusy(false)
      }
    },
    [busy, onSignedIn, password, waitFor],
  )

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <h1 className="login__title">Switchboard</h1>
        <label className="login__label" htmlFor="swb-password">
          Password
        </label>
        <input
          id="swb-password"
          ref={field}
          className="field__input login__input"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy || waitFor > 0}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button className="btn login__button" type="submit" disabled={busy || waitFor > 0 || password === ''}>
          {busy ? 'Checking' : 'Unlock'}
        </button>
        {(message !== null || waitFor > 0) && (
          <p className="login__hint">
            {message}
            {waitFor > 0 ? ` Try again in ${waitFor}s.` : ''}
          </p>
        )}
      </form>
    </div>
  )
}
