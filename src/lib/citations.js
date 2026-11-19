// Citações do modelo: "[D1 p.7]", "[D1, p. 7]", "[D1 p.7-8]", "[D1 p.7, 9]",
// "[D1 p.7; D2 p.3]", "[D1 pp. 7–8]". Também aceita "[p. 7]" (documento único).

const GROUP = /\[\s*((?:D\d+|p{1,2}\.?|pág(?:ina)?s?\.?)[^\][]{0,80})\]/gi
const DASH = /\s*[-–—]\s*/

/** Interpreta o miolo de um colchete. Devolve [{ doc, page, end }]. */
export function parseGroup(inner) {
  const refs = []
  const segments = inner.split(/;/)
  let lastDoc = 1
  for (const segment of segments) {
    const doc = segment.match(/^\s*D(\d+)\b/i)
    if (doc) lastDoc = Number(doc[1])
    const rest = segment.replace(/^\s*D\d+\b[\s,]*/i, '')
    // "p.7", "pp. 7-8", "7, 9", "p. 7, p. 9"
    const pages = rest.match(/\d+(?:\s*[-–—]\s*\d+)?/g)
    if (!pages) continue
    for (const token of pages) {
      const [a, b] = token.split(DASH).map(Number)
      if (!Number.isFinite(a) || a < 1) continue
      refs.push({ doc: lastDoc, page: a, end: b && b >= a ? b : a })
    }
  }
  return refs
}

/** Quebra um texto em pedaços de texto puro e citações. */
export function splitCitations(text) {
  const parts = []
  const source = String(text ?? '')
  let last = 0
  GROUP.lastIndex = 0
  for (let m = GROUP.exec(source); m; m = GROUP.exec(source)) {
    const refs = parseGroup(m[1])
    if (!refs.length) continue
    if (m.index > last) parts.push({ type: 'text', value: source.slice(last, m.index) })
    parts.push({ type: 'cite', raw: m[0], refs, index: m.index })
    last = m.index + m[0].length
  }
  if (last < source.length) parts.push({ type: 'text', value: source.slice(last) })
  return parts
}

export function citationLabel(ref) {
  const pages = ref.end > ref.page ? `${ref.page}–${ref.end}` : `${ref.page}`
  return `D${ref.doc} p.${pages}`
}

const QUOTE_BEFORE = /["“«„]([^"“”«»„]{12,500})["”»“]\s*[.,;:)]*\s*$/

/**
 * Trecho entre aspas colado antes de uma citação. Aceita aspas retas, curvas e
 * « ». `content` é a resposta inteira; `index` é onde a citação começa.
 */
export function quoteBefore(content, index) {
  const before = String(content).slice(0, index)
  const match = before.match(QUOTE_BEFORE)
  return match ? match[1].trim() : ''
}

/** Todas as citações de um texto, com o trecho que as precede (para exportar). */
export function listCitations(content) {
  return splitCitations(content)
    .filter((part) => part.type === 'cite')
    .map((part) => ({ ...part, quote: part.refs.length === 1 ? quoteBefore(content, part.index) : '' }))
}

/** Aviso que o backend acrescenta ao texto quando o modelo estoura o limite. */
const TRUNCATED_NOTICE = /\n*\*\(Resposta interrompida pelo limite de tamanho do modelo\.\)\*\s*$/

export function stripTruncatedNotice(text) {
  return String(text ?? '').replace(TRUNCATED_NOTICE, '')
}

/**
 * Citação não verificada: o backend (`done.citations`) marca valid=false quando
 * o modelo citou uma página que não estava no contexto enviado. Sem a lista
 * (resposta ainda chegando, conversa antiga) nada é marcado.
 */
export function isInvalidRef(citations, ref) {
  if (!Array.isArray(citations)) return false
  return citations.some((c) => c && c.valid === false && c.doc === ref.doc && c.page >= ref.page && c.page <= ref.end)
}
