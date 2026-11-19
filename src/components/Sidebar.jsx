import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'
import { Logo } from './Logo'
import { isMac, shortcut } from '../lib/platform'

const differs = (doc) => !!doc.original_title && doc.original_title !== doc.name

function ContextMenu({ menu, onClose, onRename, onRestore, onDelete }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
    const away = (event) => {
      if (!ref.current?.contains(event.target)) onClose()
    }
    const key = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const items = [...ref.current.querySelectorAll('button')]
        const at = items.indexOf(document.activeElement)
        items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  const { doc } = menu
  // Portal: o backdrop-filter da barra lateral prenderia o menu "fixo" dentro dela.
  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={doc.name}
      style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 130) }}
    >
      <button role="menuitem" onClick={() => onRename(doc)}>
        Renomear <kbd>{isMac ? '↩' : 'F2'}</kbd>
      </button>
      {differs(doc) && (
        <button role="menuitem" onClick={() => onRestore(doc)}>
          Restaurar original
        </button>
      )}
      <button role="menuitem" className="danger" onClick={() => onDelete(doc)}>
        Remover
      </button>
    </div>,
    document.body,
  )
}

export function Sidebar({
  docs,
  currentId,
  onSelect,
  onAdd,
  onDelete,
  onRename,
  selectedIds,
  onToggleSelect,
  onClearSelection,
  busy,
  dragging,
}) {
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState(null) // { id, value }
  const [menu, setMenu] = useState(null)
  const finished = useRef(false)
  const listRef = useRef(null)
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? docs.filter((doc) => doc.name.toLowerCase().includes(q)) : docs
  }, [docs, filter])

  function startEdit(doc) {
    setMenu(null)
    finished.current = false
    setEditing({ id: doc.id, value: doc.name })
  }

  function refocus(id) {
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-doc="${id}"] .doc-select`)?.focus())
  }

  async function commit(doc) {
    if (finished.current) return
    finished.current = true
    const title = (editing?.value || '').trim()
    setEditing(null)
    if (title && title !== doc.name) await onRename(doc, title)
    refocus(doc.id)
  }

  function cancel(doc) {
    finished.current = true
    setEditing(null)
    refocus(doc.id)
  }

  async function restore(doc) {
    setMenu(null)
    finished.current = true
    setEditing(null)
    await onRename(doc, doc.original_title)
    refocus(doc.id)
  }

  return (
    <aside className="sidebar" aria-label="Biblioteca">
      <div className="brand">
        <Logo />
        <strong>Margem</strong>
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

      {selectedIds.length > 0 && (
        <div className="side-sel" role="status">
          <span>
            {selectedIds.length} {selectedIds.length === 1 ? 'selecionado' : 'selecionados'}
          </span>
          <button className="link-btn" onClick={onClearSelection}>
            Limpar
          </button>
        </div>
      )}
      {docs.length > 6 && (
        <input
          className="side-filter"
          type="search"
          placeholder="Filtrar"
          aria-label="Filtrar PDFs"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <ul className={`doc-list ${selectedIds.length ? 'has-selection' : ''}`} ref={listRef} aria-label="Documentos">
        {shown.map((doc) => {
          const isEditing = editing?.id === doc.id
          const selected = selectedIds.includes(doc.id)
          return (
            <li
              key={doc.id}
              data-doc={doc.id}
              className={`doc-item ${doc.id === currentId ? 'active' : ''} ${selected ? 'selected' : ''}`}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ doc, x: event.clientX, y: event.clientY })
              }}
            >
              <label className="doc-check">
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={doc.page_count === 0}
                  aria-label={`Selecionar ${doc.name}`}
                  onChange={() => onToggleSelect(doc.id)}
                />
                <span className="doc-ico">{Icon.doc({ className: 'ico' })}</span>
                <span className="doc-box">{Icon.check({ className: 'ico' })}</span>
              </label>
              {isEditing ? (
                <span className="doc-rename-wrap">
                  <input
                    className="doc-rename"
                    aria-label="Título do documento"
                    autoFocus
                    value={editing.value}
                    spellCheck={false}
                    onFocus={(event) => event.target.select()}
                    onChange={(event) => setEditing({ id: doc.id, value: event.target.value })}
                    onBlur={() => commit(doc)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commit(doc)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        cancel(doc)
                      }
                    }}
                  />
                </span>
              ) : (
                <button
                  className="doc-select"
                  onClick={() => onSelect(doc.id)}
                  onDoubleClick={() => startEdit(doc)}
                  onKeyDown={(event) => {
                    if (event.key === 'F2' || (isMac && event.key === 'Enter' && !event.repeat)) {
                      event.preventDefault()
                      startEdit(doc)
                    }
                  }}
                  aria-current={doc.id === currentId ? 'true' : undefined}
                  title={doc.name}
                >
                  <span className="doc-name">{doc.name}</span>
                  {doc.page_count === 0 && <span className="doc-flag">sem texto</span>}
                </button>
              )}
              {!isEditing && (
                <span className="doc-actions">
                  {differs(doc) && (
                    <button
                      className="icon-btn subtle"
                      title={`Restaurar “${doc.original_title}”`}
                      aria-label={`Restaurar o título original de ${doc.name}`}
                      onClick={() => restore(doc)}
                    >
                      {Icon.undo({ className: 'ico' })}
                    </button>
                  )}
                  <button
                    className="icon-btn subtle"
                    title="Renomear (F2)"
                    aria-label={`Renomear ${doc.name}`}
                    onClick={() => startEdit(doc)}
                  >
                    {Icon.pencil({ className: 'ico' })}
                  </button>
                  <button
                    className="icon-btn subtle"
                    title="Remover"
                    aria-label={`Remover ${doc.name}`}
                    onClick={() => onDelete(doc)}
                  >
                    {Icon.trash({ className: 'ico' })}
                  </button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {docs.length === 0 && <p className="side-empty">Nenhum PDF</p>}
      {docs.length > 0 && shown.length === 0 && <p className="side-empty">Sem resultados</p>}
      {dragging && <div className="drop-hint">Solte para adicionar</div>}

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onRename={startEdit}
          onRestore={restore}
          onDelete={(doc) => {
            setMenu(null)
            onDelete(doc)
          }}
        />
      )}
    </aside>
  )
}
