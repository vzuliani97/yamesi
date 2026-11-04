import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WakeGate } from './WakeGate';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WakeGate>
      <App />
    </WakeGate>
  </StrictMode>,
);
