import { useMemo, useState } from 'react'
import { Icon } from './Icons'
import { Logo } from './Logo'
import { shortcut } from '../lib/platform'

export function Sidebar({ docs, currentId, onSelect, onAdd, onDelete, busy, dragging }) {
  const [filter, setFilter] = useState('')
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? docs.filter((doc) => doc.name.toLowerCase().includes(q)) : docs
  }, [docs, filter])

  return (
    <aside className="sidebar" aria-label="Biblioteca">
      <div className="brand">
        <Logo />
        <div className="brand-text">
          <strong>Margem</strong>
          <span>ler · perguntar · fichar</span>
        </div>
      </div>

      <button
        className="btn primary block"
        // Sem a arrow, o clique entregaria o evento como "caminho do arquivo".
        onClick={() => onAdd()}
        disabled={!!busy}
        title={`Adicionar PDF (${shortcut('O')})`}
      >
        {Icon.plus({ className: 'ico' })}
        Adicionar PDF
      </button>

      <div className="side-label">Biblioteca</div>
      {docs.length > 6 && (
        <input
          className="side-filter"
          type="search"
          placeholder="Filtrar PDFs…"
          aria-label="Filtrar PDFs"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <ul className="doc-list">
        {shown.map((doc) => (
          <li key={doc.id} className={`doc-item ${doc.id === currentId ? 'active' : ''}`}>
            <button
              className="doc-select"
              onClick={() => onSelect(doc.id)}
              aria-current={doc.id === currentId ? 'true' : undefined}
              title={doc.name}
            >
              <span className="doc-ico">{Icon.doc({ className: 'ico' })}</span>
              <span className="doc-name">{doc.name}</span>
              {doc.page_count === 0 && <span className="doc-flag">sem texto</span>}
            </button>
            <button
              className="icon-btn subtle"
              title="Remover"
              aria-label={`Remover ${doc.name}`}
              onClick={() => onDelete(doc)}
            >
              {Icon.trash({ className: 'ico' })}
            </button>
          </li>
        ))}
      </ul>
      {docs.length === 0 && (
        <p className="side-empty">
          Nenhum PDF ainda. Adicione o primeiro ou arraste um arquivo para esta janela.
        </p>
      )}
      {docs.length > 0 && shown.length === 0 && <p className="side-empty">Nenhum PDF com esse nome.</p>}
      {dragging && <div className="drop-hint">Solte o PDF para adicionar</div>}

      <div className="side-foot">
        <span className="dot" />
        DeepSeek · chave nesta máquina
      </div>
    </aside>
  )
}
