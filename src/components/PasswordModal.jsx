import { useState } from 'react'
import { Modal } from './Modal'

export function PasswordModal({ name, wrong, onSubmit, onCancel }) {
  const [value, setValue] = useState('')
  return (
    <Modal onClose={onCancel} labelledBy="pw-title" className="settings">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(value)
        }}
      >
        <header className="modal-head">
          <div>
            <h3 id="pw-title">PDF protegido por senha</h3>
            <p>{name}</p>
          </div>
        </header>
        <div className="form">
          <label>
            Senha do documento
            <input
              data-autofocus
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
            />
          </label>
          {wrong && (
            <p className="msg-error" role="alert">
              Senha incorreta. Tente de novo.
            </p>
          )}
          <p className="form-note">A senha é usada só para ler o arquivo agora e não é gravada.</p>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!value}>
            Abrir
          </button>
        </footer>
      </form>
    </Modal>
  )
}
