import { Component, type ReactNode } from 'react'

/**
 * Where a render that threw stops, instead of taking the app with it.
 *
 * React unmounts everything above a throw that nothing catches, and there was
 * nothing here to catch one: a viewer that failed to load blanked the whole
 * screen, every terminal included, until the page was reloaded by hand. Placed
 * around the parts that load or parse something they cannot vouch for, so a
 * failure costs that pane and says why.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (error: Error) => ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override render(): ReactNode {
    return this.state.error === null ? this.props.children : this.props.fallback(this.state.error)
  }
}
