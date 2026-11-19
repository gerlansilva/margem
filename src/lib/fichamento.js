// Lógica pura do fichamento: seleção, plano de extração, concorrência, mesclagem
// de células, reordenação de colunas e formatadores (TSV, HTML, Markdown, CSV).
import { guardFormula, toCsv } from './csv'

export const EXTRACT_CONCURRENCY = 3

/** Atalhos de coluna: nome curto + instrução para a IA. */
export const SUGGESTED_COLUMNS = [
  { name: 'Objetivo', instruction: 'Objetivo ou pergunta de pesquisa do estudo.' },
  { name: 'Método', instruction: 'Desenho do estudo e procedimentos de coleta e análise.' },
  { name: 'Amostra', instruction: 'Tamanho e características da amostra (N, população, país).' },
  { name: 'Resultados', instruction: 'Resultados principais, com números quando houver.' },
  { name: 'Limitações', instruction: 'Limitações declaradas pelos autores.' },
]

// ------------------------------------------------------------------ seleção

export const readyDocs = (docs) => docs.filter((doc) => doc.page_count > 0)

/** Alterna um id mantendo a ordem em que foi marcado. */
export function toggleId(ids, id) {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
}

/** Descarta ids que não existem mais ou não têm texto. */
export function pruneSelection(ids, docs) {
  const ok = new Set(readyDocs(docs).map((doc) => doc.id))
  const next = ids.filter((id) => ok.has(id))
  return next.length === ids.length ? ids : next
}

/** Documentos do conjunto: os selecionados (na ordem da biblioteca) ou, sem seleção, todos. */
export function scopeDocs(docs, selectedIds) {
  const ready = readyDocs(docs)
  if (!selectedIds?.length) return ready
  const set = new Set(selectedIds)
  return ready.filter((doc) => set.has(doc.id))
}

// -------------------------------------------------------------------- células

export const isFilled = (cell) => !!(cell?.value && cell?.quote)

export function cellMap(cells) {
  const map = new Map()
  for (const cell of cells) map.set(`${cell.doc_id}\u0000${cell.column_id}`, cell)
  return map
}
export const getCell = (map, docId, columnId) => map.get(`${docId}\u0000${columnId}`)

/**
 * Plano de extração: uma tarefa por documento.
 *  - mode 'all': tudo (ou só `columnIds`), sobrescrevendo.
 *  - mode 'pending': só células vazias ou "não encontrado".
 * columnIds === null na tarefa significa "todas as colunas".
 */
export function planExtraction({ docs, columns, cells, mode = 'all', columnIds = null }) {
  const targets = columnIds ? columns.filter((c) => columnIds.includes(c.id)) : columns
  if (!targets.length) return []
  const all = targets.length === columns.length
  const map = cellMap(cells)
  const tasks = []
  for (const doc of docs) {
    if (mode === 'pending') {
      const ids = targets.filter((c) => !isFilled(getCell(map, doc.id, c.id))).map((c) => c.id)
      if (ids.length) tasks.push({ doc, columnIds: ids.length === columns.length ? null : ids })
    } else {
      tasks.push({ doc, columnIds: all ? null : targets.map((c) => c.id) })
    }
  }
  return tasks
}

/**
 * Junta o resultado de uma extração às células atuais sem apagar as colunas que
 * não foram pedidas (columnIds null = documento inteiro).
 */
export function mergeCells(prev, updated, docId, columnIds) {
  const target = columnIds ? new Set(columnIds) : null
  const incoming = new Set(updated.filter((c) => c.doc_id === docId).map((c) => c.column_id))
  const kept = prev.filter(
    (c) => c.doc_id !== docId || !(target === null || target.has(c.column_id) || incoming.has(c.column_id)),
  )
  return [...kept, ...updated.filter((c) => c.doc_id === docId)]
}

/**
 * Executa `worker(item)` com no máximo `limit` em paralelo. Depois de `signal`
 * abortar, nada novo começa (o que já está em andamento termina). Nunca rejeita:
 * devolve { item, ok, error?, skipped? } por item, na ordem original.
 */
export async function runPool(items, limit, worker, { signal } = {}) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (signal?.aborted) {
        results[index] = { item, ok: false, skipped: true }
        continue
      }
      try {
        results[index] = { item, ok: true, value: await worker(item, index) }
      } catch (error) {
        results[index] = { item, ok: false, error }
      }
    }
  }
  const lanes = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
  return results
}

// ------------------------------------------------------- lote de extração

export const CANCELLED_MESSAGE = 'Operação cancelada.'

const messageOf = (error) => (typeof error === 'string' ? error : error?.message || '')
/** O backend cancelou a chamada: não é falha. */
export const isCancelledError = (error) => messageOf(error).startsWith(CANCELLED_MESSAGE)
/** O mesmo documento já está em extração (outra chamada em andamento). */
export const isBusyError = (error) => /já está sendo extraído/i.test(messageOf(error))

