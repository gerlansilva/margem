// Atalhos compatíveis com macOS (Cmd) e Windows/Linux (Ctrl).
export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')

export const MOD_LABEL = isMac ? '⌘' : 'Ctrl'
export const SHIFT_LABEL = isMac ? '⇧' : 'Shift'

/** O modificador "de comando" da plataforma está apertado (e o outro não)? */
export function hasMod(event) {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** Rótulo de atalho: shortcut('F') → "⌘F" ou "Ctrl+F". */
export function shortcut(key, { shift = false } = {}) {
  const parts = [MOD_LABEL]
  if (shift) parts.push(SHIFT_LABEL)
  parts.push(key)
  return isMac ? parts.join('') : parts.join('+')
}

/** Foco está num campo de texto (atalhos de uma tecla não devem disparar)? */
export function isTyping(target) {
  const el = target
  if (!el || !el.tagName) return false
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
}
