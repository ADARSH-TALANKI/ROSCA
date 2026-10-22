import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

/**
 * A render error used to tear the whole page down to a blank screen, which is
 * the worst possible thing to happen during a live demonstration. This keeps
 * the failure visible and recoverable instead.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("ChitFund dApp render error:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app">
        <div className="center-note">
          <h2>Something in the interface broke</h2>
          <div style={{ maxWidth: 560, margin: "0 auto", lineHeight: 1.7 }}>
            <p>
              Nothing on the chain is affected, and any bid you have sealed is still
              recoverable. Reload the page and carry on from where you were.
            </p>
            <p style={{ marginTop: 18 }}>
              <button className="btn primary" onClick={() => window.location.reload()}>
                Reload
              </button>
            </p>
            <p className="tiny muted" style={{ marginTop: 22, wordBreak: "break-word" }}>
              {String(this.state.error?.message || this.state.error)}
            </p>
          </div>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
