import { Modal } from './Modal'
import { Icon } from './Icons'
import { shortcut } from '../lib/platform'

export function shortcutList() {
  return [
    ['Adicionar PDF', shortcut('O')],
    ['Buscar no documento', shortcut('F')],
    ['Próximo / anterior resultado', 'Enter / Shift+Enter'],
    ['Perguntar ao assistente', shortcut('K')],
    ['Leitura / Fichamento', `${shortcut('1')} / ${shortcut('2')}`],
    ['Configurações', shortcut(',')],
    ['Ver atalhos', shortcut('/')],
    ['Parar a resposta · fechar', 'Esc'],
    ['Salvar nota', shortcut('Enter')],
    ['Renomear documento', 'F2'],
  ]
}

export function ShortcutsModal({ onClose }) {
  return (
    <Modal onClose={onClose} labelledBy="sc-title" className="settings">
      <header className="modal-head">
        <div>
          <h3 id="sc-title">Atalhos de teclado</h3>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar">
          {Icon.close({ className: 'ico' })}
        </button>
      </header>
      <dl className="shortcuts">
        {shortcutList().map(([label, keys]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <kbd>{keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
