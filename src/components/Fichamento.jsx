import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
import { Icon } from './Icons'
import { copyRich } from '../lib/clipboard'
import {
  SUGGESTED_COLUMNS,
  cellMap,
  formatFichamento,
  getCell,
  isFilled,
  moveItem,
  planExtraction,
  readyDocs,
  scopeDocs,
} from '../lib/fichamento'

// ---------------------------------------------------------------- painel solto

/** Painel fixo ancorado a um elemento: não é cortado pela rolagem da tabela. */
function Floating({ anchor, align = 'left', onClose, className = '', role = 'menu', label, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    const measure = () => {
      if (!anchor?.isConnected || !ref.current) return
      const rect = anchor.getBoundingClientRect()
      const width = ref.current.offsetWidth
      const left = align === 'right' ? rect.right - width : rect.left
      setPos({
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
        top: Math.min(rect.bottom + 4, window.innerHeight - ref.current.offsetHeight - 8),
      })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [anchor, align])

  useEffect(() => {
    const away = (event) => {
      if (ref.current?.contains(event.target) || anchor?.contains(event.target)) return
      onClose()
    }
    const key = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        anchor?.focus?.()
      }
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key, true)
    }
  }, [anchor, onClose])

  return (
    <div
      ref={ref}
      className={`floating ${className}`}
      role={role}
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {children}
    </div>
  )
}

// ------------------------------------------------------------ editor de coluna

