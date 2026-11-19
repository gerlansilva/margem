import { useState } from 'react'
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
import { api, errorText } from '../api'
import { Icon } from './Icons'
import { Modal } from './Modal'

/** Onde a chave em uso está guardada, em texto para o usuário. */
export function keyStatus(settings) {
  const source = settings?.key_source || (settings?.has_key ? 'file' : 'none')
  const macOs = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')
  const vault = macOs ? 'Keychain' : 'Credential Manager'
  switch (source) {
    case 'keychain':
      return { source, tone: 'ok', text: `Guardada no ${vault}.` }
    case 'env':
      return { source, tone: 'ok', text: 'Vinda de DEEPSEEK_API_KEY.' }
    case 'file':
      return {
        source,
        tone: 'warn',
        text: settings?.secure_storage
          ? 'Guardada em arquivo local. Salve de novo para mover ao cofre do sistema.'
          : 'Guardada em arquivo local; o cofre do sistema não está disponível.',
      }
    default:
      return { source: 'none', tone: 'none', text: 'Sem chave.' }
  }
}

export function SettingsModal({ settings, indexLabel = '', onClose, onSaved, onNotify }) {
  const [removing, setRemoving] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [model, setModel] = useState(settings?.model || 'deepseek-flash')
  const [baseUrl, setBaseUrl] = useState(settings?.base_url || 'https://api.deepseek.com')
  const [embedUrl, setEmbedUrl] = useState(settings?.embed_base_url || '')
  const [embedModel, setEmbedModel] = useState(settings?.embed_model || '')
  const [embedKey, setEmbedKey] = useState('')
  const [email, setEmail] = useState(settings?.openalex_email || '')
  const [saving, setSaving] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [error, setError] = useState('')

  /** Valida e grava tudo; devolve as configurações novas ou null se algo falhou. */
  async function persist() {
    const url = baseUrl.trim()
    if (!/^https?:\/\//i.test(url)) {
      setError('A URL base precisa começar com http:// ou https://')
      return null
    }
    const eurl = embedUrl.trim()
    if (eurl && !/^https?:\/\//i.test(eurl)) {
      setError('A URL dos embeddings precisa começar com http:// ou https://')
      return null
    }
    setError('')
    const next = await api.saveSettings({
      apiKey: apiKey.trim() || null,
      model: model.trim() || 'deepseek-flash',
      baseUrl: url,
      embedBaseUrl: eurl,
      embedModel: embedModel.trim(),
      embedKey: embedKey.trim() || null,
      openalexEmail: email.trim(),
    })
    setApiKey('')
    setEmbedKey('')
    onSaved(next)
    return next
  }

  async function save(event) {
    event?.preventDefault()
    setSaving(true)
    try {
      if (await persist()) onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  async function reindex() {
    setReindexing(true)
    try {
      if (!(await persist())) return
      await api.reindex()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setReindexing(false)
    }
  }

  const status = keyStatus(settings)

  async function removeKey() {
    const ok = await confirmDialog('Remover a chave da API deste computador?', {
      title: 'Remover chave',
      kind: 'warning',
    }).catch(() => false)
    if (!ok) return
    setRemoving(true)
    setError('')
    try {
      const next = await api.clearApiKey()
      onSaved(next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="settings-title" className="settings">
      <form onSubmit={save}>
        <header className="modal-head">
          <div>
            <h3 id="settings-title">Configurações</h3>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
            {Icon.close({ className: 'ico' })}
          </button>
        </header>

        <div className="form">
          <label>
            Chave da API
            <span className="input-row">
              <input
                data-autofocus
                type={showKey ? 'text' : 'password'}
                placeholder={settings?.has_key ? 'Manter a atual' : 'sk-...'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn tiny"
                onClick={() => setShowKey((v) => !v)}
                aria-pressed={showKey}
              >
                {showKey ? 'Ocultar' : 'Mostrar'}
              </button>
            </span>
          </label>
          <p className={`key-status ${status.tone}`} data-testid="key-status" role="status">
            {status.text}
            {(status.source === 'keychain' || status.source === 'file') && (
              <button type="button" className="link-btn" onClick={removeKey} disabled={removing}>
                {removing ? 'Removendo…' : 'Remover chave'}
              </button>
            )}
          </p>
          <label>
            Modelo
            <input value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
          </label>
          <label>
            URL base
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
          </label>
          <fieldset className="form-group">
            <legend>Busca por significado (opcional)</legend>
            <label>
              URL
              <input
                value={embedUrl}
                placeholder="http://localhost:11434/v1"
                onChange={(event) => setEmbedUrl(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              Modelo
              <input
                value={embedModel}
                placeholder="nomic-embed-text"
                onChange={(event) => setEmbedModel(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              Chave
              <input
                type="password"
                value={embedKey}
                placeholder={settings?.embed_key_set ? 'Manter a atual' : 'Opcional'}
                onChange={(event) => setEmbedKey(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <span className="form-inline">
              <button type="button" className="btn tiny" onClick={reindex} disabled={reindexing || saving}>
                {reindexing ? 'Salvando…' : 'Reindexar'}
              </button>
              {indexLabel && (
                <span className="form-hint" role="status" data-testid="settings-index">
                  {indexLabel}
                </span>
              )}
            </span>
          </fieldset>
          <fieldset className="form-group">
            <legend>OpenAlex</legend>
            <label>
              E-mail
              <input
                type="email"
                value={email}
                placeholder="voce@universidade.br"
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                spellCheck={false}
              />
            </label>
          </fieldset>
          {error && (
            <p className="msg-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
