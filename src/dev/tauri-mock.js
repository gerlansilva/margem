// Backend Tauri falso para rodar a interface inteira no navegador (vite --mode mock).
// Só entra no bundle quando VITE_MOCK está ligado (ver main.jsx).
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { normalize } from '../pdf/layout'
import { splitCitations } from '../lib/citations'

const state = {
  docs: [],
  pages: new Map(), // docId -> pages
  figures: new Map(), // path -> dataURL
  evidence: new Map(),
  columns: [],
  cells: [],
  settings: { has_key: true, key_source: 'keychain', secure_storage: true, model: 'deepseek-flash', base_url: 'https://api.deepseek.com' },
  cancelled: new Set(),
  annotations: {}, // docId -> Annotation[]
  seq: 1,
}

/** Painel de controle para os testes de navegador (window.__MOCK__). */
const control = {
  nextFile: null, // caminho devolvido pelo diálogo "abrir"
  nextSave: 'C:\\Users\\teste\\Documentos\\saida', // caminho do diálogo "salvar"
  confirmAnswer: true,
  chatDelayMs: 12,
  chatFail: null,
  chatRetry: false, // emite evento `status` (nova tentativa) antes de responder
  chatTruncate: false, // finaliza com truncated: true
  chatInvalidCite: false, // acrescenta citação de página que não existe
  files: {}, // arquivos "gravados"
  calls: [],
  lastChat: null,
}
window.__MOCK__ = control

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function notFound(cmd) {
  return new Error(`Command ${cmd} not found`)
}

/** Mesma regra de files::validate_export_path (sem checar a pasta). */
function checkExportPath(path) {
  if (!path || !String(path).trim()) throw 'Escolha onde salvar o arquivo.'
  if (!/\.(md|txt|csv)$/i.test(path)) throw 'Só é possível salvar arquivos .md, .txt ou .csv.'
}

/** Confere cada citação: o documento existe e a página está dentro dele. */
function checkCitations(answer, docIds) {
  const out = []
  for (const part of splitCitations(answer)) {
    if (part.type !== 'cite') continue
    for (const ref of part.refs) {
      for (let page = ref.page; page <= ref.end; page += 1) {
        if (out.some((c) => c.doc === ref.doc && c.page === page)) continue
        const total = docIds[ref.doc - 1] ? pageCount(docIds[ref.doc - 1]) : 0
        out.push({ label: `D${ref.doc}`, doc: ref.doc, page, valid: page >= 1 && page <= total })
      }
    }
  }
  return out
}

function pageCount(docId) {
  return state.pages.get(docId)?.length || 0
}

function listDocs() {
  return state.docs.map((doc) => ({ ...doc, page_count: pageCount(doc.id) }))
}

/** Porte simplificado de evidence::resolve: sequência contígua de linhas. */
function resolveEvidence(docId, page, quote) {
  const pg = state.pages.get(docId)?.find((p) => p.n === page)
  if (!pg) return null
  const target = normalize(quote)
  if (!target) return null
  let joined = ''
  const offsets = []
  for (const line of pg.lines) {
    const n = normalize(line.text)
    const start = joined.length
    joined += n
    offsets.push([start, joined.length])
    if (n && !/-$/.test(line.text)) joined += ' '
  }
  const at = joined.indexOf(target)
  if (at < 0) return null
  const end = at + target.length
  let first = -1
  let last = -1
  offsets.forEach(([s, e], i) => {
    if (s === e) return
    if (e > at && first < 0) first = i
    if (s < end) last = i
  })
  if (first < 0) return null
  const found = {
    id: `${docId}:${page}:${first}-${last}`,
    doc_id: docId,
    page,
    text: pg.lines.slice(first, last + 1).map((l) => l.text).join(' '),
    rects: pg.lines.slice(first, last + 1).map((l) => l.rect),
  }
  state.evidence.set(found.id, found)
  return found
}

