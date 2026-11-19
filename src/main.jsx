import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/** Se a interface quebrar, mostra o erro em vez de uma tela vazia. */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error(error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <h1>Algo quebrou na interface</h1>
          <pre>{String(this.state.error?.stack || this.state.error)}</pre>
          <button onClick={() => window.location.reload()}>Recarregar</button>
        </div>
      )
    }
    return this.props.children
  }
}

async function start() {
  // Backend falso para testes no navegador: `vite --mode mock`. Em produção a
  // condição é falsa em tempo de build e o módulo inteiro sai do bundle.
  if (import.meta.env.MODE === 'mock') {
    const { installTauriMock } = await import('./dev/tauri-mock')
    installTauriMock()
  }
  render()
}

function render() {
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  )
}

start()