let requestSeq = 0
/** Id único por documento/chamada (usado em `extract` e `cancel_chat`). */
export function newExtractRequestId(docId) {
  requestSeq += 1
  return `ext-${Date.now().toString(36)}-${requestSeq}-${docId}`
}

/**
 * Roda um lote de extração (uma chamada por documento, no máximo `limit` ao
 * mesmo tempo). Ao abortar `signal`: nada novo começa e `cancelRequest(requestId)`
 * é chamado para cada chamada em andamento (o backend também cancela as que
 * esperam vaga). Desfecho por tarefa, na ordem original:
 *   { status: 'done', cells } | { status: 'cancelled' } | { status: 'busy', error }
 *   | { status: 'error', error }
 * `onStart(task, requestId)` e `onFinish(task, requestId, outcome)` são opcionais.
 */
export async function runExtractionJob({ tasks, extract, cancelRequest, signal, limit = EXTRACT_CONCURRENCY, onStart, onFinish }) {
  const inFlight = new Set()
  const abortAll = () => {
    for (const id of inFlight) Promise.resolve(cancelRequest?.(id)).catch(() => {})
  }
  signal?.addEventListener('abort', abortAll)
  try {
    const results = await runPool(
      tasks,
      limit,
      async (task) => {
        const requestId = newExtractRequestId(task.doc.id)
        inFlight.add(requestId)
        onStart?.(task, requestId)
        let outcome
        try {
          outcome = { status: 'done', cells: await extract(task.doc.id, task.columnIds, requestId) }
        } catch (error) {
          if (isCancelledError(error) || signal?.aborted) outcome = { status: 'cancelled' }
          else if (isBusyError(error)) outcome = { status: 'busy', error }
          else outcome = { status: 'error', error }
        } finally {
          inFlight.delete(requestId)
        }
        onFinish?.(task, requestId, outcome)
        return outcome
      },
      { signal },
    )
    return results.map((r) => (r.skipped ? { status: 'cancelled', skipped: true } : r.value))
  } finally {
    signal?.removeEventListener('abort', abortAll)
  }
}

/** Move o item de `from` para a posição `to` (cópia). */
export function moveItem(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const copy = list.slice()
  const [item] = copy.splice(from, 1)
  copy.splice(to, 0, item)
  return copy
}

// --------------------------------------------------------------- formatadores

/** Tabela de texto puro: cabeçalho + linhas (uma por documento). */
export function fichamentoTable({ docs, columns, cells, page = false, quote = false }) {
  const map = cellMap(cells)
  const head = ['Documento', ...columns.map((c) => c.name)]
  const rows = docs.map((doc) => [
    doc.name,
    ...columns.map((column) => {
      const cell = getCell(map, doc.id, column.id)
      let text = cell?.value || ''
      if (!text) return ''
      if (page && cell.page) text += ` (p.${cell.page})`
      if (quote && cell.quote) text += `\n“${cell.quote}”`
      return text
    }),
  ])
  return { head, rows }
}

/** TSV para colar em Excel/Planilhas: campos com tab, quebra de linha ou aspas vão entre aspas. */
export function toTsv({ head, rows }) {
  const field = (value) => {
    const text = guardFormula(String(value ?? ''))
    return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return [head, ...rows].map((row) => row.map(field).join('\t')).join('\n')
}

const escapeHtml = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export function toHtmlTable({ head, rows }) {
  const cell = (tag, text) => `<${tag}>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</${tag}>`
  const tr = (tag, row) => `<tr>${row.map((text) => cell(tag, text)).join('')}</tr>`
  return (
    '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse">' +
    `<thead>${tr('th', head)}</thead><tbody>${rows.map((row) => tr('td', row)).join('')}</tbody></table>`
  )
}

export function toMarkdownTable({ head, rows }) {
  const cell = (text) =>
    String(text ?? '')
      .replace(/\r?\n+/g, '<br>')
      .replace(/\|/g, '\\|')
      .trim()
  const line = (row) => `| ${row.map(cell).join(' | ')} |`
  return [line(head), `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n')
}

export function toCsvText(table, delimiter = ',') {
  return toCsv([table.head, ...table.rows], { bom: false, eol: '\n', delimiter }).replace(/\n$/, '')
}

/** format: 'table' | 'markdown' | 'csv'. `html` só existe para 'table'. */
export function formatFichamento(format, data, options = {}) {
  const table = fichamentoTable({ ...data, ...options })
  if (format === 'markdown') return { text: toMarkdownTable(table) }
  if (format === 'csv') return { text: toCsvText(table) }
  return { text: toTsv(table), html: toHtmlTable(table) }
}
