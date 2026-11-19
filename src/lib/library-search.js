// Busca no acervo: destaque por ranges, agrupamento por documento e o controle
// de digitação (atraso + descarte de respostas antigas).

export const MIN_QUERY = 2
export const SEARCH_DELAY = 250

/**
 * Divide o trecho em pedaços marcados ou não. `ranges` são [início, fim) em
 * caracteres Unicode (pontos de código), não em unidades UTF-16. Ranges
 * inválidos são descartados; sobrepostos ou colados viram um só.
 */
export function hitSegments(snippet, ranges) {
  const chars = Array.from(String(snippet ?? ''))
  const n = chars.length
  const clean = []
  for (const r of Array.isArray(ranges) ? ranges : []) {
    if (!Array.isArray(r)) continue
    const start = Math.max(0, Math.trunc(Number(r[0])))
    const end = Math.min(n, Math.trunc(Number(r[1])))
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) clean.push([start, end])
  }
  clean.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const r of clean) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  const out = []
  let at = 0
  for (const [start, end] of merged) {
    if (start > at) out.push({ text: chars.slice(at, start).join(''), mark: false })
    out.push({ text: chars.slice(start, end).join(''), mark: true })
    at = end
  }
  if (at < n) out.push({ text: chars.slice(at).join(''), mark: false })
  return out
}

/**
 * Agrupa os acertos por documento (na ordem em que cada documento aparece, ou
 * seja, pelo melhor acerto) e numera todos em sequência para o teclado.
 * `titleOf(docId, fallback)` permite usar o título renomeado atual.
 */
export function groupHits(hits, titleOf = (_id, fallback) => fallback) {
  const groups = []
  const byDoc = new Map()
  const flat = []
  for (const hit of Array.isArray(hits) ? hits : []) {
    let group = byDoc.get(hit.doc_id)
    if (!group) {
      group = { docId: hit.doc_id, title: titleOf(hit.doc_id, hit.doc_title) || hit.doc_title || '', hits: [] }
      byDoc.set(hit.doc_id, group)
      groups.push(group)
    }
    const item = { ...hit, key: `${hit.doc_id}:${hit.page}:${group.hits.length}`, index: flat.length }
    group.hits.push(item)
    flat.push(item)
  }
  // Os acertos de um documento ficam juntos; a numeração acompanha a tela.
  let i = 0
  const ordered = []
  for (const g of groups) {
    for (const h of g.hits) {
      h.index = i
      i += 1
      ordered.push(h)
    }
  }
  return { groups, flat: ordered }
}

/** Rótulo curto de contagem: "1 resultado", "14 resultados em 3 documentos". */
export function countLabel(hits, docs) {
  if (!hits) return ''
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  return docs > 1 ? `${plural(hits, 'resultado', 'resultados')} em ${docs} documentos` : plural(hits, 'resultado', 'resultados')
}

/** Aviso curto do índice: "Indexando 12/40", "40 documentos" ou "". */
export function indexLabel(status, progress) {
  if (progress && progress.total > 0 && progress.done < progress.total) return `Indexando ${progress.done}/${progress.total}`
  if (!status) return ''
  if (status.busy) return `Indexando ${status.docs_indexed}/${status.docs_total}`
  if (status.docs_total > 0 && status.docs_indexed < status.docs_total) return `${status.docs_indexed}/${status.docs_total} indexados`
  return ''
}

export const modeLabel = (mode) => (mode === 'hybrid' ? 'Palavras + significado' : 'Palavras')

/** Cria o descarte de respostas antigas: cada `begin()` invalida o anterior. */
export function createLatest() {
  let current = null
  return {
    begin() {
      current?.abort()
      const controller = new AbortController()
      current = controller
      return { signal: controller.signal, isCurrent: () => current === controller && !controller.signal.aborted }
    },
    cancel() {
      current?.abort()
      current = null
    },
  }
}

/** Atraso simples com `cancel()`. */
export function debounce(fn, ms) {
  let timer = null
  const run = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
  run.cancel = () => {
    clearTimeout(timer)
    timer = null
  }
  return run
}

/**
 * Controle da busca: espera `delay` ms sem digitação, descarta o que ficou
 * velho (nova digitação ou fechamento) e avisa `onChange` com
 * { status: 'idle' | 'loading' | 'done' | 'error', result?, error? }.
 * `search(params, signal)` devolve uma promessa.
 */
export function createSearchRunner({ search, onChange, delay = SEARCH_DELAY, minLength = MIN_QUERY }) {
  const latest = createLatest()
  let timer = null
  const start = (params) => {
    timer = null
    const ticket = latest.begin()
    Promise.resolve()
      .then(() => search(params, ticket.signal))
      .then(
        (result) => ticket.isCurrent() && onChange({ status: 'done', result }),
        (error) => ticket.isCurrent() && onChange({ status: 'error', error }),
      )
  }
  return {
    /** Agenda uma busca. `immediate` pula a espera (Enter, tentar de novo). */
    schedule(params, { immediate = false } = {}) {
      clearTimeout(timer)
      timer = null
      latest.cancel()
      if (String(params.query ?? '').trim().length < minLength) {
        onChange({ status: 'idle' })
        return
      }
      onChange({ status: 'loading' })
      if (immediate) start(params)
      else timer = setTimeout(() => start(params), delay)
    },
    cancel() {
      clearTimeout(timer)
      timer = null
      latest.cancel()
    },
  }
}
