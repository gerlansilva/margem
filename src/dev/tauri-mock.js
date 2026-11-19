// Backend Tauri falso para rodar a interface inteira no navegador (vite --mode mock).
// Só entra no bundle quando VITE_MOCK está ligado (ver main.jsx).
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { normalize } from '../pdf/layout'
import { splitCitations } from '../lib/citations'
import { foldAligned } from '../lib/search'
import { normalizeDoi, normalizeTitle as comparableTitle } from '../lib/related'

const state = {
  docs: [],
  pages: new Map(), // docId -> pages
  figures: new Map(), // path -> dataURL
  evidence: new Map(),
  columns: [],
  cells: [],
  settings: {
    has_key: true,
    key_source: 'keychain',
    secure_storage: true,
    model: 'deepseek-flash',
    base_url: 'https://api.deepseek.com',
    embed_base_url: '',
    embed_model: '',
    embed_key_set: false,
    openalex_email: '',
  },
  links: {}, // docId -> workId (OpenAlex)
  embedReady: false, // houve reindexação com embeddings configurados
  cancelled: new Set(),
  extracting: new Set(), // docIds em extração
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
  extractDelayMs: 250, // duração de cada extract
  extractRetry: false, // emite `status` (nova tentativa) por documento
  chatTruncate: false, // finaliza com truncated: true
  chatInvalidCite: false, // acrescenta citação de página que não existe
  files: {}, // arquivos "gravados"
  calls: [],
  docIds: () => state.docs.map((d) => d.id),
  lastChat: null,
  // Busca no acervo
  searchDelayMs: 30,
  searchFail: null, // texto do erro devolvido por search_library
  index: null, // { done, total } força o estado "indexando"; null = tudo indexado
  setIndex(done, total) {
    control.index = { done, total }
    return emit('index', { done, total })
  },
  clearIndex() {
    const total = state.docs.filter((d) => pageCount(d.id) > 0).length
    control.index = null
    return emit('index', { done: total, total })
  },
  // OpenAlex
  openalex: {
    delayMs: 120,
    lookup: null, // 'doi' | 'title' | 'none' | 'error' (força o cenário; padrão depende do documento)
    lookupFail: null, // texto do erro de openalex_lookup
    relatedFail: 0, // quantas chamadas de openalex_related falham antes de dar certo
    relatedFailText: 'Não foi possível falar com o OpenAlex: tempo esgotado.',
    downloadDelayMs: 350,
    downloadFail: null, // texto do erro de download_pdf
  },
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
  return state.docs.map((doc) => ({ ...doc, original_title: doc.original_title ?? doc.name, page_count: pageCount(doc.id) }))
}

/** Células com o título atual do documento (como get_cells no backend). */
function cellsWithTitle(docId) {
  const title = (id) => state.docs.find((d) => d.id === id)?.name || ''
  return state.cells.filter((c) => !docId || c.doc_id === docId).map((c) => ({ ...c, doc_title: title(c.doc_id) }))
}

/** Mesma regra de model::normalize_title. */
function normalizeTitle(raw) {
  const title = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').split(/\s+/).filter(Boolean).join(' ')
  if (!title) throw 'O título não pode ficar vazio.'
  if ([...title].length > 200) throw 'O título é longo demais (máximo de 200 caracteres).'
  return title
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
  return cellsWithTitle(docId)
}

