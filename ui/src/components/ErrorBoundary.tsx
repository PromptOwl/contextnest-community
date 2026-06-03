/**
 * ErrorBoundary — turns a render-time crash into a visible message instead
 * of a blank white page. Without this, any thrown error in the component
 * tree unmounts everything and the only trace is in the browser console.
 *
 * The fallback shows the error message + component stack and a reload
 * button, and also logs the full error to the console for copy/paste.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surfaced in the console so the stack is copy/pasteable even after the
    // user dismisses or reloads.
    console.error("[ui] render crash:", error, info.componentStack);
    this.setState({ info });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-2xl w-full space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-destructive">
              Something broke while rendering this page
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              The error below was caught by the app instead of leaving a blank
              screen. Copy it when reporting the problem.
            </p>
          </div>
          <pre className="text-xs bg-muted rounded-md p-3 overflow-auto max-h-40 whitespace-pre-wrap">
            {error.message}
          </pre>
          {info?.componentStack && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Component stack
              </summary>
              <pre className="mt-2 bg-muted rounded-md p-3 overflow-auto max-h-60 whitespace-pre-wrap">
                {info.componentStack}
              </pre>
            </details>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null, info: null })}
              className="px-3 py-1.5 rounded-md border text-sm hover:bg-muted"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 rounded-md border text-sm hover:bg-muted"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
