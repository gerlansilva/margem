// Exportação em Markdown: conversa e notas/destaques.
import { citationLabel, splitCitations } from './citations'

export const COLOR_NAMES = {
  yellow: 'amarelo',
  green: 'verde',
  blue: 'azul',
  pink: 'rosa',
  orange: 'laranja',
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
}

const clean = (text) => String(text ?? '').replace(/\r\n/g, '\n').trim()

/** Citações [D1 p.7] ficam como estão, mas a legenda dos documentos vai no topo. */
export function conversationToMarkdown({ docs, messages, now = new Date() }) {
  const lines = [`# Conversa — ${docs.map((d) => d.name).join('; ')}`, '', `_Exportada do Margem em ${stamp(now)}._`, '']
  lines.push('**Documentos**', '')
  docs.forEach((doc, i) => lines.push(`- D${i + 1}: ${doc.name}`))
  lines.push('')
  for (const message of messages) {
    if (message.role === 'user') {
      lines.push('## Pergunta', '')
      if (message.selection) lines.push(...clean(message.selection).split('\n').map((l) => `> ${l}`), '')
      lines.push(clean(message.content), '')
    } else {
      if (!clean(message.content) && !message.error) continue
      lines.push('## Resposta', '')
      lines.push(clean(message.content) || '_(sem texto)_', '')
      if (message.error) lines.push(`> Erro: ${message.error}`, '')
      const refs = splitCitations(message.content).filter((p) => p.type === 'cite')
      if (refs.length) {
        const unique = [...new Set(refs.flatMap((p) => p.refs.map(citationLabel)))]
        lines.push(`_Citações: ${unique.join(', ')}_`, '')
      }
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

export function notesToMarkdown({ doc, annotations, now = new Date() }) {
  const lines = [`# Notas e destaques — ${doc.name}`, '', `_Exportado do Margem em ${stamp(now)}._`, '']
  const sorted = [...annotations].sort((a, b) => a.page - b.page || (a.anchor?.offset ?? 0) - (b.anchor?.offset ?? 0))
  if (!sorted.length) lines.push('_Nenhum destaque._', '')
  let page = null
  for (const ann of sorted) {
    if (ann.page !== page) {
      page = ann.page
      lines.push(`## Página ${page}`, '')
    }
    const quote = clean(ann.text).replace(/\s+/g, ' ')
    lines.push(`> ${quote}`, '')
    lines.push(`- Cor: ${COLOR_NAMES[ann.color] || ann.color}`)
    if (clean(ann.note)) lines.push(`- Nota: ${clean(ann.note).replace(/\n/g, '\n  ')}`)
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/** Nome de arquivo seguro para Windows e macOS. */
export function safeFileName(name, ext) {
  const base =
    String(name || 'margem')
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 80) || 'margem'
  return `${base}.${ext}`
}
