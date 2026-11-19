// Destaques coloridos com nota, ligados a uma página.
export const COLORS = [
  { id: 'yellow', name: 'Amarelo', hex: '#f6d860' },
  { id: 'green', name: 'Verde', hex: '#8fd18a' },
  { id: 'blue', name: 'Azul', hex: '#7db8f0' },
  { id: 'pink', name: 'Rosa', hex: '#f1a0c4' },
  { id: 'orange', name: 'Laranja', hex: '#f5a96b' },
]

export const COLOR_IDS = COLORS.map((c) => c.id)

export function makeId() {
  return (
    globalThis.crypto?.randomUUID?.() || `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  )
}

/**
 * Annotation = {
 *   id, docId, page, color, text (trecho para exibir), note,
 *   anchor: { text, prefix, suffix, offset },   // para reencontrar no texto da página
 *   createdAt, updatedAt                        // ISO 8601
 * }
 */
export function createAnnotation({ docId, page, color = 'yellow', text, anchor, note = '' }) {
  const now = new Date().toISOString()
  return { id: makeId(), docId, page, color, text, anchor, note, createdAt: now, updatedAt: now }
}

export function normalizeAnnotations(list) {
  if (!Array.isArray(list)) return []
  return list.filter((a) => a && a.id && a.page && a.text && COLOR_IDS.includes(a.color))
}

export function sortAnnotations(list) {
  return [...list].sort((a, b) => a.page - b.page || (a.anchor?.offset ?? 0) - (b.anchor?.offset ?? 0))
}
