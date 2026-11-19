import { useState } from 'react'
import { api } from '../api'
import { Icon } from './Icons'

export function SettingsModal({ settings, onClose, onSaved }) {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings?.model || 'deepseek-flash')
  const [baseUrl, setBaseUrl] = useState(settings?.base_url || 'https://api.deepseek.com')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setSaving(true)
    setError('')
    try {
      const next = await api.saveSettings({
        apiKey: apiKey.trim() || null,
        model,
        baseUrl,
      })
      onSaved(next)
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h3>Configurações</h3>
            <p>A chave fica no banco local, nesta máquina.</p>
          </div>
          <button className="icon-btn" onClick={onClose}>
            {Icon.close({ className: 'ico' })}
          </button>
        </header>

        <div className="form">
          <label>
            Chave da API DeepSeek
            <input
              type="password"
              placeholder={settings?.has_key ? 'já configurada · deixe em branco para manter' : 'sk-...'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Modelo
            <input value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
          <label>
            Base URL (compatível com OpenAI)
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <p className="form-note">
            Custo estimado: um artigo de 40 páginas gasta cerca de US$ 0,005 na primeira pergunta e menos de
            US$ 0,001 nas seguintes, por causa do cache de contexto.
          </p>
          {error && <p className="msg-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </footer>
      </div>
    </div>
  )
}
