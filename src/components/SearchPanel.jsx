import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errorText } from '../api'
import { Icon } from './Icons'
import { Modal } from './Modal'
import { MIN_QUERY, countLabel, createSearchRunner, groupHits, hitSegments, indexLabel, modeLabel } from '../lib/library-search'

function Snippet({ text, ranges }) {
  return hitSegments(text, ranges).map((part, i) =>
    part.mark ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
  )
}

/**
 * Painel de busca no acervo: palavras (e significado, se houver embeddings).
 * `saved` guarda a última consulta para o painel reabrir onde parou.
 */
export function SearchPanel({ docs, selectedIds, indexStatus, progress, saved, onSave, onOpen, onClose }) {
  const [query, setQuery] = useState(saved?.query || '')
  const [scope, setScope] = useState(saved?.scope === 'selected' && selectedIds.length ? 'selected' : 'all')
  const [state, setState] = useState({ status: 'idle' })
  const [active, setActive] = useState(0)
  const listRef = useRef(null)
  const runner = useRef(null)
  const first = useRef(true)

  const effectiveScope = scope === 'selected' && selectedIds.length ? 'selected' : 'all'
  const scopeKey = effectiveScope === 'selected' ? selectedIds.join(',') : ''

  if (!runner.current) {
    runner.current = createSearchRunner({
      search: (params) => api.searchLibrary(params.query.trim(), params.docIds),
      onChange: (next) =>
        setState((prev) => {
          if (next.status === 'loading') return { status: 'loading', result: prev.result }
          return next
        }),
    })
  }

  const params = useMemo(
    () => ({ query, docIds: scopeKey ? scopeKey.split(',') : null }),
    [query, scopeKey],
  )

  useEffect(() => {
    runner.current.schedule(params, { immediate: first.current && query.trim().length >= MIN_QUERY })
    first.current = false
  }, [params]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => runner.current.cancel(), [])
  useEffect(() => {
    onSave?.({ query, scope: effectiveScope })
  }, [query, effectiveScope]) // eslint-disable-line react-hooks/exhaustive-deps

  const titleOf = (id, fallback) => docs.find((d) => d.id === id)?.name ?? fallback
  const { groups, flat } = useMemo(
    () => groupHits(state.result?.hits, titleOf),
    [state.result, docs], // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    setActive(0)
  }, [state.result])
  useEffect(() => {
    listRef.current?.querySelector(`#hit-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const trimmed = query.trim()
  const hasQuery = trimmed.length >= MIN_QUERY
  const done = state.status === 'done' || (state.status === 'loading' && state.result)
  const mode = state.result?.mode || (indexStatus?.embeddings ? 'hybrid' : 'lexical')
  const idx = indexLabel(indexStatus, progress)

  function onKeyDown(event) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!flat.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + flat.length) % flat.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (state.status === 'done' && flat[active]) onOpen(flat[active])
      else runner.current.schedule(params, { immediate: true })
    }
  }

  let body
  if (!docs.length) body = <p className="search-note">Biblioteca vazia.</p>
  else if (!hasQuery) body = <p className="search-note">Digite para buscar nos PDFs.</p>
  else if (state.status === 'error')
    body = (
      <p className="msg-error" role="alert">
        {errorText(state.error)}
        <button className="link-btn" onClick={() => runner.current.schedule(params, { immediate: true })}>
          Tentar de novo
        </button>
      </p>
    )
  else if (done && !flat.length)
    body = <p className="search-note">{effectiveScope === 'selected' ? 'Nada encontrado nos selecionados.' : 'Nada encontrado.'}</p>
  else if (!done) body = <p className="search-note" aria-hidden />
  else
    body = groups.map((group) => (
      <section key={group.docId} role="group" aria-labelledby={`grp-${group.docId}`} className="hit-group">
        <h4 id={`grp-${group.docId}`}>
          <span className="hit-doc" title={group.title}>
            {group.title}
          </span>
          <span className="hit-n">{group.hits.length}</span>
        </h4>
        {group.hits.map((hit) => (
          <div
            key={hit.key}
            id={`hit-${hit.index}`}
            role="option"
            aria-selected={hit.index === active}
            className={`hit ${hit.index === active ? 'active' : ''}`}
            onMouseMove={() => hit.index !== active && setActive(hit.index)}
            onClick={() => onOpen(hit)}
          >
            <span className="hit-page">p. {hit.page}</span>
            <span className="hit-snippet">
              <Snippet text={hit.snippet} ranges={hit.ranges} />
            </span>
          </div>
        ))}
      </section>
    ))

  return (
    <Modal onClose={onClose} labelledBy="search-title" className="search-modal">
      <h3 id="search-title" className="sr-only">
        Buscar no acervo
      </h3>
      <div className="search-field">
        {Icon.search({ className: 'ico' })}
        <input
          data-autofocus
          type="text"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="search-results"
          aria-activedescendant={flat.length ? `hit-${active}` : undefined}
          aria-label="Buscar no acervo"
          placeholder="Buscar no acervo"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(event) => event.target.select()}
        />
        {state.status === 'loading' && <span className="spinner" role="status" aria-label="Buscando" />}
        <button className="icon-btn" onClick={onClose} aria-label="Fechar a busca">
          {Icon.close({ className: 'ico' })}
        </button>
      </div>

      <div className="search-tools">
        <div className="seg" role="group" aria-label="Onde buscar">
          <button aria-pressed={effectiveScope === 'all'} onClick={() => setScope('all')}>
            Todos
          </button>
          <button
            aria-pressed={effectiveScope === 'selected'}
            disabled={!selectedIds.length}
            onClick={() => setScope('selected')}
          >
            Selecionados{selectedIds.length ? ` ${selectedIds.length}` : ''}
          </button>
        </div>
        <span className="search-count" role="status" aria-live="polite">
          {done && flat.length ? countLabel(flat.length, groups.length) : ''}
        </span>
      </div>

      <div className="search-body" id="search-results" role={flat.length ? 'listbox' : undefined} aria-label="Resultados" ref={listRef}>
        {body}
      </div>

      <footer className="search-foot">
        <span className="search-mode" data-mode={mode}>
          <i aria-hidden />
          {modeLabel(mode)}
        </span>
        {idx && (
          <span className="search-index" role="status" data-testid="index-state">
            {idx}
          </span>
        )}
      </footer>
    </Modal>
  )
}
