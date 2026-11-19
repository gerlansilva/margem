import { describe, expect, it } from 'vitest'
import { conversationToMarkdown, notesToMarkdown, safeFileName } from '../exporters'

const now = new Date(2026, 0, 5, 9, 7)
describe('exporters', () => {
  it('exporta a conversa com citações e seleção', () => {
    const md = conversationToMarkdown({
      docs: [{ name: 'A.pdf' }, { name: 'B.pdf' }],
      messages: [
        { role: 'user', content: 'O que é média?', selection: 'trecho\nlinha 2' },
        { role: 'assistant', content: 'É isto [D2 p.4].' },
      ],
      now,
    })
    expect(md).toContain('# Conversa — A.pdf; B.pdf')
    expect(md).toContain('- D2: B.pdf')
    expect(md).toContain('> trecho')
    expect(md).toContain('2026-01-05 09:07')
    expect(md).toContain('D2 p.4')
    expect(md.endsWith('\n')).toBe(true)
  })
  it('exporta notas agrupadas por página', () => {
    const md = notesToMarkdown({
      doc: { name: 'A.pdf' },
      annotations: [
        { page: 3, color: 'green', text: 'segundo', note: 'minha\nnota', anchor: { offset: 10 } },
        { page: 1, color: 'yellow', text: 'primeiro', note: '', anchor: { offset: 5 } },
      ],
      now,
    })
    expect(md.indexOf('## Página 1')).toBeLessThan(md.indexOf('## Página 3'))
    expect(md).toContain('- Cor: verde')
    expect(md).toContain('- Nota: minha\n  nota')
  })
  it('sem destaques diz isso', () => {
    expect(notesToMarkdown({ doc: { name: 'x' }, annotations: [], now })).toContain('Nenhum destaque')
  })
  it('gera nomes de arquivo seguros no Windows e no macOS', () => {
    const name = safeFileName('Notas: a/b?*"<>|.pdf', 'md')
    expect(name).toMatch(/\.md$/)
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
  })
})
