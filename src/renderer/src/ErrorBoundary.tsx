import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Without this, a thrown error anywhere in the tree unmounts the ENTIRE app
 * with no trace in the UI - exactly what happened here: a bad `topics` field
 * on one Companies-tab row blanked the whole window silently. This catches
 * render errors and shows what broke instead of nothing at all.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[career-watch] render crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="mesh-bg flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-on-surface">
        <h1 className="text-lg font-semibold text-danger">Something went wrong</h1>
        <p className="max-w-md text-sm text-on-surface-variant">
          A tab failed to render. This is a bug — the details below help track it down.
        </p>
        <pre className="mt-2 max-w-lg overflow-x-auto whitespace-pre-wrap rounded-panel bg-surface-container-low p-3 text-left text-xs text-danger">
          {this.state.error.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-2 rounded-pill bg-primary px-4 py-2 text-sm font-medium text-on-primary"
        >
          Try again
        </button>
      </div>
    )
  }
}
