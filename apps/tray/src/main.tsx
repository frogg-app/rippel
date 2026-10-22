import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@web/styles/tokens.css';
import './fonts.css';
import './panel.css';
import { App } from './App';

// In a plain browser, frame the panel at its real size so the design can be judged.
if (!('__TAURI_INTERNALS__' in window)) document.documentElement.classList.add('preview');

/** A render error must leave a way out, not a blank panel. */
class Recover extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel">
        <div className="empty">
          <p>Something in this panel broke.</p>
          <p className="small mono">{this.state.error}</p>
          <button className="action" onClick={() => this.setState({ error: null })}>
            Back
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Recover>
      <App />
    </Recover>
  </StrictMode>,
);
