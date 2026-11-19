// Âncoras de texto: guardam o trecho + contexto e o reencontram no DOM da
// página, mesmo depois de re-render, zoom ou troca de largura.
import { findAll } from './search'

const CONTEXT = 24

/** Texto indexável de uma raiz: exatamente o que Range.toString() enxerga. */
export function textOf(root) {
  return root.textContent || ''
}

/** Intervalo de texto → { text, prefix, suffix, offset } relativo a `root`. */
export function makeAnchor(root, range) {
  const pre = root.ownerDocument.createRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.startContainer, range.startOffset)
  const offset = pre.toString().length
  const text = range.toString()
  const all = textOf(root)
  return {
    text,
    prefix: all.slice(Math.max(0, offset - CONTEXT), offset),
    suffix: all.slice(offset + text.length, offset + text.length + CONTEXT),
    offset,
  }
}

/** [início, fim) em offsets de texto → Range no DOM. */
export function rangeFromOffsets(root, start, end) {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */)
  const range = doc.createRange()
  let pos = 0
  let startSet = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.data.length
    if (!startSet && start < pos + len) {
      range.setStart(node, start - pos)
      startSet = true
    }
    if (startSet && end <= pos + len) {
      range.setEnd(node, end - pos)
      return range
    }
    pos += len
  }
  return startSet ? range : null
}

/** Acha a melhor ocorrência da âncora no texto; devolve { start, end } ou null. */
export function locate(all, anchor) {
  if (!anchor?.text) return null
  const hits = findAllExact(all, anchor.text)
  if (!hits.length) return null
  let best = hits[0]
  let bestScore = -Infinity
  for (const at of hits) {
    const pre = all.slice(Math.max(0, at - anchor.prefix.length), at)
    const suf = all.slice(at + anchor.text.length, at + anchor.text.length + anchor.suffix.length)
    let score = -Math.abs(at - (anchor.offset ?? 0)) / 1000
    if (anchor.prefix && pre === anchor.prefix) score += 2
    if (anchor.suffix && suf === anchor.suffix) score += 2
    if (score > bestScore) {
      bestScore = score
      best = at
    }
  }
  return { start: best, end: best + anchor.text.length }
}

function findAllExact(all, text) {
  const hits = []
  for (let i = all.indexOf(text); i >= 0; i = all.indexOf(text, i + 1)) hits.push(i)
  return hits
}

export function resolveAnchor(root, anchor) {
  const found = locate(textOf(root), anchor)
  return found ? rangeFromOffsets(root, found.start, found.end) : null
}

/** Ranges de todas as ocorrências da busca dentro de `root`. */
export function searchRanges(root, query) {
  return findAll(textOf(root), query).map((at) => {
    const len = query.trim().length
    return rangeFromOffsets(root, at, at + len)
  }).filter(Boolean)
}
