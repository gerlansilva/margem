import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { confirm as confirmDialog, open, save } from '@tauri-apps/plugin-dialog'
import { api, convertFileSrc, downloadText, errorText, inTauri, listen } from './api'
import { extractPages, forgetPdf, friendlyPdfError, loadPdf, pdfHooks, textLength } from './pdf'
import { Sidebar } from './components/Sidebar'
import { Reader } from './components/Reader'
import { ChatPanel } from './components/ChatPanel'
import { NotesPanel } from './components/NotesPanel'
import { RelatedPanel } from './components/RelatedPanel'
import { Icon } from './components/Icons'
import { PasswordModal } from './components/PasswordModal'
import { buildFichamentoCsv } from './lib/csv'
import { mergeCells, planExtraction, pruneSelection, runExtractionJob } from './lib/fichamento'
import { conversationToMarkdown, notesToMarkdown, safeFileName } from './lib/exporters'
import { createAnnotation, normalizeAnnotations } from './lib/annotations'
import { hasMod, isTyping, shortcut } from './lib/platform'
import { indexLabel } from './lib/library-search'

// Peças pesadas ou raras saem do primeiro carregamento.
const Fichamento = lazy(() => import('./components/Fichamento').then((m) => ({ default: m.Fichamento })))
const SourceModal = lazy(() => import('./components/SourceModal').then((m) => ({ default: m.SourceModal })))
const SearchPanel = lazy(() => import('./components/SearchPanel').then((m) => ({ default: m.SearchPanel })))
const SettingsModal = lazy(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })))
const ShortcutsModal = lazy(() => import('./components/ShortcutsModal').then((m) => ({ default: m.ShortcutsModal })))

class NoTextError extends Error {
  constructor() {
    super('Este PDF não tem texto selecionável (parece escaneado).')
    this.name = 'NoTextError'
  }
}

