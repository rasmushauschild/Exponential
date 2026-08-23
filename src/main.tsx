import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

if ((window as Window & { exponential?: { platform: string } }).exponential?.platform === 'darwin') document.documentElement.classList.add('mac-window');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
