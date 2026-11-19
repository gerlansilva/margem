import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { confirm as confirmDialog, open, save } from '@tauri-apps/plugin-dialog'
import { api, convertFileSrc, downloadText, errorText, inTauri } from './api'
import { extractPages, forgetPdf, friendlyPdfError, loadPdf, pdfHooks, textLength } from './pdf'
import { Sidebar } from './components/Sidebar'
import { Reader } from './components/Reader'
import { ChatPanel } from './components/ChatPanel'
import { NotesPanel } from './components/NotesPanel'
import { Icon } from './components/Icons'
import { PasswordModal } from './components/PasswordModal'
import { buildFichamentoCsv } from './lib/csv'
import { conversationToMarkdown, notesToMarkdown, safeFileName } from './lib/exporters'
import { createAnnotation, normalizeAnnotations } from './lib/annotations'
import { hasMod, isTyping, shortcut } from './lib/platform'
import { pref, setPref } from './store'

// Peças pesadas ou raras saem do primeiro carregamento.
const Fichamento = lazy(() => import('./components/Fichamento').then((m) => ({ default: m.Fichamento })))
const SourceModal = lazy(() => import('./components/SourceModal').then((m) => ({ default: m.SourceModal })))
const SettingsModal = lazy(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })))
const ShortcutsModal = lazy(() => import('./components/ShortcutsModal').then((m) => ({ default: m.ShortcutsModal })))

class NoTextError extends Error {
  constructor() {
    super('Este PDF não tem texto selecionável (parece escaneado).')
    this.name = 'NoTextError'
  }
}

