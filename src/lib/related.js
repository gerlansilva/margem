// OpenAlex: normalização para reconhecer o que já está na biblioteca,
// formatação de autores e referência, cache com validade e paginação.

const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Título comparável: sem acento, caixa nem pontuação. */
export function normalizeTitle(title) {
  return strip(title)
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** DOI puro em minúsculas ("10.1234/abc"), ou '' se não parecer um DOI. */
export function normalizeDoi(doi) {
  const raw = String(doi ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .replace(/[\s.,;]+$/, '')
  return /^10\.\d{4,9}\/\S+$/.test(raw) ? raw : ''
}

const MIN_TITLE = 12
const MIN_PREFIX = 30

/** Título de trabalho e nome de arquivo/documento são "o mesmo"? */
export function sameTitle(a, b) {
  const x = normalizeTitle(a)
  const y = normalizeTitle(b)
  if (x.length < MIN_TITLE || y.length < MIN_TITLE) return false
  if (x === y) return true
  // Nomes de arquivo costumam vir cortados ou com sufixo ("… - Autor").
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= MIN_PREFIX && long.startsWith(`${short} `)
}

/**
 * Devolve `match(work) -> docId | null`. `known` liga documentos a trabalhos
 * já identificados ({ [docId]: { id, doi, title } }): vale o id, depois o DOI,
 * depois o título do documento.
 */
export function createLibraryMatcher(docs, known = {}) {
  const ids = new Map()
  const dois = new Map()
  for (const doc of docs || []) {
    const w = known[doc.id]
    if (!w) continue
    if (w.id) ids.set(w.id, doc.id)
    const d = normalizeDoi(w.doi)
    if (d) dois.set(d, doc.id)
  }
  return (work) => {
    if (!work) return null
    if (work.id && ids.has(work.id)) return ids.get(work.id)
    const d = normalizeDoi(work.doi)
    if (d && dois.has(d)) return dois.get(d)
    for (const doc of docs || []) {
      if (sameTitle(doc.name, work.title) || (doc.original_title && sameTitle(doc.original_title, work.title))) return doc.id
    }
    return null
  }
}

/** "A, B, C et al." — no máximo `max` nomes. */
export function formatAuthors(authors, total, max = 3) {
  const list = (Array.isArray(authors) ? authors : []).filter(Boolean)
  if (!list.length) return ''
  const shown = list.slice(0, max).join(', ')
  const count = Number.isFinite(total) && total > 0 ? Math.max(total, list.length) : list.length
  return count > max ? `${shown} et al.` : shown
}

/** "Celi Espasandin Lopes" → "LOPES, Celi Espasandin" (ABNT). */
export function abntName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return parts[0] || ''
  const last = parts[parts.length - 1]
  return `${last.toUpperCase()}, ${parts.slice(0, -1).join(' ')}`
}

export function doiUrl(doi) {
  const d = normalizeDoi(doi)
  return d ? `https://doi.org/${d}` : ''
}

/** Referência em uma linha, estilo ABNT. */
export function formatReference(work) {
  if (!work) return ''
  const list = (work.authors || []).filter(Boolean)
  const total = Math.max(work.authors_total || 0, list.length)
  let authors = ''
  if (list.length) {
    authors = total > 3 ? `${abntName(list[0])} et al.` : list.slice(0, 3).map(abntName).join('; ')
  }
  const head = authors ? `${authors.replace(/\.$/, '')}. ` : ''
  const title = String(work.title || '').replace(/[.\s]+$/, '')
  const venue = work.venue ? ` ${work.venue}${work.year ? `, ${work.year}` : ''}.` : work.year ? ` ${work.year}.` : ''
  const link = doiUrl(work.doi) || work.url || ''
  return `${head}${title}.${venue}${link ? ` Disponível em: ${link}.` : ''}`.replace(/\s+/g, ' ').trim()
}

/** PDF direto: extensão .pdf (com ou sem query) ou endereço /pdf/ do arXiv. */
export function isDirectPdf(url) {
  if (!url) return false
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return false
    if (/\.pdf$/i.test(u.pathname)) return true
    return /(^|\.)arxiv\.org$/i.test(u.hostname) && /^\/pdf\//i.test(u.pathname)
  } catch {
    return false
  }
}

export const canDownload = (work) => !!(work && work.is_oa && isDirectPdf(work.oa_url))

/** "1 citação" / "1,2 mil citações". */
export function citationsLabel(n) {
  const count = Number(n) || 0
  if (count === 1) return '1 citação'
  if (count >= 10000) return `${Math.round(count / 1000)} mil citações`
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace('.', ',')} mil citações`
  return `${count} citações`
}

/** Junta a página nova à lista, sem repetir ids. */
export function mergeWorks(prev, next) {
  const seen = new Set(prev.map((w) => w.id))
  return [...prev, ...next.filter((w) => !seen.has(w.id))]
}

/** Cache com validade: get devolve { value, fresh } ou null. */
export function createCache(ttlMs, now = () => Date.now()) {
  const map = new Map()
  return {
    get(key) {
      const entry = map.get(key)
      return entry ? { value: entry.value, fresh: now() - entry.at < ttlMs } : null
    },
    set(key, value) {
      map.set(key, { value, at: now() })
    },
    delete(key) {
      map.delete(key)
    },
    clear() {
      map.clear()
    },
  }
}
