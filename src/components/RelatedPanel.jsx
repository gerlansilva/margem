import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorText } from '../api'
import { Icon } from './Icons'
import { copyRich } from '../lib/clipboard'
import { openExternal } from '../lib/links'
import { kvGet, kvSet } from '../store'
import {
  canDownload,
  citationsLabel,
  createCache,
  createLibraryMatcher,
  doiUrl,
  formatAuthors,
  formatReference,
  mergeWorks,
  normalizeDoi,
} from '../lib/related'

const KINDS = [
  ['related', 'Relacionados'],
  ['references', 'Referências'],
  ['cited_by', 'Citado por'],
]
const SOURCE_TAG = { doi: 'por DOI', title: 'por título', link: 'vinculado' }

// Cache da sessão: o lookup vale 30 min; as listas, 5 (depois disso revalidam em silêncio).
const lookupCache = createCache(30 * 60 * 1000)
const listCache = createCache(5 * 60 * 1000)

const slim = (w) => ({ id: w.id, doi: w.doi || null, title: w.title })
const uniqueWorks = (list) => {
  const seen = new Set()
  return list.filter((w) => w && !seen.has(w.id) && seen.add(w.id))
}

function Skeleton({ rows = 4 }) {
  return (
    <ul className="rel-list" aria-busy="true" aria-label="Carregando">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="rel-skel" aria-hidden>
          <i />
          <i />
          <i />
        </li>
      ))}
    </ul>
  )
}

function Meta({ work }) {
  const authors = formatAuthors(work.authors, work.authors_total)
  return (
    <>
      {authors && <span className="rel-authors">{authors}</span>}
      <span className="rel-meta">
        {work.year && <span>{work.year}</span>}
        {work.venue && <span className="rel-venue">{work.venue}</span>}
        <span>{citationsLabel(work.cited_by_count)}</span>
        {work.is_oa && <span className="tag oa">Acesso aberto</span>}
      </span>
    </>
  )
}

function ErrorLine({ text, onRetry }) {
  return (
    <p className="msg-error" role="alert">
      {text}
      {onRetry && (
        <button className="link-btn" onClick={onRetry}>
          Tentar de novo
        </button>
      )}
    </p>
  )
}

function WorkItem({ work, libraryDocId, state, appBusy, onOpen, onCopyRef, onCopyDoi, onDownload, onOpenDoc }) {
  const working = state?.state === 'downloading' || state?.state === 'importing'
  const direct = canDownload(work)
  return (
    <li className="rel-item">
      <button className="rel-title" onClick={() => onOpen(work.url)} title="Abrir no navegador">
        {work.title}
      </button>
      <Meta work={work} />
      <div className="rel-actions">
        {libraryDocId ? (
          <button className="tag lib" onClick={() => onOpenDoc(libraryDocId)} title="Abrir na biblioteca">
            Na biblioteca
          </button>
        ) : direct ? (
          <button
            className="btn tiny"
            disabled={working || appBusy}
            aria-busy={working || undefined}
            onClick={() => onDownload(work)}
          >
            {working ? (
              <>
                <span className="spinner small" aria-hidden />
                {state.state === 'downloading' ? 'Baixando…' : 'Adicionando…'}
              </>
            ) : (
              <>
                {Icon.download({ className: 'ico' })}
                Baixar e adicionar
              </>
            )}
          </button>
        ) : work.is_oa && work.oa_url ? (
          <button className="btn tiny" onClick={() => onOpen(work.oa_url)}>
            {Icon.external({ className: 'ico' })}
            Abrir página
          </button>
        ) : null}
        <span className="rel-icons">
          <button className="icon-btn subtle" title="Abrir no navegador" aria-label={`Abrir no navegador: ${work.title}`} onClick={() => onOpen(work.url)}>
            {Icon.external({ className: 'ico' })}
          </button>
          <button className="icon-btn subtle" title="Copiar referência" aria-label={`Copiar referência: ${work.title}`} onClick={() => onCopyRef(work)}>
            {Icon.quote({ className: 'ico' })}
          </button>
          {normalizeDoi(work.doi) && (
            <button className="icon-btn subtle" title="Copiar DOI" aria-label={`Copiar DOI: ${work.title}`} onClick={() => onCopyDoi(work)}>
              {Icon.copy({ className: 'ico' })}
            </button>
          )}
        </span>
      </div>
      {state?.state === 'error' && <p className="msg-error rel-err" role="alert">{state.message}</p>}
    </li>
  )
}

