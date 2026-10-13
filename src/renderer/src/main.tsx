import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/glass.css'
import './styles/hud.css'
import { App } from './App'

// A file dropped on the window would make the browser navigate to it, replacing the app. Nothing takes drops
// yet, so refuse them. A future drop zone should stop propagation on its own element.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => e.preventDefault())
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
