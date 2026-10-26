import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/base.css' 
import App from './App.tsx'
import SimulationProvider from './components/SimulationProvider.tsx'
import NotificationProvider from './components/NotificationProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SimulationProvider>
        <NotificationProvider>
          <App />
        </NotificationProvider>
      </SimulationProvider>
    </BrowserRouter>
  </StrictMode>,
)