function csvEscape(v, d = ',') {
  return v.includes(d) || /["\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

// ------------------------------------------------------------ busca no acervo

const SYNONYMS = [
  ['amostra', 'participantes', 'populacao'],
  ['professores', 'docentes'],
  ['variabilidade', 'variacao'],
  ['resultados', 'achados'],
  ['media', 'mediana'],
]

const foldCp = (cp) => Array.from(foldAligned(cp))[0] ?? cp

/** Variantes aceitas para um termo (só no modo híbrido). */
function variantsOf(term, hybrid) {
  if (!hybrid) return [term]
  const group = SYNONYMS.find((g) => g.includes(term))
  return group || [term]
}

function pageText(pg) {
  return pg.text || pg.md || pg.lines.map((l) => l.text).join(' ')
}

/** Ranges (pontos de código) das variantes dentro do trecho já montado. */
function rangesIn(snippet, variants) {
  const cps = Array.from(snippet)
  const folded = cps.map(foldCp)
  const joined = folded.join('')
  const cpAt = []
  folded.forEach((f, i) => {
    for (let k = 0; k < f.length; k += 1) cpAt[cpAt.length] = i
  })
  const out = []
  for (const v of variants) {
    for (let at = joined.indexOf(v); at >= 0; at = joined.indexOf(v, at + v.length)) {
      const start = cpAt[at]
      const end = cpAt[at + v.length - 1] + 1
      out.push([start, end])
    }
  }
  return out.sort((a, b) => a[0] - b[0])
}

function searchLibrary(query, docIds, limit) {
  const terms = [...new Set(foldAligned(query).split(/\s+/).filter((t) => t.length >= 2))]
  const embeddings = !!(state.settings.embed_base_url && state.settings.embed_model && state.embedReady)
  const mode = embeddings ? 'hybrid' : 'lexical'
  if (!terms.length) return { mode, hits: [] }
  const scope = docIds?.length ? new Set(docIds) : null
  const hits = []
  for (const doc of state.docs) {
    if (scope && !scope.has(doc.id)) continue
    for (const pg of state.pages.get(doc.id) || []) {
      const text = pageText(pg)
      const folded = foldAligned(text)
      const variantSets = terms.map((t) => variantsOf(t, embeddings))
      let score = 0
      let first = null
      let ok = true
      for (const variants of variantSets) {
        let found = 0
        for (const v of variants) {
          for (let at = folded.indexOf(v); at >= 0; at = folded.indexOf(v, at + v.length)) {
            found += 1
            if (!first || at < first.at) first = { at, len: v.length, v }
          }
        }
        if (!found) ok = false
        score += found
      }
      if (!ok || !first) continue
      const from = Math.max(0, first.at - 60)
      const to = Math.min(text.length, first.at + first.len + 90)
      let raw = text.slice(from, to).replace(/\s+/g, ' ').trim()
      if (from > 0) raw = `… ${raw.replace(/^\S*\s/, '')}`
      if (to < text.length) raw = `${raw.replace(/\s\S*$/, '')} …`
      const ranges = rangesIn(raw, variantSets.flat())
      const line = pg.lines.find((l) => variantSets.flat().some((v) => foldAligned(l.text).includes(v)))
      hits.push({
        doc_id: doc.id,
        doc_title: doc.name,
        page: pg.n,
        score: Math.round((score / Math.sqrt(Math.max(1, text.length / 600))) * 100) / 100,
        snippet: raw,
        ranges,
        quote: line ? line.text : raw.replace(/^… |…$/g, '').trim(),
      })
    }
  }
  hits.sort((a, b) => b.score - a.score || a.page - b.page)
  return { mode, hits: hits.slice(0, Math.max(1, limit || 30)) }
}

function indexStatus() {
  const indexable = state.docs.filter((d) => pageCount(d.id) > 0)
  const forced = control.index
  const total = forced ? forced.total : indexable.length
  const indexed = forced ? forced.done : indexable.length
  return {
    docs_total: total,
    docs_indexed: indexed,
    chunks: indexable.reduce((n, d) => n + pageCount(d.id) * 3, 0),
    embeddings: !!(state.settings.embed_base_url && state.settings.embed_model && state.embedReady),
    model: state.settings.embed_model || null,
    busy: !!forced && forced.done < forced.total,
  }
}

async function runReindex() {
  const total = state.docs.filter((d) => pageCount(d.id) > 0).length
  for (let done = 0; done < total; done += 1) {
    control.index = { done, total }
    await emit('index', { done, total })
    await sleep(160)
  }
  state.embedReady = !!(state.settings.embed_base_url && state.settings.embed_model)
  control.index = null
  await emit('index', { done: total, total })
}

// ---------------------------------------------------------------- OpenAlex

const TOPICS = [
  'letramento estatístico',
  'variabilidade',
  'probabilidade nos anos iniciais',
  'formação de professores de matemática',
  'pensamento estatístico',
  'gráficos e tabelas',
  'raciocínio inferencial',
  'educação estocástica',
  'análise de dados na escola básica',
  'modelagem estatística',
  'tecnologia no ensino de estatística',
  'currículo de estatística',
]
const FRAMES = [
  (t) => `${t[0].toUpperCase()}${t.slice(1)}: um estudo com professores`,
  (t) => `Revisão sistemática sobre ${t}`,
  (t) => `${t[0].toUpperCase()}${t.slice(1)} na educação básica: panorama e desafios`,
  (t) => `Concepções de estudantes sobre ${t}`,
  (t) => `Ensino de ${t}: propostas e limites`,
  (t) => `${t[0].toUpperCase()}${t.slice(1)} em livros didáticos brasileiros`,
]
const QUALIFIERS = [
  'no ensino fundamental',
  'no ensino médio',
  'na licenciatura',
  'na educação de jovens e adultos',
  'em escolas do campo',
  'em tempos de ensino remoto',
  'a partir de uma sequência didática',
  'sob uma perspectiva crítica',
  'com uso de planilhas',
  'em grupos colaborativos',
]
const PEOPLE = [
  'Celi Espasandin Lopes',
  'Carmen Batanero',
  'Iddo Gal',
  'Cileda de Queiroz e Silva Coutinho',
  'Sandra Maria Pinto Magina',
  'Ana Paula Santana',
  'Marcos Roberto Almeida',
  'Juliana Ferreira Campos',
  'Rafael Moreira Tavares',
  'Dolores Ferreira Santos',
  'Pedro Henrique Barros',
  'Vera Lúcia Sales',
]
const VENUES = [
  'Bolema',
  'Zetetiké',
  'Educação Matemática Pesquisa',
  'Statistics Education Research Journal',
  'RELIME',
  'Revista Paranaense de Educação Matemática',
  'Cadernos Cedes',
  'Journal of Statistics Education',
  null,
]
const POOL_SIZE = 120
const PAGE_SIZE = 10
const TOTALS = { related: 24, references: 37, cited_by: 52 }
const wid = (n) => `https://openalex.org/W${n}`

function poolWork(i) {
  const n = 2000 + i
  const authors = Array.from({ length: 1 + (i % 5) }, (_, k) => PEOPLE[(i * 3 + k * 5) % PEOPLE.length])
  const oa = i % 3 !== 1
  return {
    id: wid(n),
    doi: i % 11 === 5 ? null : `10.5555/mock.${n}`,
    title: `${FRAMES[i % FRAMES.length](TOPICS[(i * 7) % TOPICS.length])} ${QUALIFIERS[Math.floor(i / 12) % QUALIFIERS.length]}`,
    authors,
    authors_total: authors.length + (i % 4 === 0 ? 3 : 0),
    year: 1998 + ((i * 5) % 27),
    venue: VENUES[i % VENUES.length],
    cited_by_count: (i * 37) % 410,
    is_oa: oa,
    oa_url: !oa ? null : i % 2 === 0 ? `https://repositorio.example.org/arquivos/W${n}.pdf` : `https://www.scielo.example.org/artigo/W${n}`,
    abstract: i % 5 === 0 ? 'Resumo fictício do trabalho, usado só no mock.' : null,
    url: wid(n),
  }
}

/** O trabalho que o mock identifica por DOI para `artigo-2colunas`. */
const DOI_WORK = {
  id: wid(1001),
  doi: '10.5555/mock.letramento',
  title: 'Letramento estatístico de professores: um estudo no Brasil',
  authors: ['Ana Souza', 'Carlos Pereira'],
  authors_total: 2,
  year: 2021,
  venue: 'Educação Matemática Pesquisa',
  cited_by_count: 128,
  is_oa: true,
  oa_url: 'https://repositorio.example.org/arquivos/letramento.pdf',
  abstract: null,
  url: wid(1001),
}
const TITLE_CANDIDATES = [
  { ...poolWork(41), id: wid(1002), title: 'Variabilidade e amostragem no ensino médio: um estudo exploratório', doi: '10.5555/mock.1002', year: 2018 },
  { ...poolWork(42), id: wid(1003), title: 'Variabilidade e amostragem: concepções de professores', doi: null, year: 2015, is_oa: false, oa_url: null },
  { ...poolWork(43), id: wid(1004), title: 'Variabilidade em contextos de formação estatística', year: 2022 },
]
const ALL_BASE = [DOI_WORK, ...TITLE_CANDIDATES]

function findWork(id) {
  const base = ALL_BASE.find((w) => w.id === id)
  if (base) return base
  const n = Number(String(id).replace(/\D/g, '')) - 2000
  return n >= 0 && n < POOL_SIZE ? poolWork(n) : null
}

function allWorks() {
  return [...ALL_BASE, ...Array.from({ length: POOL_SIZE }, (_, i) => poolWork(i))]
}

function docScenario(doc) {
  const forced = control.openalex.lookup
  if (forced) return forced
  const name = doc.original_title ?? doc.name
  if (/artigo-2colunas/.test(name)) return 'doi'
  if (/artigo-1coluna/.test(name)) return 'title'
  return 'none'
}

async function openalexLookup(docId, query) {
  const doc = state.docs.find((d) => d.id === docId)
  if (!doc) throw 'Documento não encontrado.'
  await sleep(control.openalex.delayMs)
  if (control.openalex.lookupFail) throw control.openalex.lookupFail
  const q = String(query ?? '').trim()
  if (q) {
    const doi = normalizeDoi(q)
    const all = allWorks()
    let found
    if (doi) found = all.filter((w) => normalizeDoi(w.doi) === doi)
    else {
      const terms = comparableTitle(q).split(' ').filter(Boolean)
      found = all.filter((w) => terms.every((t) => comparableTitle(w.title).includes(t)))
    }
    found = found.slice(0, 5)
    return { source: 'manual', work: found[0] || null, candidates: found }
  }
  const linked = state.links[docId]
  if (linked) return { source: 'link', work: findWork(linked), candidates: [] }
  const scenario = docScenario(doc)
  if (scenario === 'error') throw 'Não foi possível falar com o OpenAlex: sem conexão.'
  if (scenario === 'doi') return { source: 'doi', work: DOI_WORK, candidates: [] }
  if (scenario === 'title') return { source: 'title', work: TITLE_CANDIDATES[0], candidates: TITLE_CANDIDATES }
  return { source: 'title', work: null, candidates: [] }
}

async function openalexRelated(workId, kind, page) {
  if (!TOTALS[kind]) throw `Tipo inválido: ${kind}`
  await sleep(control.openalex.delayMs)
  if (control.openalex.relatedFail > 0) {
    control.openalex.relatedFail -= 1
    throw control.openalex.relatedFailText
  }
  const total = TOTALS[kind]
  const p = Math.max(1, Number(page) || 1)
  const seed = Number(String(workId).replace(/\D/g, '')) || 0
  const kindShift = kind === 'related' ? 0 : kind === 'references' ? 17 : 31
  const works = []
  for (let k = (p - 1) * PAGE_SIZE; k < Math.min(total, p * PAGE_SIZE); k += 1) {
    works.push(poolWork((seed + kindShift + k * 7) % POOL_SIZE))
  }
  return { works, total, page: p }
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
        original_title: name,
        path: path.startsWith('/') ? path : `/__fixtures__/${name}.pdf`,
        page_count: 0,
        created_at: new Date().toISOString(),
      }
      state.docs.push(doc)
      return doc
    }
    case 'list_docs':
      return listDocs()
    case 'rename_doc': {
      const doc = state.docs.find((d) => d.id === payload.docId)
      const title = normalizeTitle(payload.title)
      if (!doc) throw 'Documento não encontrado.'
      doc.original_title = doc.original_title ?? doc.name
      doc.name = title
      return listDocs().find((d) => d.id === doc.id)
    }
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
      delete state.links[payload.docId]
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
      if (payload.embedBaseUrl !== undefined && payload.embedBaseUrl !== null) {
        const url = String(payload.embedBaseUrl).trim()
        if (url && !/^https?:\/\//i.test(url)) throw 'A URL dos embeddings precisa começar com http:// ou https://'
        state.settings.embed_base_url = url
      }
      if (payload.embedModel !== undefined && payload.embedModel !== null) state.settings.embed_model = String(payload.embedModel).trim()
      if (payload.embedKey) state.settings.embed_key_set = true
      if (payload.openalexEmail !== undefined && payload.openalexEmail !== null) state.settings.openalex_email = String(payload.openalexEmail).trim()
      return state.settings
    case 'clear_api_key':
      state.settings.has_key = false
      state.settings.key_source = 'none'
      return state.settings
    // ---- busca no acervo
    case 'search_library': {
      await sleep(control.searchDelayMs)
      if (control.searchFail) throw control.searchFail
      return searchLibrary(String(payload.query ?? ''), payload.docIds, payload.limit)
    }
    case 'index_status':
      return indexStatus()
    case 'reindex':
      runReindex()
      return null
    // ---- OpenAlex
    case 'openalex_lookup':
      return openalexLookup(payload.docId, payload.query)
    case 'openalex_link': {
      if (!state.docs.some((d) => d.id === payload.docId)) throw 'Documento não encontrado.'
      await sleep(40)
      if (payload.workId) {
        if (!findWork(payload.workId)) throw 'Trabalho não encontrado no OpenAlex.'
        state.links[payload.docId] = payload.workId
      } else delete state.links[payload.docId]
      return null
    }
    case 'openalex_related':
      return openalexRelated(payload.workId, payload.kind, payload.page)
    case 'download_pdf': {
      await sleep(control.openalex.downloadDelayMs)
      if (!/^https?:\/\//i.test(String(payload.url || ''))) throw 'Endereço inválido.'
      if (control.openalex.downloadFail) throw control.openalex.downloadFail
      if (/bloqueado/.test(payload.url)) throw 'Não foi possível baixar o PDF: o servidor respondeu 403 (acesso negado).'
      return { path: '/__fixtures__/uma-pagina.pdf', name: 'uma-pagina.pdf' }
    }
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
      return cellsWithTitle(payload.docId)
    case 'update_cell':
      return null
    case 'extract': {
      // Como o backend: um por documento, cancelável por requestId, evento `cell` por coluna.
      const { docId, columnIds, requestId } = payload
      if (!state.docs.some((d) => d.id === docId)) throw 'Documento não encontrado.'
      if (state.extracting.has(docId)) throw 'Este documento já está sendo extraído. Aguarde terminar.'
      state.extracting.add(docId)
      const cancelled = () => !!requestId && state.cancelled.has(requestId)
      try {
        if (control.extractRetry) {
          await emit('ai', { id: requestId, type: 'status', docId, message: 'Servidor ocupado. Nova tentativa em 2 s…' })
        }
        // Dorme em fatias para cancelar na hora (o backend também cancela na fila e no download).
        const until = Date.now() + (control.extractDelayMs ?? 250) + (control.extractRetry ? 600 : 0)
        while (Date.now() < until) {
          if (cancelled()) throw 'Operação cancelada.'
          await sleep(20)
        }
        if (cancelled()) throw 'Operação cancelada.'
        const cells = mockExtract(docId, columnIds)
        if (requestId) {
          const wanted = state.columns.filter((c) => !columnIds || columnIds.includes(c.id))
          for (const col of wanted) {
            const cell = cells.find((c) => c.column_id === col.id)
            if (cell) await emit('ai', { id: requestId, type: 'cell', docId, columnId: col.id, cell })
          }
        }
        return cells
      } finally {
        state.extracting.delete(docId)
        if (requestId) state.cancelled.delete(requestId)
      }
    }
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