function answerFor(req) {
  const parts = []
  const quotes = []
  req.doc_ids.forEach((id, d) => {
    const pages = state.pages.get(id) || []
    const withText = pages.filter((p) => p.lines.some((l) => l.text.length > 45))
    for (const pg of withText.slice(0, 2)) {
      const line = pg.lines.find((l) => l.text.length > 45)
      quotes.push({ d: d + 1, n: pg.n, text: line.text })
    }
  })
  const question = req.history[req.history.length - 1]?.content || ''
  parts.push(`Resposta à pergunta “${question.slice(0, 60)}”.\n\n`)
  if (req.selection) parts.push(`Sobre o trecho selecionado: **${req.selection.slice(0, 40)}…**\n\n`)
  for (const q of quotes) parts.push(`- O texto afirma "${q.text}" [D${q.d} p.${q.n}].\n`)
  if (quotes[0]) parts.push(`\nEm **destaque, com citação [D${quotes[0].d} p.${quotes[0].n}]**, e ainda _itálico [D${quotes[0].d}, p. ${quotes[0].n}]_.\n`)
  if (quotes[1]) parts.push(`\nVárias de uma vez: [D${quotes[1].d} p.${quotes[1].n}; D${quotes[0].d} p.${quotes[0].n}] e intervalo [D${quotes[0].d} p.${quotes[0].n}-${quotes[0].n + 1}].\n`)
  if (control.chatInvalidCite) parts.push('\nTrecho inventado [D1 p.999].\n')
  parts.push('\n| Item | Valor |\n| --- | --- |\n| N | 248 |\n\nVeja [um link](https://example.com/artigo).')
  return parts.join('')
}

async function runChat(req) {
  const id = req.request_id
  control.lastChat = req
  if (control.chatFail === 'start') {
    await sleep(30)
    await emit('ai', { id, type: 'error', message: 'DeepSeek HTTP 401: chave inválida' })
    return
  }
  if (control.chatRetry) {
    await emit('ai', { id, type: 'status', message: 'Servidor ocupado. Nova tentativa em 2 s…' })
    await sleep(control.chatRetryMs ?? 600)
  }
  const text = answerFor(req) + (control.chatTruncate ? '\n\n*(Resposta interrompida pelo limite de tamanho do modelo.)*' : '')
  let i = 0
  const slow = /lento/i.test(req.history[req.history.length - 1]?.content || '')
  let cancelled = false
  while (i < text.length) {
    if (state.cancelled.has(id)) {
      cancelled = true
      break
    }
    const n = 4 + Math.floor(Math.random() * 6)
    await emit('ai', { id, type: 'token', t: text.slice(i, i + n) })
    i += n
    await sleep(slow ? 60 : control.chatDelayMs)
    if (control.chatFail === 'mid' && i > 80) {
      await emit('ai', { id, type: 'error', message: 'Conexão interrompida: reset' })
      return
    }
  }
  const answer = text.slice(0, i)
  await emit('ai', {
    id,
    type: 'done',
    answer,
    labels: req.doc_ids.map((_, k) => `D${k + 1}`),
    citations: checkCitations(answer, req.doc_ids),
    cancelled,
    truncated: !cancelled && control.chatTruncate,
  })
  state.cancelled.delete(id)
}

function mockExtract(docId, columnIds) {
  const pages = state.pages.get(docId) || []
  const lines = pages.flatMap((p) => p.lines.filter((l) => l.text.length > 40).map((l) => ({ ...l, n: p.n })))
  const cols = state.columns.filter((c) => !columnIds || columnIds.includes(c.id))
  const out = cols.map((col, k) => {
    const line = lines[(k * 7 + 3) % Math.max(1, lines.length)]
    if (!line || k % 4 === 3) return { doc_id: docId, column_id: col.id, value: null, quote: null, page: null, status: 'not_found', evidence: [] }
    const ev = resolveEvidence(docId, line.n, line.text)
    return {
      doc_id: docId,
      column_id: col.id,
      value: line.text.split(/[.;,]/)[0].slice(0, 90),
      quote: line.text,
      page: line.n,
      status: 'ok',
      evidence: ev ? [ev.id] : [],
    }
  })
  state.cells = [...state.cells.filter((c) => !(c.doc_id === docId && out.some((o) => o.column_id === c.column_id))), ...out]
  return state.cells.filter((c) => c.doc_id === docId)
}