export default function App() {
  const [docs, setDocs] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [data, setData] = useState(null)
  const [view, setView] = useState('reader')
  const [columns, setColumns] = useState([])
  const [cells, setCells] = useState([])
  const [settings, setSettings] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState([])
  const [job, setJob] = useState(null)
  const [source, setSource] = useState(null)
  const [seed, setSeed] = useState(null)
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState(null)
  const [annotations, setAnnotations] = useState([])
  const [sideTab, setSideTab] = useState('chat')
  const [passwordReq, setPasswordReq] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [focusNonce, setFocusNonce] = useState(0)
  const [readerFocus, setReaderFocus] = useState(null)
  const [navOpen, setNavOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchSaved, setSearchSaved] = useState({ query: '', scope: 'all' })
  const [indexStatus, setIndexStatus] = useState(null)
  const [indexProgress, setIndexProgress] = useState(null)

  const toastTimer = useRef(null)
  const abortRef = useRef(null)
  const jobAbort = useRef(null)
  const extractRequests = useRef(new Map()) // requestId -> docId (extrações em andamento)
  const selectToken = useRef(0)
  const annLoaded = useRef(null) // docId cujas anotações já foram carregadas
  const importing = useRef(false)
  const addRef = useRef(null)
  const currentIdRef = useRef(null)
  currentIdRef.current = currentId

  const notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 8000 : 4200)
  }, [])

  // ---------------------------------------------------- erros que escapariam
  useEffect(() => {
    const onRejection = (event) => {
      const reason = event.reason
      if (reason?.name === 'AbortError') return
      console.error('unhandledrejection', reason)
      notify(`Algo deu errado: ${errorText(reason)}`, 'error')
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [notify])

  // ------------------------------------------------------------ documentos
  const selectDoc = useCallback(
    async (id) => {
      const token = (selectToken.current += 1)
      setCurrentId(id)
      try {
        const payload = await api.getDoc(id)
        // Clique rápido em outro PDF: a resposta antiga não pode sobrescrever.
        if (token !== selectToken.current) return
        setData(payload)
        setSeed(null)
        setSource(null)
        setReaderFocus(null)
      } catch (error) {
        if (token === selectToken.current) notify(`Não foi possível abrir o documento: ${errorText(error)}`, 'error')
      }
    },
    [notify],
  )

  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const [list, cols, allCells, cfg] = await Promise.all([
          api.listDocs(),
          api.getColumns(),
          api.getCells(),
          api.getSettings(),
        ])
        if (dead) return
        setDocs(list)
        setColumns(cols)
        setCells(allCells)
        setSettings(cfg)
        // Destaques da versão 0.1 (IndexedDB) vão para o SQLite, uma vez.
        api.migrateAnnotations(list.map((d) => d.id))
        if (list.length) await selectDoc(list[0].id)
      } catch (error) {
        notify(`Falha ao iniciar: ${errorText(error)}`, 'error')
      }
    })()
    return () => {
      dead = true
    }
  }, [notify, selectDoc])

  // Anotações do documento atual: carrega ao trocar e grava (com atraso) ao mudar.
  useEffect(() => {
    annLoaded.current = null
    setAnnotations([])
    if (!currentId) return undefined
    let dead = false
    api
      .getAnnotations(currentId)
      .then((list) => {
        if (dead) return
        setAnnotations(normalizeAnnotations(list))
        annLoaded.current = currentId
      })
      .catch((error) => {
        if (!dead) notify(`Não foi possível carregar os destaques: ${errorText(error)}`, 'error')
      })
    return () => {
      dead = true
    }
  }, [currentId, notify])

  useEffect(() => {
    if (!currentId || annLoaded.current !== currentId) return undefined
    const id = currentId
    const timer = setTimeout(() => {
      api.saveAnnotations(id, annotations).catch((error) =>
        notify(`Não foi possível salvar os destaques: ${errorText(error)}`, 'error'),
      )
    }, 350)
    return () => clearTimeout(timer)
  }, [annotations, currentId, notify])

  const createNote = useCallback(
    (partial) => {
      const ann = createAnnotation({ ...partial, docId: currentIdRef.current })
      setAnnotations((prev) => [...prev, ann])
      return ann
    },
    [],
  )
  const updateNote = useCallback((id, patch) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: new Date().toISOString() } : a)),
    )
  }, [])
  const deleteNote = useCallback((id) => setAnnotations((prev) => prev.filter((a) => a.id !== id)), [])

  // ----------------------------------------------- conversão PDF -> páginas
  const askPassword = useCallback(
    (url, wrong) => new Promise((resolve) => setPasswordReq({ url, wrong, resolve })),
    [],
  )
  useEffect(() => {
    pdfHooks.askPassword = askPassword
    return () => {
      pdfHooks.askPassword = null
    }
  }, [askPassword])

  /** Lê o PDF, extrai as páginas (figuras gravadas à medida que saem) e salva. */
  async function convertPdf(doc, signal, prefix = '') {
    const url = convertFileSrc(doc.path)
    setBusy({ label: `${prefix}Abrindo o PDF…`, value: 0, cancellable: true, name: doc.name })
    const pdf = await loadPdf(url)
    let figures = 0
    const pages = await extractPages(pdf, {
      signal,
      onProgress: (n, total) =>
        setBusy({
          label: `${prefix}Convertendo página ${n} de ${total}…`,
          value: n / total,
          cancellable: true,
          name: doc.name,
        }),
      onFigure: async (n, figure) => {
        try {
          const path = await api.saveFigure(doc.id, n, figure.index, figure.data)
          figures += 1
          return path
        } catch (error) {
          console.warn('figura não gravada', n, error)
          figure.failed = true
          return null
        }
      },
    })
    for (const page of pages) page.figures = page.figures.filter((f) => !f.failed && f.path)
    if (textLength(pages) === 0) throw new NoTextError()
    setBusy({ label: `${prefix}Guardando…`, value: 1, cancellable: false, name: doc.name })
    await api.savePages(doc.id, pages)
    return { pages: pages.length, figures }
  }

  async function addDocs(input, { select = true } = {}) {
    if (importing.current) return null
    let paths = input
    if (!Array.isArray(paths)) {
      // Só aceita texto: um evento de clique aqui virava "caminho do arquivo".
      paths = typeof paths === 'string' ? [paths] : null
    }
    if (!paths) {
      try {
        const picked = await open({
          multiple: true,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        })
        paths = Array.isArray(picked) ? picked : picked ? [picked] : []
      } catch (error) {
        notify(`Não foi possível abrir o seletor de arquivos: ${errorText(error)}`, 'error')
        return null
      }
    }
    paths = paths.filter(Boolean)
    if (!paths.length) return null
    importing.current = true
    const controller = new AbortController()
    abortRef.current = controller
    let lastOk = null
    try {
      for (const [index, path] of paths.entries()) {
        let created = null
        try {
          created = await api.importDoc(path)
          await convertPdf(created, controller.signal, paths.length > 1 ? `${index + 1}/${paths.length} · ` : '')
          lastOk = created.id
        } catch (error) {
          if (created) {
            forgetPdf(convertFileSrc(created.path))
            await api.deleteDoc(created.id).catch(() => {})
          }
          if (error?.name === 'AbortError') break
          const reason = error?.name === 'NoTextError' ? `${error.message} O OCR ainda não é suportado.` : friendlyPdfError(error)
          notify(`Não foi possível processar o PDF: ${reason}`, 'error')
        }
      }
      setDocs(await api.listDocs())
      if (lastOk && select) {
        setView('reader')
        await selectDoc(lastOk)
      }
      refreshIndex()
    } catch (error) {
      notify(`Falha ao importar: ${errorText(error)}`, 'error')
    } finally {
      importing.current = false
      abortRef.current = null
      setBusy(null)
    }
    return lastOk
  }
  addRef.current = addDocs

  async function reprocessDoc() {
    if (!data || importing.current) return
    importing.current = true
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await convertPdf(data.doc, controller.signal)
      setDocs(await api.listDocs())
      await selectDoc(data.doc.id)
    } catch (error) {
      if (error?.name === 'AbortError') notify('Reprocessamento cancelado; o texto anterior foi mantido.')
      else notify(`Falha ao reprocessar: ${error?.name === 'NoTextError' ? error.message : friendlyPdfError(error)}`, 'error')
    } finally {
      importing.current = false
      abortRef.current = null
      setBusy(null)
    }
  }

  async function removeDoc(doc) {
    const ok = await confirmDialog(`Remover "${doc.name}" da biblioteca?`, {
      title: 'Remover PDF',
      kind: 'warning',
    }).catch(() => false)
    if (!ok) return
    try {
      await api.deleteDoc(doc.id)
      forgetPdf(convertFileSrc(doc.path))
      const list = await api.listDocs()
      setDocs(list)
      setCells((prev) => prev.filter((cell) => cell.doc_id !== doc.id))
      setSelectedIds((prev) => prev.filter((id) => id !== doc.id))
      setSource((prev) => (prev?.doc.id === doc.id ? null : prev))
      if (currentIdRef.current === doc.id) {
        if (list.length) await selectDoc(list[0].id)
        else {
          selectToken.current += 1
          setCurrentId(null)
          setData(null)
        }
      }
    } catch (error) {
      notify(`Falha ao remover: ${errorText(error)}`, 'error')
    }
  }

  // Arrastar PDFs para a janela (o Tauri entrega os caminhos).
  useEffect(() => {
    let unlisten = null
    let dead = false
    ;(async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')
        const off = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload
          if (payload.type === 'enter' || payload.type === 'over') setDragging(true)
          else if (payload.type === 'drop') {
            setDragging(false)
            const pdfs = (payload.paths || []).filter((p) => /\.pdf$/i.test(p))
            if (pdfs.length) addRef.current?.(pdfs)
            else if (payload.paths?.length) notify('Só arquivos PDF podem ser adicionados.')
          } else setDragging(false)
        })
        if (dead) off()
        else unlisten = off
      } catch {
        /* fora do Tauri (navegador de teste) */
      }
    })()
    return () => {
      dead = true
      unlisten?.()
    }
  }, [notify])

  // --------------------------------------------------------------- fichamento
  /** Salva a lista de colunas; devolve a lista gravada (com ids) ou null se falhar. */
  async function saveColumns(draft) {
    try {
      const next = await api.saveColumns(
        draft.map(({ id, name, instruction, type }) => ({
          id: id || '',
          name,
          instruction,
          type: type || 'text',
        })),
      )
      setColumns(next)
      // Coluna excluída leva as células junto.
      const ids = new Set(next.map((c) => c.id))
      setCells((prev) => (prev.every((c) => ids.has(c.column_id)) ? prev : prev.filter((c) => ids.has(c.column_id))))
      return next
    } catch (error) {
      notify(`Falha ao salvar colunas: ${errorText(error)}`, 'error')
      return null
    }
  }

  /**
   * Extrai para um conjunto de documentos, com no máximo EXTRACT_CONCURRENCY
   * chamadas ao mesmo tempo (o backend também limita a 3 ao modelo). Cada
   * documento leva um requestId; Cancelar chama cancel_chat para os que estão em
   * andamento (nada deles é gravado) e impede os que ainda não começaram.
   * As células vêm do retorno do `extract`; os eventos `cell` não são usados
   * (repetiriam o mesmo dado), só `status` (nova tentativa) para mostrar na linha.
   */
  async function startExtraction({ docIds, mode = 'all', columnIds = null }) {
    if (jobAbort.current) return
    const scope = docs.filter((doc) => docIds.includes(doc.id) && doc.page_count > 0)
    const tasks = planExtraction({ docs: scope, columns, cells, mode, columnIds })
    if (!tasks.length) return
    const controller = new AbortController()
    jobAbort.current = controller
    setJob({
      total: tasks.length,
      done: 0,
      cancelling: false,
      active: {},
      queued: Object.fromEntries(tasks.map((t) => [t.doc.id, t.columnIds])),
      status: {},
    })
    const without = (obj, key) => {
      const { [key]: _drop, ...rest } = obj
      return rest
    }
    const requests = extractRequests.current
    requests.clear()
    let outcomes = []
    try {
      outcomes = await runExtractionJob({
        tasks,
        extract: (docId, ids, requestId) => api.extract(docId, ids, requestId),
        cancelRequest: (requestId) => api.cancelChat(requestId),
        signal: controller.signal,
        onStart: ({ doc, columnIds: ids }, requestId) => {
          requests.set(requestId, doc.id)
          setJob((j) => j && { ...j, active: { ...j.active, [doc.id]: ids }, queued: without(j.queued, doc.id) })
        },
        onFinish: ({ doc, columnIds: ids }, requestId, outcome) => {
          requests.delete(requestId)
          if (outcome.status === 'done') setCells((prev) => mergeCells(prev, outcome.cells, doc.id, ids))
          else if (outcome.status === 'busy') notify(`"${doc.name}" já está sendo extraído. Aguarde terminar.`)
          else if (outcome.status === 'error') notify(`Falha em "${doc.name}": ${errorText(outcome.error)}`, 'error')
          setJob((j) => j && { ...j, active: without(j.active, doc.id), status: without(j.status, doc.id), done: j.done + 1 })
        },
      })
    } finally {
      requests.clear()
      jobAbort.current = null
      setJob(null)
    }
    if (controller.signal.aborted) {
      const saved = outcomes.filter((o) => o.status === 'done').length
      notify(
        saved
          ? `Extração cancelada. ${saved} ${saved === 1 ? 'documento já estava gravado' : 'documentos já estavam gravados'}.`
          : 'Extração cancelada. Nada foi gravado.',
      )
    }
  }

  function cancelExtraction() {
    jobAbort.current?.abort()
    setJob((j) => j && { ...j, cancelling: true, queued: {} })
  }

  // Aviso de nova tentativa do backend (`status` com docId) aparece na linha do documento.
  useEffect(() => {
    let dead = false
    let dispose = null
    listen('ai', (event) => {
      const data = event.payload
      if (!data || data.type !== 'status' || !data.docId) return
      if (extractRequests.current.get(data.id) !== data.docId) return
      setJob((j) => j && { ...j, status: { ...j.status, [data.docId]: data.message || '' } })
    })
      .then((off) => {
        if (dead) off()
        else dispose = off
      })
      .catch(() => {})
    return () => {
      dead = true
      dispose?.()
    }
  }, [])

  // Estado do índice de busca: consulta ao abrir, depois acompanha o canal `index`.
  const refreshIndex = useCallback(() => {
    api
      .indexStatus()
      .then((status) => {
        setIndexStatus(status)
        if (!status.busy) setIndexProgress(null)
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    refreshIndex()
    let dead = false
    let dispose = null
    listen('index', (event) => {
      const p = event.payload
      if (!p || typeof p.total !== 'number') return
      // O backend manda { phase: "lexical"|"embeddings"|"idle", done, total, busy }.
      // Em "lexical" a contagem é de documentos; em "embeddings" é de trechos.
      const phase = p.phase || 'lexical'
      if (phase === 'idle' || p.busy === false || p.done >= p.total) {
        setIndexProgress(null)
        refreshIndex()
      } else if (phase === 'lexical') {
        setIndexProgress({ done: p.done, total: p.total })
        setIndexStatus((prev) => (prev ? { ...prev, busy: true, docs_total: p.total, docs_indexed: p.done } : prev))
      } else {
        setIndexProgress({ done: p.done, total: p.total })
        setIndexStatus((prev) => (prev ? { ...prev, busy: true } : prev))
      }
    })
      .then((off) => {
        if (dead) off()
        else dispose = off
      })
      .catch(() => {})
    return () => {
      dead = true
      dispose?.()
    }
  }, [refreshIndex])

  async function renameDoc(doc, title) {
    try {
      const updated = await api.renameDoc(doc.id, title)
      const apply = (d) => (d.id === doc.id ? { ...d, ...updated } : d)
      setDocs((prev) => prev.map(apply))
      setData((prev) => (prev && prev.doc.id === doc.id ? { ...prev, doc: apply(prev.doc) } : prev))
      setSource((prev) => (prev && prev.doc.id === doc.id ? { ...prev, doc: apply(prev.doc) } : prev))
    } catch (error) {
      notify(`Não foi possível renomear: ${errorText(error)}`, 'error')
    }
  }

  // Seleção só vale para documentos que existem e têm texto.
  useEffect(() => {
    setSelectedIds((prev) => pruneSelection(prev, docs))
  }, [docs])

  // Conjunto do assistente: os selecionados ou, sem seleção, o documento aberto.
  const scopeIds = useMemo(
    () => (selectedIds.length ? selectedIds : currentId ? [currentId] : []),
    [selectedIds, currentId],
  )

  /** Pergunta onde salvar (diálogo do sistema) e grava pelo backend; no navegador, baixa. */
  async function saveTextFile({ title, defaultName, ext, contents, mime }) {
    const path = await save({ defaultPath: defaultName, filters: [{ name: title, extensions: [ext] }] })
    if (!path) return false
    await api.writeTextFile(path, contents, { mime })
    return true
  }

  async function exportCsv(format = 'comma') {
    try {
      const delimiter = format === 'semicolon' ? ';' : ','
      const path = await save({
        defaultPath: 'fichamento.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      if (!path) return
      if (inTauri()) {
        await api.writeCsv(path, delimiter)
        return
      }
      const csv = buildFichamentoCsv({ docs, columns, cells }, { delimiter })
      downloadText(String(path).split(/[\\/]/).pop() || 'fichamento.csv', csv, 'text/csv')
    } catch (error) {
      notify(`Falha ao exportar: ${errorText(error)}`, 'error')
    }
  }

  async function exportConversation(scopeDocs, messages) {
    try {
      const text = conversationToMarkdown({ docs: scopeDocs, messages })
      await saveTextFile({
        title: 'Markdown',
        defaultName: safeFileName(`Conversa - ${scopeDocs[0]?.name || 'Margem'}`, 'md'),
        ext: 'md',
        contents: text,
        mime: 'text/markdown',
      })
    } catch (error) {
      notify(`Falha ao exportar: ${errorText(error)}`, 'error')
    }
  }

  async function exportNotes() {
    if (!data) return
    try {
      await saveTextFile({
        title: 'Markdown',
        defaultName: safeFileName(`Notas - ${data.doc.name}`, 'md'),
        ext: 'md',
        contents: notesToMarkdown({ doc: data.doc, annotations }),
        mime: 'text/markdown',
      })
    } catch (error) {
      notify(`Falha ao exportar: ${errorText(error)}`, 'error')
    }
  }

  // -------------------------------------------------------------- navegação
  function askAboutSelection(text, page) {
    setSeed({ text, page, nonce: Date.now() })
    setSideTab('chat')
    setChatOpen(true)
  }

  const goToPage = useCallback(
    async (doc, page, annId) => {
      setSource(null)
      setSearchOpen(false)
      setView('reader')
      if (doc.id !== currentIdRef.current) await selectDoc(doc.id)
      setReaderFocus({ page, annId, nonce: Date.now() })
    },
    [selectDoc],
  )

  /** Abre o acerto da busca pelo mesmo caminho das citações do assistente. */
  const openHit = useCallback(
    (hit) => {
      const doc = docs.find((d) => d.id === hit.doc_id)
      if (!doc) {
        notify('Este documento não está mais na biblioteca.')
        return
      }
      setSource({ doc, page: hit.page, quote: hit.quote || '' })
    },
    [docs, notify],
  )

  // ---------------------------------------------------------------- atalhos
  const shortcutRef = useRef(null)
  shortcutRef.current = { addDocs, source, settingsOpen, shortcutsOpen, passwordReq, busy, view }
  useEffect(() => {
    const onKey = (event) => {
      const s = shortcutRef.current
      const key = event.key
      const modalOpen = !!document.querySelector('.overlay')
      if (hasMod(event)) {
        if ((key === 'f' || key === 'F') && event.shiftKey) {
          event.preventDefault()
          if (!modalOpen) setSearchOpen(true)
          else {
            const overlays = document.querySelectorAll('.overlay')
            overlays[overlays.length - 1]?.querySelector('.search-modal input')?.focus()
          }
        } else if (key === 'o' || key === 'O') {
          event.preventDefault()
          if (!modalOpen && !s.busy) s.addDocs()
        } else if (key === ',') {
          event.preventDefault()
          if (!modalOpen) setSettingsOpen(true)
        } else if (key === '1' || key === '2') {
          event.preventDefault()
          if (!modalOpen) setView(key === '1' ? 'reader' : 'table')
        } else if (key === 'k' || key === 'K') {
          event.preventDefault()
          if (!modalOpen) {
            setView('reader')
            setSideTab('chat')
            setChatOpen(true)
            setFocusNonce((n) => n + 1)
          }
        } else if (key === '/') {
          event.preventDefault()
          setShortcutsOpen(true)
        }
      } else if (key === '?' && !isTyping(event.target) && !modalOpen) {
        setShortcutsOpen(true)
      } else if (key === 'Escape') {
        setNavOpen(false)
        setChatOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const showSide = view === 'reader' && data
  const sideDocs = useMemo(() => docs, [docs])

  return (
    <div
      className={`app ${showSide ? 'with-chat' : ''} ${navOpen ? 'nav-open' : ''} ${chatOpen ? 'chat-open' : ''}`}
    >
      <a className="skip-link" href="#main">
        Ir para o conteúdo
      </a>
      <Sidebar
        docs={sideDocs}
        currentId={currentId}
        onSelect={(id) => {
          setNavOpen(false)
          selectDoc(id)
        }}
        onAdd={addDocs}
        onDelete={removeDoc}
        onRename={renameDoc}
        selectedIds={selectedIds}
        onToggleSelect={(id) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
        onClearSelection={() => setSelectedIds([])}
        busy={busy}
        dragging={dragging}
        onSearch={() => setSearchOpen(true)}
        indexStatus={indexStatus}
        indexProgress={indexProgress}
      />
      {(navOpen || chatOpen) && (
        <div
          className="scrim"
          onClick={() => {
            setNavOpen(false)
            setChatOpen(false)
          }}
        />
      )}

      <main className="main" id="main" tabIndex={-1}>
        <header className="topbar">
          <button
            className="icon-btn nav-toggle"
            aria-label="Abrir a biblioteca"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((v) => !v)}
          >
            {Icon.menu({ className: 'ico' })}
          </button>
          <nav className="tabs" aria-label="Seções">
            <button
              className={view === 'reader' ? 'tab active' : 'tab'}
              aria-current={view === 'reader' ? 'page' : undefined}
              onClick={() => setView('reader')}
              title={`Leitura (${shortcut('1')})`}
            >
              {Icon.book({ className: 'ico' })} Leitura
            </button>
            <button
              className={view === 'table' ? 'tab active' : 'tab'}
              aria-current={view === 'table' ? 'page' : undefined}
              onClick={() => setView('table')}
              title={`Fichamento (${shortcut('2')})`}
            >
              {Icon.table({ className: 'ico' })} Fichamento
            </button>
          </nav>
          <div className="topbar-right">
            {busy && (
              <span className="busy-label" role="status">
                {busy.label}
              </span>
            )}
            {busy?.cancellable && (
              <button className="btn tiny" onClick={() => abortRef.current?.abort()}>
                Cancelar
              </button>
            )}
            {showSide && (
              <button
                className="icon-btn chat-toggle"
                aria-label="Abrir o assistente"
                aria-expanded={chatOpen}
                onClick={() => setChatOpen((v) => !v)}
              >
                {Icon.panel({ className: 'ico' })}
              </button>
            )}
            <button
              className="icon-btn"
              title={`Atalhos (${shortcut('/')})`}
              aria-label="Atalhos de teclado"
              onClick={() => setShortcutsOpen(true)}
            >
              {Icon.keyboard({ className: 'ico' })}
            </button>
            <button
              className="icon-btn"
              title={`Configurações (${shortcut(',')})`}
              aria-label="Configurações"
              onClick={() => setSettingsOpen(true)}
            >
              {Icon.gear({ className: 'ico' })}
            </button>
          </div>
        </header>

        {busy && (
          <div
            className="busybar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((busy.value || 0) * 100)}
          >
            <span style={{ width: `${Math.round((busy.value || 0) * 100)}%` }} />
          </div>
        )}

        {view === 'reader' ? (
          <Reader
            data={data}
            annotations={annotations}
            onCreateAnnotation={createNote}
            onUpdateAnnotation={updateNote}
            onDeleteAnnotation={deleteNote}
            onAsk={askAboutSelection}
            onSource={setSource}
            onReprocess={reprocessDoc}
            focusRequest={readerFocus}
          />
        ) : (
          <Suspense fallback={<div className="empty small">Carregando…</div>}>
            <Fichamento
              docs={docs}
              columns={columns}
              cells={cells}
              selectedIds={selectedIds}
              onSelectedChange={setSelectedIds}
              onSaveColumns={saveColumns}
              onExtract={startExtraction}
              onCancelJob={cancelExtraction}
              job={job}
              onSource={setSource}
              onExport={exportCsv}
              onNotify={notify}
            />
          </Suspense>
        )}
      </main>

      {showSide && (
        <div className="side">
          <div className="side-tabs" role="tablist" aria-label="Painel lateral">
            <button
              role="tab"
              aria-selected={sideTab === 'chat'}
              className={sideTab === 'chat' ? 'active' : ''}
              onClick={() => setSideTab('chat')}
            >
              Assistente
            </button>
            <button
              role="tab"
              aria-selected={sideTab === 'notes'}
              className={sideTab === 'notes' ? 'active' : ''}
              onClick={() => setSideTab('notes')}
            >
              Notas{annotations.length ? <span className="count">{annotations.length}</span> : null}
            </button>
            <button
              role="tab"
              aria-selected={sideTab === 'related'}
              className={sideTab === 'related' ? 'active' : ''}
              onClick={() => setSideTab('related')}
            >
              Relacionados
            </button>
          </div>
          <ChatPanel
            docs={docs}
            scopeIds={scopeIds}
            hasSelection={selectedIds.length > 0}
            onDeselect={(id) => setSelectedIds((prev) => prev.filter((x) => x !== id))}
            onClearSelection={() => setSelectedIds([])}
            hasKey={!!settings?.has_key}
            onOpenSettings={() => setSettingsOpen(true)}
            onSource={setSource}
            onNotify={notify}
            onExport={exportConversation}
            seed={seed}
            onSeedClear={() => setSeed(null)}
            focusNonce={focusNonce}
            hidden={sideTab !== 'chat'}
          />
          <NotesPanel
            doc={data?.doc}
            annotations={annotations}
            onUpdate={updateNote}
            onDelete={deleteNote}
            onGoTo={(ann) => goToPage(data.doc, ann.page, ann.id)}
            onAsk={(ann) => askAboutSelection(ann.text, ann.page)}
            onExport={exportNotes}
            hidden={sideTab !== 'notes'}
          />
          <RelatedPanel
            doc={data?.doc}
            docs={docs}
            active={sideTab === 'related'}
            hidden={sideTab !== 'related'}
            appBusy={!!busy}
            onImport={(path) => addDocs([path], { select: false })}
            onOpenDoc={(id) => {
              setView('reader')
              selectDoc(id)
            }}
            onNotify={notify}
          />
        </div>
      )}

      <Suspense fallback={null}>
        {searchOpen && (
          <SearchPanel
            docs={docs}
            selectedIds={selectedIds}
            indexStatus={indexStatus}
            progress={indexProgress}
            saved={searchSaved}
            onSave={setSearchSaved}
            onOpen={openHit}
            onClose={() => setSearchOpen(false)}
          />
        )}
        {source && (
          <SourceModal
            key={`${source.doc.id}:${source.page}:${source.evidenceId || ''}:${source.quote || ''}`}
            source={source}
            onClose={() => setSource(null)}
            onGoToReader={(doc, page) => goToPage(doc, page)}
          />
        )}
        {settingsOpen && (
          <SettingsModal
            settings={settings}
            indexLabel={indexLabel(indexStatus, indexProgress)}
            onClose={() => setSettingsOpen(false)}
            onSaved={setSettings}
            onNotify={notify}
          />
        )}
        {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      </Suspense>
      {passwordReq && (
        <PasswordModal
          name={busy?.name || 'PDF'}
          wrong={passwordReq.wrong}
          onSubmit={(pw) => {
            passwordReq.resolve(pw)
            setPasswordReq(null)
          }}
          onCancel={() => {
            passwordReq.resolve(null)
            setPasswordReq(null)
          }}
        />
      )}
      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          {toast.message}
          <button className="toast-x" aria-label="Fechar aviso" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}
