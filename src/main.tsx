import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/base.css' 
import './styles/dark.css'
import App from './App.tsx'
import SimulationProvider from './components/SimulationProvider.tsx'
import NotificationProvider from './components/NotificationProvider.tsx'
import BankrollProvider from './components/BankrollProvider.tsx'
import ThemeProvider from './components/ThemeProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <SimulationProvider>
          <BankrollProvider>
            <NotificationProvider>
              <App />
            </NotificationProvider>
          </BankrollProvider>
        </SimulationProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
)