import { useMemo, useState } from 'react'
import { COLORS, sortAnnotations } from '../lib/annotations'
import { Icon } from './Icons'

export function NotesPanel({ doc, annotations, onUpdate, onDelete, onGoTo, onAsk, onExport, hidden }) {
  const [filter, setFilter] = useState(null)
  const sorted = useMemo(
    () => sortAnnotations(annotations).filter((a) => !filter || a.color === filter),
    [annotations, filter],
  )
  const counts = useMemo(() => {
    const out = {}
    for (const a of annotations) out[a.color] = (out[a.color] || 0) + 1
    return out
  }, [annotations])

  return (
    <aside className="chat notes" hidden={hidden} aria-label="Notas e destaques">
      <div className="chat-head">
        <div>
          <h3>Notas e destaques</h3>
          <p>{doc ? doc.name : ''}</p>
        </div>
        <div className="chat-head-actions">
          <button
            className="icon-btn"
            title="Exportar notas (Markdown)"
            aria-label="Exportar notas em Markdown"
            disabled={!annotations.length}
            onClick={onExport}
          >
            {Icon.download({ className: 'ico' })}
          </button>
        </div>
      </div>

      <div className="notes-filter" role="group" aria-label="Filtrar por cor">
        <button
          className={`chip ${filter === null ? 'on' : ''}`}
          aria-pressed={filter === null}
          onClick={() => setFilter(null)}
        >
          Todas <span>{annotations.length}</span>
        </button>
        {COLORS.map((color) => (
          <button
            key={color.id}
            className={`chip ${filter === color.id ? 'on' : ''}`}
            aria-pressed={filter === color.id}
            aria-label={`${color.name}: ${counts[color.id] || 0}`}
            onClick={() => setFilter(filter === color.id ? null : color.id)}
          >
            <i className="swatch mini" style={{ '--c': color.hex }} />
            <span>{counts[color.id] || 0}</span>
          </button>
        ))}
      </div>

      <div className="messages notes-list">
        {annotations.length === 0 && (
          <p className="muted">Nenhum destaque.</p>
        )}
        {annotations.length > 0 && sorted.length === 0 && <p className="muted">Nada nesta cor.</p>}
        {sorted.map((ann) => (
          <article key={ann.id} className="note-card" style={{ '--c': COLORS.find((c) => c.id === ann.color)?.hex }}>
            <header>
              <button className="note-page" onClick={() => onGoTo(ann)} title="Ir para a página na leitura">
                p.{ann.page}
              </button>
              <span className="note-colors" role="group" aria-label="Cor">
                {COLORS.map((color) => (
                  <button
                    key={color.id}
                    className={`swatch mini ${ann.color === color.id ? 'on' : ''}`}
                    style={{ '--c': color.hex }}
                    aria-label={color.name}
                    aria-pressed={ann.color === color.id}
                    onClick={() => onUpdate(ann.id, { color: color.id })}
                  />
                ))}
              </span>
              <button className="icon-btn subtle" title="Perguntar sobre o trecho" aria-label="Perguntar sobre o trecho" onClick={() => onAsk(ann)}>
                {Icon.quote({ className: 'ico' })}
              </button>
              <button className="icon-btn subtle" title="Excluir" aria-label="Excluir destaque" onClick={() => onDelete(ann.id)}>
                {Icon.trash({ className: 'ico' })}
              </button>
            </header>
            <blockquote onClick={() => onGoTo(ann)}>{ann.text.length > 220 ? `${ann.text.slice(0, 220)}…` : ann.text}</blockquote>
            <textarea
              rows={ann.note ? 2 : 1}
              placeholder="Nota"
              aria-label={`Nota da página ${ann.page}`}
              value={ann.note || ''}
              onChange={(event) => onUpdate(ann.id, { note: event.target.value })}
            />
          </article>
        ))}
      </div>
    </aside>
  )
}