function ColumnEditor({ initial, suggestions, busy, onSubmit, onCreatePreset, onCancel }) {
  const [name, setName] = useState(initial?.name || '')
  const [instruction, setInstruction] = useState(initial?.instruction || '')
  const valid = name.trim().length > 0

  function submit(event) {
    event?.preventDefault()
    if (valid && !busy) onSubmit({ name: name.trim(), instruction: instruction.trim() || name.trim() })
  }

  return (
    <form className="col-editor" onSubmit={submit}>
      <input
        autoFocus
        aria-label="Nome da coluna"
        placeholder="Nome"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <textarea
        aria-label="Instrução para a IA"
        placeholder="O que extrair"
        rows={2}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
        }}
      />
      {suggestions.length > 0 && (
        <div className="chips" aria-label="Sugestões">
          {suggestions.map((item) => (
            <button
              type="button"
              key={item.name}
              className="chip"
              disabled={busy}
              onClick={() => onCreatePreset(item)}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      <div className="col-editor-foot">
        <button type="button" className="btn tiny" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="btn primary tiny" disabled={!valid || busy}>
          {initial ? 'Salvar' : 'Adicionar'}
        </button>
      </div>
    </form>
  )
}

// ------------------------------------------------------------------ componente

export function Fichamento({
  docs,
  columns,
  cells,
  selectedIds,
  onSelectedChange,
  onSaveColumns,
  onExtract,
  onCancelJob,
  job,
  onSource,
  onExport,
  onNotify,
}) {
  const [pop, setPop] = useState(null) // { kind, anchor, colId? }
  const [mode, setMode] = useState('all') // 'all' | 'pending'
  const [fresh, setFresh] = useState([]) // ids das colunas recém-criadas
  const [saving, setSaving] = useState(false)
  const [copyPage, setCopyPage] = useState(false)
  const [copyQuote, setCopyQuote] = useState(false)
  const [copyOff, setCopyOff] = useState([]) // colunas fora da cópia
  const [copied, setCopied] = useState(false)
  const [drag, setDrag] = useState(null) // { from, over }
  const scroller = useRef(null)
  const selectAll = useRef(null)
  const copiedTimer = useRef(null)

  const ready = useMemo(() => readyDocs(docs), [docs])
  const inScope = useMemo(() => scopeDocs(docs, selectedIds), [docs, selectedIds])
  const map = useMemo(() => cellMap(cells), [cells])
  const hasSelection = selectedIds.length > 0
  const running = !!job
  const close = () => setPop(null)

  // Sombra de separação só quando há rolagem por baixo do cabeçalho / da coluna fixa.
  function onScroll(event) {
    const el = event.currentTarget
    el.dataset.sx = el.scrollLeft > 0 ? '1' : '0'
    el.dataset.sy = el.scrollTop > 0 ? '1' : '0'
  }

  const allSelected = ready.length > 0 && ready.every((d) => selectedIds.includes(d.id))
  const someSelected = hasSelection && !allSelected
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = someSelected
  }, [someSelected])

  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  // Colunas que sumiram (excluídas) saem das listas locais.
  useEffect(() => {
    const ids = new Set(columns.map((c) => c.id))
    setFresh((prev) => (prev.every((id) => ids.has(id)) ? prev : prev.filter((id) => ids.has(id))))
    setCopyOff((prev) => (prev.every((id) => ids.has(id)) ? prev : prev.filter((id) => ids.has(id))))
  }, [columns])

  // ------------------------------------------------------------------ colunas

  async function save(next) {
    setSaving(true)
    try {
      return await onSaveColumns(next)
    } finally {
      setSaving(false)
    }
  }

  const plain = (list) => list.map(({ id, name, instruction, type }) => ({ id, name, instruction, type: type || 'text' }))

  async function createColumns(items) {
    const before = new Set(columns.map((c) => c.id))
    const saved = await save([
      ...plain(columns),
      ...items.map((item) => ({ id: '', name: item.name, instruction: item.instruction, type: 'text' })),
    ])
    if (!saved) return false
    const added = saved.filter((c) => !before.has(c.id)).map((c) => c.id)
    setFresh((prev) => [...prev, ...added])
    return true
  }

  async function editColumn(column, patch) {
    const saved = await save(plain(columns).map((c) => (c.id === column.id ? { ...c, ...patch } : c)))
    return !!saved
  }

  async function deleteColumn(column) {
    close()
    const ok = await confirmDialog(`Excluir a coluna "${column.name}" e suas células?`, {
      title: 'Excluir coluna',
      kind: 'warning',
    }).catch(() => false)
    if (ok) await save(plain(columns).filter((c) => c.id !== column.id))
  }

  async function moveColumn(from, to) {
    const next = moveItem(columns, from, to)
    if (next !== columns) await save(plain(next))
  }

  // ----------------------------------------------------------------- extração

  const scopeIds = inScope.map((d) => d.id)
  const pendingPlan = useMemo(
    () => planExtraction({ docs: inScope, columns, cells, mode: 'pending' }),
    [inScope, columns, cells],
  )
  const canExtract = columns.length > 0 && inScope.length > 0 && !running && (mode === 'all' || pendingPlan.length > 0)
  const extractLabel =
    mode === 'pending'
      ? hasSelection
        ? `Preencher vazias (${inScope.length})`
        : 'Preencher vazias'
      : hasSelection
        ? `Extrair ${inScope.length}`
        : 'Extrair todos'

  function runExtract(options = {}) {
    setFresh([])
    onExtract({ docIds: scopeIds, mode, ...options })
  }

  // ------------------------------------------------------------------- copiar

  const copyColumns = columns.filter((c) => !copyOff.includes(c.id))
  async function copy(format = 'table') {
    const { text, html } = formatFichamento(
      format,
      { docs: inScope, columns: copyColumns, cells },
      { page: copyPage, quote: copyQuote },
    )
    const ok = await copyRich({ text, html })
    if (!ok) return onNotify?.('Não foi possível copiar.', 'error')
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1500)
  }
  const canCopy = copyColumns.length > 0 && inScope.length > 0

  // ------------------------------------------------------------------ render

  const colPop = pop?.colId ? columns.find((c) => c.id === pop.colId) : null
  const colIndex = colPop ? columns.indexOf(colPop) : -1
  const unusedSuggestions = SUGGESTED_COLUMNS.filter(
    (item) => !columns.some((c) => c.name.trim().toLowerCase() === item.name.toLowerCase()),
  )
  const freshColumns = fresh.map((id) => columns.find((c) => c.id === id)).filter(Boolean)
  const jobText = job ? (job.cancelling ? 'Cancelando…' : `Extraindo ${Math.min(job.done + 1, job.total)} de ${job.total}`) : ''

  const toolbar = (
    <div className="table-bar">
      <div className="table-bar-left">
        {job ? (
          <div className="job" role="status">
            <span>{jobText}</span>
            <span className="job-bar" aria-hidden="true">
              <span style={{ width: `${Math.round((job.done / Math.max(1, job.total)) * 100)}%` }} />
            </span>
            <button className="btn tiny" onClick={onCancelJob} disabled={job.cancelling}>
              Cancelar
            </button>
          </div>
        ) : (
          <span className="table-count">
            {hasSelection ? `${inScope.length} de ${ready.length} selecionados` : `${ready.length} ${ready.length === 1 ? 'documento' : 'documentos'}`}
            {hasSelection && (
              <button className="link-btn" onClick={() => onSelectedChange([])}>
                Limpar
              </button>
            )}
          </span>
        )}
      </div>

      <div className="table-actions">
        <div className="split">
          <button className="btn ghost" disabled={!canCopy} onClick={() => copy('table')} aria-label="Copiar o fichamento como tabela">
            {copied ? Icon.check({ className: 'ico' }) : Icon.copy({ className: 'ico' })}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
          <button
            className="btn ghost split-more"
            disabled={!canCopy}
            aria-label="Formatos de cópia"
            aria-haspopup="menu"
            aria-expanded={pop?.kind === 'copy'}
            onClick={(event) => setPop(pop?.kind === 'copy' ? null : { kind: 'copy', anchor: event.currentTarget })}
          >
            {Icon.chevronDown({ className: 'ico' })}
          </button>
        </div>

        <button
          className="btn ghost"
          disabled={!columns.length}
          aria-haspopup="menu"
          aria-expanded={pop?.kind === 'export'}
          onClick={(event) => setPop(pop?.kind === 'export' ? null : { kind: 'export', anchor: event.currentTarget })}
        >
          {Icon.download({ className: 'ico' })} Exportar
        </button>

        <div className="split">
          <button className="btn primary" disabled={!canExtract} onClick={() => runExtract()}>
            {extractLabel}
          </button>
          <button
            className="btn primary split-more"
            aria-label="Modo de extração"
            aria-haspopup="menu"
            aria-expanded={pop?.kind === 'extract'}
            disabled={running}
            onClick={(event) => setPop(pop?.kind === 'extract' ? null : { kind: 'extract', anchor: event.currentTarget })}
          >
            {Icon.chevronDown({ className: 'ico' })}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="table-view">
      {toolbar}

      {freshColumns.length > 0 && !running && (
        <div className="offer" role="status">
          <span>{freshColumns.length === 1 ? `Coluna nova: ${freshColumns[0].name}` : `${freshColumns.length} colunas novas`}</span>
          <button
            className="btn primary tiny"
            disabled={!inScope.length}
            onClick={() => runExtract({ mode: 'all', columnIds: freshColumns.map((c) => c.id) })}
          >
            {freshColumns.length === 1 ? 'Extrair só ela' : 'Extrair só elas'}
          </button>
          <button className="icon-btn subtle" aria-label="Dispensar" onClick={() => setFresh([])}>
            {Icon.close({ className: 'ico' })}
          </button>
        </div>
      )}

      {columns.length === 0 && ready.length > 0 && (
        <div className="quick chips" aria-label="Colunas sugeridas">
          {SUGGESTED_COLUMNS.map((item) => (
            <button key={item.name} className="chip" disabled={saving} onClick={() => createColumns([item])}>
              {Icon.plus({ className: 'ico' })} {item.name}
            </button>
          ))}
        </div>
      )}

      {ready.length === 0 ? (
        <div className="empty small">
          <p>Nenhum PDF com texto.</p>
        </div>
      ) : (
        <div className="table-scroll" ref={scroller} data-sx="0" data-sy="0" onScroll={onScroll} tabIndex={0} aria-label="Fichamento">
          <table className="fichamento">
            <caption className="sr-only">Fichamento: uma linha por documento, uma coluna por pergunta</caption>
            <thead>
              <tr>
                <th className="sticky corner" scope="col">
                  <label className="row-check">
                    <input
                      ref={selectAll}
                      type="checkbox"
                      checked={allSelected}
                      aria-label="Selecionar todos os documentos"
                      onChange={() => onSelectedChange(allSelected ? [] : ready.map((d) => d.id))}
                    />
                    <span>Documento</span>
                  </label>
                </th>
                {columns.map((column, index) => (
                  <th
                    key={column.id}
                    scope="col"
                    className={`col-head ${drag?.over === index && drag.from !== index ? (drag.from < index ? 'drop-after' : 'drop-before') : ''} ${drag?.from === index ? 'dragging' : ''}`}
                    title={column.instruction}
                    draggable={!saving}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', column.id)
                      setDrag({ from: index, over: index })
                    }}
                    onDragOver={(event) => {
                      if (!drag) return
                      event.preventDefault()
                      if (drag.over !== index) setDrag({ ...drag, over: index })
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      const from = drag?.from
                      setDrag(null)
                      if (from != null) moveColumn(from, index)
                    }}
                    onDragEnd={() => setDrag(null)}
                  >
                    <div className="col-head-in">
                      <span className="col-title">{column.name}</span>
                      <button
                        className="icon-btn subtle col-more"
                        aria-label={`Opções da coluna ${column.name}`}
                        aria-haspopup="menu"
                        aria-expanded={pop?.colId === column.id && pop.kind === 'col'}
                        onClick={(event) =>
                          setPop(
                            pop?.colId === column.id && pop.kind === 'col'
                              ? null
                              : { kind: 'col', colId: column.id, anchor: event.currentTarget.closest('th') },
                          )
                        }
                      >
                        {Icon.more({ className: 'ico' })}
                      </button>
                    </div>
                  </th>
                ))}
                <th className="add-col" scope="col">
                  <button
                    className="icon-btn subtle"
                    aria-label="Nova coluna"
                    title="Nova coluna"
                    aria-haspopup="dialog"
                    aria-expanded={pop?.kind === 'edit' && !pop.colId}
                    onClick={(event) =>
                      setPop(pop?.kind === 'edit' && !pop.colId ? null : { kind: 'edit', anchor: event.currentTarget.closest('th') })
                    }
                  >
                    {Icon.plus({ className: 'ico' })}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {ready.map((doc) => {
                const active = job && doc.id in job.active ? job.active[doc.id] : undefined
                const queued = job && doc.id in job.queued ? job.queued[doc.id] : undefined
                const checked = selectedIds.includes(doc.id)
                return (
                  <tr key={doc.id} className={checked ? 'selected' : ''}>
                    <th className="sticky doc-cell" scope="row">
                      <div className="doc-cell-in">
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`Selecionar ${doc.name}`}
                          onChange={() =>
                            onSelectedChange(checked ? selectedIds.filter((id) => id !== doc.id) : [...selectedIds, doc.id])
                          }
                        />
                        <div className="doc-cell-text">
                          <span className="doc-cell-name" title={doc.name}>
                            {doc.name}
                          </span>
                          <span className="doc-cell-pages">
                            {doc.page_count} p.
                            <button
                              className="link-btn row-extract"
                              disabled={running || !columns.length}
                              onClick={() => runExtract({ docIds: [doc.id] })}
                            >
                              Extrair
                            </button>
                          </span>
                        </div>
                      </div>
                    </th>
                    {columns.map((column, colIdx) => {
                      const cell = getCell(map, doc.id, column.id)
                      const targeted = (list) => list !== undefined && (list === null || list.includes(column.id))
                      // O aviso de nova tentativa aparece só na primeira coluna da linha em extração.
                      const firstWorking =
                        active !== undefined && columns.findIndex((c) => active === null || active.includes(c.id)) === colIdx
                      const working = targeted(active)
                      const waiting = !working && targeted(queued)
                      return (
                        <td key={column.id}>
                          {isFilled(cell) && !working ? (
                            <button
                              className="cell filled"
                              onClick={() =>
                                onSource({ doc, page: cell.page, quote: cell.quote, evidenceId: cell.evidence?.[0] })
                              }
                              title="Abrir o trecho no PDF"
                            >
                              <span className="cell-value">{cell.value}</span>
                              {cell.page && <span className="cell-page">p.{cell.page}</span>}
                            </button>
                          ) : (
                            <span className={`cell-empty ${working ? 'working' : ''}`} title={working ? job.status?.[doc.id] : undefined}>
                              {working
                                ? job.cancelling
                                  ? 'cancelando…'
                                  : (firstWorking && job.status?.[doc.id]) || 'extraindo…'
                                : waiting
                                  ? 'na fila'
                                  : cell?.status === 'not_found'
                                    ? 'não encontrado'
                                    : '—'}
                            </span>
                          )}
                        </td>
                      )
                    })}
                    <td className="add-col" />
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {pop?.kind === 'copy' && (
        <Floating anchor={pop.anchor} align="right" onClose={close} className="menu-panel" label="Copiar como">
          <button role="menuitem" onClick={() => { close(); copy('table') }}>Tabela</button>
          <button role="menuitem" onClick={() => { close(); copy('markdown') }}>Markdown</button>
          <button role="menuitem" onClick={() => { close(); copy('csv') }}>CSV</button>
          <hr />
          <button role="menuitemcheckbox" aria-checked={copyPage} className="check-item" onClick={() => setCopyPage((v) => !v)}>
            <span className="tick">{copyPage && Icon.check({ className: 'ico' })}</span>Página
          </button>
          <button role="menuitemcheckbox" aria-checked={copyQuote} className="check-item" onClick={() => setCopyQuote((v) => !v)}>
            <span className="tick">{copyQuote && Icon.check({ className: 'ico' })}</span>Trecho
          </button>
          {columns.length > 1 && (
            <>
              <hr />
              {columns.map((column) => {
                const on = !copyOff.includes(column.id)
                return (
                  <button
                    key={column.id}
                    role="menuitemcheckbox"
                    aria-checked={on}
                    className="check-item"
                    onClick={() => setCopyOff((prev) => (on ? [...prev, column.id] : prev.filter((id) => id !== column.id)))}
                  >
                    <span className="tick">{on && Icon.check({ className: 'ico' })}</span>
                    {column.name}
                  </button>
                )
              })}
            </>
          )}
        </Floating>
      )}

      {pop?.kind === 'export' && (
        <Floating anchor={pop.anchor} align="right" onClose={close} className="menu-panel" label="Exportar CSV">
          <button role="menuitem" onClick={() => { close(); onExport('comma') }}>CSV, vírgula (UTF-8)</button>
          <button role="menuitem" onClick={() => { close(); onExport('semicolon') }}>CSV, ponto e vírgula (Excel)</button>
        </Floating>
      )}

      {pop?.kind === 'extract' && (
        <Floating anchor={pop.anchor} align="right" onClose={close} className="menu-panel" label="Modo de extração">
          {[
            ['all', 'Tudo'],
            ['pending', 'Só vazias e não encontradas'],
          ].map(([value, label]) => (
            <button
              key={value}
              role="menuitemradio"
              aria-checked={mode === value}
              className="check-item"
              onClick={() => {
                setMode(value)
                close()
              }}
            >
              <span className="tick">{mode === value && Icon.check({ className: 'ico' })}</span>
              {label}
            </button>
          ))}
        </Floating>
      )}

      {pop?.kind === 'col' && colPop && (
        <Floating anchor={pop.anchor} onClose={close} className="menu-panel" label={`Coluna ${colPop.name}`}>
          <button role="menuitem" onClick={() => setPop({ kind: 'edit', colId: colPop.id, anchor: pop.anchor })}>
            Editar
          </button>
          <button
            role="menuitem"
            disabled={running || !inScope.length}
            onClick={() => {
              close()
              runExtract({ mode: 'all', columnIds: [colPop.id] })
            }}
          >
            Extrair coluna
          </button>
          <button role="menuitem" disabled={colIndex === 0} onClick={() => { close(); moveColumn(colIndex, colIndex - 1) }}>
            Mover para a esquerda
          </button>
          <button
            role="menuitem"
            disabled={colIndex === columns.length - 1}
            onClick={() => { close(); moveColumn(colIndex, colIndex + 1) }}
          >
            Mover para a direita
          </button>
          <hr />
          <button role="menuitem" className="danger" onClick={() => deleteColumn(colPop)}>
            Excluir
          </button>
        </Floating>
      )}

      {pop?.kind === 'edit' && (!pop.colId || colPop) && (
        <Floating anchor={pop.anchor} align={pop.colId ? 'left' : 'right'} onClose={close} role="dialog" className="editor-panel" label={pop.colId ? 'Editar coluna' : 'Nova coluna'}>
          <ColumnEditor
            key={pop.colId || 'new'}
            initial={colPop}
            busy={saving}
            suggestions={colPop ? [] : unusedSuggestions}
            onCancel={close}
            onSubmit={async (values) => {
              const ok = colPop ? await editColumn(colPop, values) : await createColumns([values])
              if (ok) close()
            }}
            onCreatePreset={async (item) => {
              const ok = await createColumns([item])
              if (ok && unusedSuggestions.length <= 1) close()
            }}
          />
        </Floating>
      )}
    </div>
  )
}