export function RelatedPanel({ doc, docs, active, hidden, appBusy, onImport, onOpenDoc, onNotify }) {
  const docId = doc?.id
  const [ident, setIdent] = useState({ status: 'idle' })
  const [identNonce, setIdentNonce] = useState(0)
  const [choosing, setChoosing] = useState(false)
  const [manual, setManual] = useState('')
  const [manualState, setManualState] = useState(null)
  const [tab, setTab] = useState('related')
  const [lists, setLists] = useState({})
  const [listNonce, setListNonce] = useState(0)
  const [dl, setDl] = useState({})
  const [saving, setSaving] = useState(false)
  const [known, setKnown] = useState({})
  const knownRef = useRef({})

  // Documentos já identificados (para reconhecer o que já está na biblioteca).
  useEffect(() => {
    let dead = false
    kvGet('openalex:known')
      .then((stored) => {
        if (dead || !stored) return
        knownRef.current = { ...stored, ...knownRef.current }
        setKnown(knownRef.current)
      })
      .catch(() => {})
    return () => {
      dead = true
    }
  }, [])
  const remember = useCallback((id, work) => {
    const next = { ...knownRef.current }
    if (work) next[id] = slim(work)
    else delete next[id]
    knownRef.current = next
    setKnown(next)
    kvSet('openalex:known', next).catch(() => {})
  }, [])

  // Outro documento: recomeça a identificação.
  useEffect(() => {
    setChoosing(false)
    setManual('')
    setManualState(null)
  }, [docId])

  // Identificação (só quando a aba está à vista).
  useEffect(() => {
    if (!active || !docId) return undefined
    const cached = lookupCache.get(docId)
    if (cached) {
      setIdent({ status: 'ready', docId, ...cached.value })
      return undefined
    }
    let dead = false
    setIdent({ status: 'loading', docId })
    api
      .openalexLookup(docId)
      .then((res) => {
        if (dead) return
        lookupCache.set(docId, res)
        if (res.work && (res.source === 'doi' || res.source === 'link')) remember(docId, res.work)
        setIdent({ status: 'ready', docId, ...res })
      })
      .catch((error) => !dead && setIdent({ status: 'error', docId, error }))
    return () => {
      dead = true
    }
  }, [active, docId, identNonce, remember])

  const now = ident.docId === docId ? ident : { status: 'loading' }
  const source = now.source
  const work = now.work || null
  const pending = source === 'title'
  const manualChoices = manualState?.status === 'done' ? manualState.choices : null
  const choices = manualChoices || (pending ? uniqueWorks([work, ...(now.candidates || [])]) : [])
  const showCard = !!work && (!pending || (choices.length <= 1 && !manualChoices))
  const showChooser = now.status === 'ready' && (choosing || !work || (pending && choices.length > 1))
  const confirmed = work && (source === 'doi' || source === 'link') ? work : null

  // Listas do trabalho confirmado.
  useEffect(() => {
    if (!active || !confirmed) return undefined
    const key = `${confirmed.id}:${tab}`
    const cached = listCache.get(key)
    if (cached) {
      setLists((l) => ({ ...l, [key]: { ...cached.value, status: 'ready' } }))
      if (cached.fresh || cached.value.page > 1) return undefined
    } else setLists((l) => ({ ...l, [key]: { works: [], total: 0, page: 0, status: 'loading' } }))
    let dead = false
    api
      .openalexRelated(confirmed.id, tab, 1)
      .then((res) => {
        if (dead) return
        const value = { works: res.works || [], total: res.total ?? 0, page: res.page || 1 }
        listCache.set(key, value)
        setLists((l) => ({ ...l, [key]: { ...value, status: 'ready' } }))
      })
      .catch((error) => {
        // Com cache à vista, a falha da revalidação não atrapalha.
        if (!dead && !cached) setLists((l) => ({ ...l, [key]: { works: [], total: 0, page: 0, status: 'error', error } }))
      })
    return () => {
      dead = true
    }
  }, [active, confirmed?.id, tab, listNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const matcher = useMemo(() => createLibraryMatcher(docs, known), [docs, known])

  async function link(target) {
    if (saving) return
    setSaving(true)
    try {
      await api.openalexLink(docId, target.id)
      const res = { source: 'link', work: target, candidates: [] }
      lookupCache.set(docId, res)
      remember(docId, target)
      setIdent({ status: 'ready', docId, ...res })
      setChoosing(false)
      setManual('')
      setManualState(null)
    } catch (error) {
      onNotify?.(`Não foi possível vincular: ${errorText(error)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function unlink() {
    if (saving) return
    setSaving(true)
    try {
      await api.openalexLink(docId, null)
      lookupCache.delete(docId)
      remember(docId, null)
      setIdent({ status: 'ready', docId, source: 'manual', work: null, candidates: [] })
      setChoosing(true)
    } catch (error) {
      onNotify?.(`Não foi possível desvincular: ${errorText(error)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function searchManual(event) {
    event.preventDefault()
    const q = manual.trim()
    if (!q) return
    setManualState({ status: 'loading' })
    try {
      const res = await api.openalexLookup(docId, q)
      setManualState({ status: 'done', choices: uniqueWorks([res.work, ...(res.candidates || [])]) })
    } catch (error) {
      setManualState({ status: 'error', error })
    }
  }

  async function copy(text, done) {
    const ok = await copyRich({ text })
    onNotify?.(ok ? done : 'Não foi possível copiar.', ok ? 'info' : 'error')
  }

  async function download(target) {
    const set = (value) => setDl((d) => ({ ...d, [target.id]: value }))
    if (dl[target.id]?.state === 'downloading' || dl[target.id]?.state === 'importing') return
    set({ state: 'downloading' })
    try {
      const file = await api.downloadPdf(target.oa_url)
      set({ state: 'importing' })
      const newId = await onImport(file.path)
      if (!newId) throw new Error('O PDF baixado não pôde ser importado.')
      try {
        await api.openalexLink(newId, target.id)
        remember(newId, target)
      } catch {
        /* o vínculo é um extra: a importação já deu certo */
      }
      set({ state: 'done' })
    } catch (error) {
      set({ state: 'error', message: `Não foi possível adicionar: ${errorText(error)}` })
    }
  }

  async function loadMore(key, current) {
    if (current.status === 'loadingMore') return
    setLists((l) => ({ ...l, [key]: { ...current, status: 'loadingMore', moreError: null } }))
    try {
      const res = await api.openalexRelated(confirmed.id, tab, current.page + 1)
      const value = { works: mergeWorks(current.works, res.works || []), total: res.total ?? current.total, page: res.page || current.page + 1 }
      listCache.set(key, value)
      setLists((l) => ({ ...l, [key]: { ...value, status: 'ready' } }))
    } catch (error) {
      setLists((l) => ({ ...l, [key]: { ...current, status: 'ready', moreError: errorText(error) } }))
    }
  }

  function onTabKey(event) {
    const at = KINDS.findIndex(([k]) => k === tab)
    let next = at
    if (event.key === 'ArrowRight') next = (at + 1) % KINDS.length
    else if (event.key === 'ArrowLeft') next = (at - 1 + KINDS.length) % KINDS.length
    else return
    event.preventDefault()
    setTab(KINDS[next][0])
    requestAnimationFrame(() => document.getElementById(`rel-tab-${KINDS[next][0]}`)?.focus())
  }

  const key = confirmed ? `${confirmed.id}:${tab}` : ''
  const list = key ? lists[key] : null

  function renderChoices(items) {
    return (
      <ul className="rel-list choices" aria-label="Candidatos">
        {items.map((w) => (
          <li key={w.id} className="rel-item">
            <span className="rel-title static">{w.title}</span>
            <Meta work={w} />
            <div className="rel-actions">
              <button className="btn tiny" disabled={saving} onClick={() => link(w)}>
                Escolher
              </button>
              {normalizeDoi(w.doi) && <span className="rel-doi">{normalizeDoi(w.doi)}</span>}
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <aside className="chat related" hidden={hidden} aria-label="Relacionados">
      <div className="chat-head">
        <div>
          <h3>Relacionados</h3>
          <p>{doc ? doc.name : ''}</p>
        </div>
      </div>

      <div className="messages rel-body">
        <section className="rel-ident" aria-label="Trabalho identificado" aria-live="polite">
          {now.status === 'loading' && <Skeleton rows={1} />}
          {now.status === 'error' && (
            <ErrorLine text={errorText(now.error)} onRetry={() => { lookupCache.delete(docId); setIdentNonce((n) => n + 1) }} />
          )}
          {showCard && (
            <article className="rel-card">
              <h4>{work.title}</h4>
              <Meta work={work} />
              <div className="rel-actions">
                {normalizeDoi(work.doi) && (
                  <button className="doi-link" onClick={() => openExternal(doiUrl(work.doi))} title="Abrir DOI">
                    {normalizeDoi(work.doi)}
                  </button>
                )}
                {SOURCE_TAG[source] && <span className={`tag src ${source === 'link' ? 'ok' : source === 'title' ? 'warn' : ''}`}>{SOURCE_TAG[source]}</span>}
              </div>
              <div className="rel-actions">
                {(source === 'doi' || source === 'title') && (
                  <button className="btn tiny primary" disabled={saving} onClick={() => link(work)}>
                    Confirmar
                  </button>
                )}
                <button className="btn tiny" aria-expanded={showChooser} onClick={() => setChoosing((v) => !v)}>
                  Trocar
                </button>
                {source === 'link' && (
                  <button className="btn tiny" disabled={saving} onClick={unlink}>
                    Desvincular
                  </button>
                )}
              </div>
            </article>
          )}
          {showChooser && (
            <div className="rel-chooser">
              {!work && !manualChoices && <p className="search-note">Não identificado.</p>}
              {renderChoices(choices.length ? choices : [])}
              <form className="rel-manual" onSubmit={searchManual} role="search">
                <input
                  type="search"
                  aria-label="Buscar no OpenAlex"
                  placeholder="Título ou DOI"
                  value={manual}
                  onChange={(event) => setManual(event.target.value)}
                  spellCheck={false}
                />
                <button className="btn tiny" type="submit" disabled={!manual.trim() || manualState?.status === 'loading'}>
                  Buscar
                </button>
              </form>
              {manualState?.status === 'loading' && <Skeleton rows={2} />}
              {manualState?.status === 'error' && <ErrorLine text={errorText(manualState.error)} />}
              {manualChoices && manualChoices.length === 0 && <p className="search-note">Nada encontrado.</p>}
              {!work && now.source === 'manual' && (
                <button className="link-btn" onClick={() => { lookupCache.delete(docId); setIdentNonce((n) => n + 1) }}>
                  Procurar de novo
                </button>
              )}
            </div>
          )}
        </section>

        {confirmed && (
          <>
            <div className="rel-tabs" role="tablist" aria-label="Listas do trabalho" onKeyDown={onTabKey}>
              {KINDS.map(([kind, label]) => {
                const total = lists[`${confirmed.id}:${kind}`]?.total
                return (
                  <button
                    key={kind}
                    id={`rel-tab-${kind}`}
                    role="tab"
                    aria-selected={tab === kind}
                    aria-controls="rel-panel"
                    tabIndex={tab === kind ? 0 : -1}
                    className={`chip ${tab === kind ? 'on' : ''}`}
                    onClick={() => setTab(kind)}
                  >
                    {label}
                    {total ? <span className="rel-total">{total}</span> : null}
                  </button>
                )
              })}
            </div>
            <div id="rel-panel" role="tabpanel" aria-labelledby={`rel-tab-${tab}`}>
              {(!list || list.status === 'loading') && <Skeleton />}
              {list?.status === 'error' && (
                <ErrorLine
                  text={errorText(list.error)}
                  onRetry={() => {
                    setLists((l) => ({ ...l, [key]: { works: [], total: 0, page: 0, status: 'loading' } }))
                    setListNonce((n) => n + 1)
                  }}
                />
              )}
              {list && (list.status === 'ready' || list.status === 'loadingMore') && list.works.length === 0 && (
                <p className="search-note">Nada encontrado.</p>
              )}
              {list && list.works.length > 0 && (
                <>
                  <ul className="rel-list" aria-label={KINDS.find(([k]) => k === tab)[1]}>
                    {list.works.map((w) => (
                      <WorkItem
                        key={w.id}
                        work={w}
                        libraryDocId={(() => {
                          const id = matcher(w)
                          return id && id !== docId ? id : null
                        })()}
                        state={dl[w.id]}
                        appBusy={appBusy}
                        onOpen={openExternal}
                        onCopyRef={(x) => copy(formatReference(x), 'Referência copiada.')}
                        onCopyDoi={(x) => copy(normalizeDoi(x.doi), 'DOI copiado.')}
                        onDownload={download}
                        onOpenDoc={onOpenDoc}
                      />
                    ))}
                  </ul>
                  {list.moreError && <ErrorLine text={list.moreError} onRetry={() => loadMore(key, list)} />}
                  {list.works.length < list.total && !list.moreError && (
                    <button className="btn ghost block rel-more" disabled={list.status === 'loadingMore'} onClick={() => loadMore(key, list)}>
                      {list.status === 'loadingMore' ? 'Carregando…' : `Carregar mais (${list.works.length} de ${list.total})`}
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}
        {now.status === 'ready' && !confirmed && work && !showChooser && pending && (
          <p className="search-note">Confirme o trabalho para ver as listas.</p>
        )}
      </div>
    </aside>
  )
}
