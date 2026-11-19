import { useCallback, useEffect, useRef, useState } from 'react'
import { confirm as confirmDialog, open, save } from '@tauri-apps/plugin-dialog'
import { api, convertFileSrc } from './api'
import { extractPages, loadPdf } from './pdf'
import { Sidebar } from './components/Sidebar'
import { Reader } from './components/Reader'
import { ChatPanel } from './components/ChatPanel'
import { Fichamento } from './components/Fichamento'
import { SourceModal } from './components/SourceModal'
import { SettingsModal } from './components/SettingsModal'
import { Icon } from './components/Icons'

let demoIngest = null
let demoReprocess = false
let demoSource = false

export default function App() {
  const [docs, setDocs] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [data, setData] = useState(null)
  const [view, setView] = useState('reader')
  const [columns, setColumns] = useState([])
  const [cells, setCells] = useState([])
  const [settings, setSettings] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [scopeIds, setScopeIds] = useState([])
  const [source, setSource] = useState(null)
  const [seed, setSeed] = useState(null)
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)

  const notify = useCallback((message) => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 4200)
  }, [])

  const selectDoc = useCallback(async (id) => {
    setCurrentId(id)
    const payload = await api.getDoc(id)
    setData(payload)
    setScopeIds([id])
    setSeed(null)
  }, [])

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
        // Com VITE_DEMO_PDF, quem escolhe o documento é o efeito de demo;
        // selecionar aqui também disputaria com ele.
        if (list.length && !import.meta.env.VITE_DEMO_PDF) await selectDoc(list[0].id)
      } catch (error) {
        notify(`Falha ao iniciar: ${error}`)
      }
    })()
    return () => {
      dead = true
    }
  }, [notify, selectDoc])

  useEffect(() => {
    const demo = import.meta.env.VITE_DEMO_PDF
    if (!demo || !import.meta.env.DEV) return
    // O StrictMode monta duas vezes; sem isso o PDF de exemplo seria importado
    // duas vezes em paralelo.
    if (!demoIngest) {
      demoIngest = (async () => {
        const name = demo.split('/').pop().replace(/\.pdf$/i, '')
        const existing = (await api.listDocs()).find((doc) => doc.name === name)
        if (existing) await selectDoc(existing.id)
        else await addDoc(demo)
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function persistFigures(docId, pages) {
    const withFigures = pages.filter((page) => page.figures?.length)
    let done = 0
    for (const page of withFigures) {
      for (const figure of page.figures) {
        figure.path = await api.saveFigure(docId, page.n, figure.index, figure.data)
        delete figure.data
        done += 1
        setBusy({
          label: `Guardando figura ${done}…`,
          value: done / Math.max(1, withFigures.reduce((sum, p) => sum + p.figures.length, 0)),
        })
      }
    }
  }

  async function addDoc(pathArg) {
    const path =
      pathArg ||
      (await open({
        multiple: false,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      }))
    if (!path) return
    let created = null
    try {
      created = await api.importDoc(path)
      setBusy({ label: 'Abrindo o PDF…', value: 0 })
      const pdf = await loadPdf(convertFileSrc(created.path))
      const pages = await extractPages(pdf, (n, total) =>
        setBusy({ label: `Convertendo página ${n} de ${total}…`, value: n / total }),
      )
      await persistFigures(created.id, pages)
      await api.savePages(created.id, pages)
      const list = await api.listDocs()
      setDocs(list)
      setView('reader')
      await selectDoc(created.id)
      notify('PDF pronto para leitura.')
    } catch (error) {
      if (created) await api.deleteDoc(created.id).catch(() => {})
      notify(`Não foi possível processar o PDF: ${error}`)
    } finally {
      setBusy(null)
    }
  }

  async function reprocessDoc() {
    if (!data) return
    setBusy({ label: 'Reprocessando o texto…', value: 0 })
    try {
      const pdf = await loadPdf(convertFileSrc(data.doc.path))
      const pages = await extractPages(pdf, (n, total) =>
        setBusy({ label: `Convertendo página ${n} de ${total}…`, value: n / total }),
      )
      await persistFigures(data.doc.id, pages)
      await api.savePages(data.doc.id, pages)
      await selectDoc(data.doc.id)
      notify('Texto reprocessado.')
    } catch (error) {
      notify(`Falha ao reprocessar: ${error}`)
    } finally {
      setBusy(null)
    }
  }

  async function removeDoc(doc) {
    const ok = await confirmDialog(`Remover "${doc.name}" da biblioteca?`, {
      title: 'Remover PDF',
      kind: 'warning',
    })
    if (!ok) return
    try {
      await api.deleteDoc(doc.id)
      const list = await api.listDocs()
      setDocs(list)
      setCells((prev) => prev.filter((cell) => cell.doc_id !== doc.id))
      if (currentId === doc.id) {
        if (list.length) await selectDoc(list[0].id)
        else {
          setCurrentId(null)
          setData(null)
          setScopeIds([])
        }
      }
    } catch (error) {
      notify(`Falha ao remover: ${error}`)
    }
  }

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
    } catch (error) {
      notify(`Falha ao salvar colunas: ${error}`)
    }
  }

  useEffect(() => {
    if (!import.meta.env.DEV || !import.meta.env.VITE_DEMO_EXTRACT) return
    if (!data?.doc || !columns.length) return
    const timer = setTimeout(() => extractDoc(data.doc, true), 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.doc?.id, columns.length])

  useEffect(() => {
    if (!import.meta.env.DEV || !import.meta.env.VITE_DEMO_REPROCESS) return
    if (demoReprocess || !docs.length) return
    demoReprocess = true
    ;(async () => {
      setBusy({ label: 'Reprocessando biblioteca…', value: 0 })
      for (const doc of docs) {
        try {
          const pdf = await loadPdf(convertFileSrc(doc.path))
          const pages = await extractPages(pdf)
          await persistFigures(doc.id, pages)
          await api.savePages(doc.id, pages)
        } catch (error) {
          console.warn('reprocess', doc.name, error)
        }
      }
      const list = await api.listDocs()
      setDocs(list)
      if (currentId) await selectDoc(currentId)
      setBusy(null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.length])

  useEffect(() => {
    const raw = import.meta.env.VITE_DEMO_SOURCE
    if (!import.meta.env.DEV || !raw || demoSource || !docs.length) return
    const [name, page, quote] = raw.split('|')
    const doc = docs.find((item) => item.name.includes(name)) || docs[0]
    demoSource = true
    setSource({ doc, page: Number(page), quote })
  }, [docs.length])

  async function extractDoc(doc, silent = false) {
    if (!columns.length) {
      notify('Defina ao menos uma coluna.')
      return
    }
    setBusy({ label: `Extraindo de "${doc.name}"…`, docId: doc.id })
    try {
      const updated = await api.extract(doc.id, null)
      setCells((prev) => [...prev.filter((cell) => cell.doc_id !== doc.id), ...updated])
      if (!silent) notify(`Fichamento de "${doc.name}" atualizado.`)
    } catch (error) {
      notify(`Falha ao extrair: ${error}`)
    } finally {
      setBusy(null)
    }
  }

  async function extractAll() {
    const ready = docs.filter((doc) => doc.page_count > 0)
    if (!ready.length) return notify('Nenhum PDF processado na biblioteca.')
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
        notify(`Falha em "${doc.name}": ${error}`)
      }
    }
    setBusy(null)
    notify('Fichamento concluído.')
  }

  async function exportCsv() {
    const path = await save({
      defaultPath: 'fichamento.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (!path) return
    try {
      await api.writeCsv(path)
      notify('CSV exportado.')
    } catch (error) {
      notify(`Falha ao exportar: ${error}`)
    }
  }

  function askAboutSelection(text, page) {
    setSeed({ text, page, nonce: Date.now() })
  }

  const showChat = view === 'reader' && data

  return (
    <div className={`app ${showChat ? 'with-chat' : ''}`}>
      <Sidebar
        docs={docs}
        currentId={currentId}
        onSelect={selectDoc}
        onAdd={addDoc}
        onDelete={removeDoc}
        busy={busy}
      />

      <main className="main">
        <header className="topbar">
          <nav className="tabs">
            <button
              className={view === 'reader' ? 'tab active' : 'tab'}
              onClick={() => setView('reader')}
            >
              {Icon.book({ className: 'ico' })} Leitura
            </button>
            <button
              className={view === 'table' ? 'tab active' : 'tab'}
              onClick={() => setView('table')}
            >
              {Icon.table({ className: 'ico' })} Fichamento
            </button>
          </nav>
          <div className="topbar-right">
            {busy && <span className="busy-label">{busy.label}</span>}
            <button className="icon-btn" title="Configurações" onClick={() => setSettingsOpen(true)}>
              {Icon.gear({ className: 'ico' })}
            </button>
          </div>
        </header>

        {busy && (
          <div className="busybar">
            <span style={{ width: `${Math.round((busy.value || 0) * 100)}%` }} />
          </div>
        )}

        {view === 'reader' ? (
          <Reader data={data} onAsk={askAboutSelection} onSource={setSource} onReprocess={reprocessDoc} />
        ) : (
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
        )}
      </main>

      {showChat && (
        <ChatPanel
          docs={docs}
          scopeIds={scopeIds}
          setScopeIds={setScopeIds}
          currentId={currentId}
          hasKey={!!settings?.has_key}
          onOpenSettings={() => setSettingsOpen(true)}
          onSource={setSource}
          seed={seed}
          onSeedClear={() => setSeed(null)}
        />
      )}

      {source && <SourceModal source={source} onClose={() => setSource(null)} />}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={setSettings}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
