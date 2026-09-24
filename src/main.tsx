import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Widget from './Widget';
import './styles.css';

if ((window as Window & { exponential?: { platform: string } }).exponential?.platform === 'darwin') document.documentElement.classList.add('mac-window');

// Hosted web app: register the push service worker (Electron has native notifications).
if (!(window as Window & { exponential?: unknown }).exponential && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}

const isWidget = new URLSearchParams(location.search).get('mode') === 'widget';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isWidget ? <Widget /> : <App />}
  </StrictMode>,
);
