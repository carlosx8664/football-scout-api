import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/base.css' 
import App from './App.tsx'
import SimulationProvider from './components/SimulationProvider.tsx'
import NotificationProvider from './components/NotificationProvider.tsx'
import BankrollProvider from './components/BankrollProvider.tsx'

// Registers the push/caching service worker once on load. Push alerts register it
// lazily as well (`src/lib/push.ts`); re-registering an existing worker is a no-op.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      // Ask for an update on every load so a deploy reaches this tab without a hard refresh.
      .then((registration) => registration.update())
      .catch(() => {
        // Offline caching is a progressive enhancement; the app still works without it.
      })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SimulationProvider>
        <BankrollProvider>
          <NotificationProvider>
            <App />
          </NotificationProvider>
        </BankrollProvider>
      </SimulationProvider>
    </BrowserRouter>
  </StrictMode>,
)