import { Icon } from './Icons'
import { Logo } from './Logo'

export function Sidebar({ docs, currentId, onSelect, onAdd, onDelete, busy }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <div className="brand-text">
          <strong>Margem</strong>
          <span>ler · perguntar · fichar</span>
        </div>
      </div>

      <button className="btn primary block" onClick={onAdd} disabled={!!busy}>
        {Icon.plus({ className: 'ico' })}
        Adicionar PDF
      </button>

      <div className="side-label">Biblioteca</div>
      <ul className="doc-list">
        {docs.map((doc) => (
          <li
            key={doc.id}
            className={`doc-item ${doc.id === currentId ? 'active' : ''}`}
            onClick={() => onSelect(doc.id)}
          >
            <span className="doc-ico">{Icon.doc({ className: 'ico' })}</span>
            <span className="doc-name" title={doc.name}>
              {doc.name}
            </span>
            <button
              className="icon-btn subtle"
              title="Remover"
              onClick={(event) => {
                event.stopPropagation()
                onDelete(doc)
              }}
            >
              {Icon.trash({ className: 'ico' })}
            </button>
          </li>
        ))}
      </ul>
      {docs.length === 0 && <p className="side-empty">Nenhum PDF ainda. Adicione o primeiro.</p>}

      <div className="side-foot">
        <span className="dot" />
        DeepSeek · chave nesta máquina
      </div>
    </aside>
  )
}
