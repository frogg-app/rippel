import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@web/styles/tokens.css';
import './fonts.css';
import './panel.css';
import { App } from './App';

// In a plain browser, frame the panel at its real size so the design can be judged.
if (!('__TAURI_INTERNALS__' in window)) document.documentElement.classList.add('preview');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
