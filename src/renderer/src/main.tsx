import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

const container = document.getElementById('root')
if (container) {
  // File drag & drop is sanctioned ONLY in the chat panel and the
  // send-files modal. Everywhere else a drop does nothing — and without
  // this guard Chromium would navigate the window to the dropped file.
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => e.preventDefault())

  createRoot(container).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
}