function csvEscape(v, d = ',') {
  return v.includes(d) || /["\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

async function handle(cmd, payload = {}) {
  control.calls.push({ cmd, payload })
  switch (cmd) {
    // ---- diálogos (plugin-dialog)
    case 'plugin:dialog|open': {
      const f = control.nextFile
      control.nextFile = null
      return f
    }
    case 'plugin:dialog|save':
      return control.nextSave === null ? null : `${control.nextSave}${(payload.options?.defaultPath || '').match(/\.[a-z]+$/i)?.[0] || ''}`
    case 'plugin:dialog|confirm':
    case 'plugin:dialog|ask':
      return control.confirmAnswer
    case 'plugin:dialog|message':
      return 'Ok'
    case 'plugin:opener|open_url':
      control.opened = payload.url
      return null
    // ---- documentos
    case 'import_doc': {
      const path = String(payload.path || '')
      const name = path.split(/[\\/]/).pop().replace(/\.pdf$/i, '')
      if (!/\.pdf$/i.test(path)) throw 'Envie um arquivo PDF.'
      await sleep(40)
      const doc = {
        id: `doc${state.seq++}`,
        name,
        path: path.startsWith('/') ? path : `/__fixtures__/${name}.pdf`,
        page_count: 0,
        created_at: new Date().toISOString(),
      }
      state.docs.push(doc)
      return doc
    }
    case 'list_docs':
      return listDocs()
    case 'get_doc': {
      const doc = listDocs().find((d) => d.id === payload.docId)
      if (!doc) throw 'Documento não encontrado.'
      return { doc, pages: state.pages.get(doc.id) || [] }
    }
    case 'delete_doc':
      state.docs = state.docs.filter((d) => d.id !== payload.docId)
      state.pages.delete(payload.docId)
      state.cells = state.cells.filter((c) => c.doc_id !== payload.docId)
      delete state.annotations[payload.docId]
      return null
    case 'save_pages': {
      await sleep(20)
      state.pages.set(
        payload.docId,
        payload.pages.map((p) => ({ ...p, figures: (p.figures || []).map(({ data, ...f }) => f) })),
      )
      return null
    }
    case 'save_figure': {
      const path = `/mock/figures/${payload.docId}/${payload.page}-${payload.index}.png`
      state.figures.set(path, payload.data)
      return path
    }
    case 'resolve_evidence':
      return resolveEvidence(payload.docId, payload.page, payload.quote)
    case 'get_evidence':
      return state.evidence.get(payload.id) || null
    // ---- configurações
    case 'get_settings':
      return state.settings
    case 'save_settings':
      if (payload.apiKey) state.settings.has_key = true
      state.settings.key_source = payload.apiKey ? 'keychain' : state.settings.key_source
      state.settings.model = payload.model || state.settings.model
      state.settings.base_url = payload.baseUrl || state.settings.base_url
      return state.settings
    case 'clear_api_key':
      state.settings.has_key = false
      state.settings.key_source = 'none'
      return state.settings
    // ---- fichamento
    case 'get_columns':
      return state.columns
    case 'save_columns': {
      state.columns = payload.columns
        .filter((c) => c.name.trim())
        .map((c, i) => ({ ...c, id: c.id || `col${state.seq++}`, type: c.type || 'text' }))
      return state.columns
    }
    case 'get_cells':
      return payload.docId ? state.cells.filter((c) => c.doc_id === payload.docId) : state.cells
    case 'update_cell':
      return null
    case 'extract':
      await sleep(250)
      return mockExtract(payload.docId, payload.columnIds)
    case 'write_csv': {
      checkExportPath(payload.path)
      const d = payload.delimiter || ','
      if (d !== ',' && d !== ';') throw `Delimitador inválido: "${d}" (use "," ou ";").`
      let out = '\ufeffDocumento'
      for (const c of state.columns) out += `${d}${csvEscape(c.name, d)}`
      out += `${d}Trechos\n`
      for (const doc of listDocs()) {
        out += csvEscape(doc.name, d)
        const quotes = []
        for (const c of state.columns) {
          const cell = state.cells.find((x) => x.doc_id === doc.id && x.column_id === c.id)
          out += `${d}${csvEscape(cell?.value || '', d)}`
          if (cell?.quote) quotes.push(`[p.${cell.page}] ${cell.quote}`)
        }
        out += `${d}${csvEscape(quotes.join(' | '), d)}\n`
      }
      control.files[payload.path] = out
      return null
    }
    // ---- chat
    case 'chat':
      return runChat(payload.req)
    case 'cancel_chat':
      state.cancelled.add(payload.requestId)
      return null
    // ---- exportação de texto e anotações
    case 'write_text_file':
      checkExportPath(payload.path)
      control.files[payload.path] = payload.contents
      return null
    case 'list_annotations':
      return state.annotations[payload.docId] || []
    case 'save_annotations': {
      if (!state.docs.some((d) => d.id === payload.docId)) throw 'Documento não encontrado.'
      state.annotations[payload.docId] = payload.annotations.map((a) => ({ ...a, docId: payload.docId }))
      return null
    }
    default:
      if (cmd.startsWith('plugin:event|')) return undefined
      throw notFound(cmd)
  }
}

export function installTauriMock() {
  mockWindows('main')
  mockIPC(handle, { shouldMockEvents: true })
  // Caminhos de figuras gravadas viram data URL; o resto é servido pelo vite.
  window.__TAURI_INTERNALS__.convertFileSrc = (path) => state.figures.get(path) || path
}
