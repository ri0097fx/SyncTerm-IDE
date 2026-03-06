import React from "react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 子コンポーネントで未捕捉の例外が起きても画面全体を消さず、
 * メッセージと再表示ボタンを出す。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          style={{
            padding: "2rem",
            maxWidth: "600px",
            margin: "2rem auto",
            background: "var(--bg-secondary, #1e1e1e)",
            border: "1px solid var(--border, #333)",
            borderRadius: "8px",
            color: "var(--text, #e5e7eb)"
          }}
        >
          <h3 style={{ marginTop: 0 }}>エラーが発生しました</h3>
          <p style={{ marginBottom: "1rem", wordBreak: "break-all" }}>
            {this.state.error.message}
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            再表示する
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