function applyTheme(theme) {
  const dark =
    theme === 'dark' || (theme === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
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
  const [scopeIds, setScopeIds] = useState([])
  const [source, setSource] = useState(null)
  const [seed, setSeed] = useState(null)
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState(null)
  const [annotations, setAnnotations] = useState([])
  const [sideTab, setSideTab] = useState('chat')
  const [theme, setTheme] = useState(() => pref('theme', 'auto'))
  const [passwordReq, setPasswordReq] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [focusNonce, setFocusNonce] = useState(0)
  const [readerFocus, setReaderFocus] = useState(null)
  const [navOpen, setNavOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

  const toastTimer = useRef(null)
  const abortRef = useRef(null)
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

  // ------------------------------------------------------------------ tema
  useEffect(() => {
    applyTheme(theme)
    setPref('theme', theme)
    if (theme !== 'auto' || !window.matchMedia) return undefined
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => applyTheme('auto')
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [theme])

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
        setScopeIds([id])
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
  async function convertPdf(doc, signal) {
    const url = convertFileSrc(doc.path)
    setBusy({ label: 'Abrindo o PDF…', value: 0, cancellable: true, name: doc.name })
    const pdf = await loadPdf(url)
    let figures = 0
    const pages = await extractPages(pdf, {
      signal,
      onProgress: (n, total) =>
        setBusy({
          label: `Convertendo página ${n} de ${total}…`,
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
    setBusy({ label: 'Guardando…', value: 1, cancellable: false, name: doc.name })
    await api.savePages(doc.id, pages)
    return { pages: pages.length, figures }
  }

  async function addDocs(input) {
    if (importing.current) return
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
        return
      }
    }
    paths = paths.filter(Boolean)
    if (!paths.length) return
    importing.current = true
    const controller = new AbortController()
    abortRef.current = controller
    let lastOk = null
    try {
      for (const [index, path] of paths.entries()) {
        let created = null
        try {
          created = await api.importDoc(path)
          if (paths.length > 1) notify(`Importando ${index + 1} de ${paths.length}: ${created.name}`)
          await convertPdf(created, controller.signal)
          lastOk = created.id
        } catch (error) {
          if (created) {
            forgetPdf(convertFileSrc(created.path))
            await api.deleteDoc(created.id).catch(() => {})
          }
          if (error?.name === 'AbortError') {
            notify('Importação cancelada.')
            break
          }
          const reason = error?.name === 'NoTextError' ? `${error.message} O OCR ainda não é suportado.` : friendlyPdfError(error)
          notify(`Não foi possível processar o PDF: ${reason}`, 'error')
        }
      }
      setDocs(await api.listDocs())
      if (lastOk) {
        setView('reader')
        await selectDoc(lastOk)
        notify('PDF pronto para leitura.')
      }
    } catch (error) {
      notify(`Falha ao importar: ${errorText(error)}`, 'error')
    } finally {
      importing.current = false
      abortRef.current = null
      setBusy(null)
    }
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
      notify('Texto reprocessado.')
    } catch (error) {
      if (error?.name === 'AbortError') notify('Reprocessamento cancelado. O texto anterior foi mantido.')
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
      setScopeIds((prev) => prev.filter((id) => id !== doc.id))
      setSource((prev) => (prev?.doc.id === doc.id ? null : prev))
      if (currentIdRef.current === doc.id) {
        if (list.length) await selectDoc(list[0].id)
        else {
          selectToken.current += 1
          setCurrentId(null)
          setData(null)
          setScopeIds([])
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
      notify('Colunas salvas.')
      return true
    } catch (error) {
      notify(`Falha ao salvar colunas: ${errorText(error)}`, 'error')
      return false
    }
  }

  async function extractDoc(doc) {
    setBusy({ label: `Extraindo de "${doc.name}"…`, docId: doc.id })
    try {
      const updated = await api.extract(doc.id, null)
      setCells((prev) => [...prev.filter((cell) => cell.doc_id !== doc.id), ...updated])
      notify(`Fichamento de "${doc.name}" atualizado.`)
    } catch (error) {
      notify(`Falha ao extrair: ${errorText(error)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  async function extractAll() {
    const ready = docs.filter((doc) => doc.page_count > 0)
    if (!ready.length) return notify('Nenhum PDF processado na biblioteca.')
    let failed = 0
    for (let index = 0; index < ready.length; index += 1) {
      const doc = ready[index]
      setBusy({
        label: `Extraindo ${index + 1} de ${ready.length}: ${doc.name}`,
        docId: doc.id,
        value: index / ready.length,
      })
      try {
        const updated = await api.extract(doc.id, null)
        setCells((prev) => [...prev.filter((cell) => cell.doc_id !== doc.id), ...updated])
      } catch (error) {
        failed += 1
        notify(`Falha em "${doc.name}": ${errorText(error)}`, 'error')
      }
    }
    setBusy(null)
    if (!failed) notify('Fichamento concluído.')
  }

  /** Pergunta onde salvar (diálogo do sistema) e grava pelo backend; no navegador, baixa. */
  async function saveTextFile({ title, defaultName, ext, contents, mime }) {
    const path = await save({ defaultPath: defaultName, filters: [{ name: title, extensions: [ext] }] })
    if (!path) return false
    const result = await api.writeTextFile(path, contents, { mime })
    notify(result.saved ? `Salvo em ${path}` : `Baixado como ${String(path).split(/[\\/]/).pop()}.`)
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
        return notify(`CSV salvo em ${path}`)
      }
      const csv = buildFichamentoCsv({ docs, columns, cells }, { delimiter })
      downloadText(String(path).split(/[\\/]/).pop() || 'fichamento.csv', csv, 'text/csv')
      notify('CSV baixado.')
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
      setView('reader')
      if (doc.id !== currentIdRef.current) await selectDoc(doc.id)
      setReaderFocus({ page, annId, nonce: Date.now() })
    },
    [selectDoc],
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
        if (key === 'o' || key === 'O') {
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
        busy={busy}
        dragging={dragging}
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
              onSaveColumns={saveColumns}
              onExtract={extractDoc}
              onExtractAll={extractAll}
              onSource={setSource}
              onExport={exportCsv}
              busy={busy}
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
          </div>
          <ChatPanel
            docs={docs}
            scopeIds={scopeIds}
            setScopeIds={setScopeIds}
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
        </div>
      )}

      <Suspense fallback={null}>
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
            theme={theme}
            onTheme={setTheme}
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
