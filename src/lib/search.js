// Busca de texto: sem acento, sem caixa, e com índices 1:1 com o texto original
// (para mapear o achado de volta ao DOM).

/** Dobra um caractere: tira acento e caixa, sempre devolvendo UM caractere. */
function foldChar(ch) {
  const base = ch.normalize('NFD')[0] || ch
  const lower = base.toLowerCase()
  return lower.length === 1 ? lower : base
}

export function fold(text) {
  let out = ''
  for (const ch of String(text ?? '')) out += foldChar(ch)
  return out
}

/** Dobra mantendo o comprimento em unidades UTF-16 (índices alinhados). */
export function foldAligned(text) {
  let out = ''
  for (const ch of String(text ?? '')) {
    const f = foldChar(ch)
    out += f.length === ch.length ? f : ch
  }
  return out
}

/** Posições de todas as ocorrências (sem sobreposição). */
export function findAll(haystack, needle) {
  const q = foldAligned(needle).trim()
  if (q.length < 2) return []
  const text = foldAligned(haystack)
  const hits = []
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) hits.push(i)
  return hits
}

/** Texto de busca de uma página: o texto simples (cai para o Markdown). */
export function pageSearchText(page) {
  return page.text || page.md || ''
}

/** Resultado da busca no documento inteiro. */
export function searchPages(pages, query, { snippet = 48, limit = 500 } = {}) {
  const q = foldAligned(query).trim()
  const results = []
  let total = 0
  if (q.length < 2) return { total: 0, results }
  for (const page of pages) {
    const text = pageSearchText(page)
    const hits = findAll(text, query)
    if (!hits.length) continue
    total += hits.length
    for (const at of hits) {
      if (results.length >= limit) break
      const from = Math.max(0, at - snippet)
      const to = Math.min(text.length, at + q.length + snippet)
      results.push({
        page: page.n,
        index: results.filter((r) => r.page === page.n).length,
        before: text.slice(from, at).replace(/\s+/g, ' '),
        match: text.slice(at, at + q.length),
        after: text.slice(at + q.length, to).replace(/\s+/g, ' '),
      })
    }
  }
  return { total, results }
}
