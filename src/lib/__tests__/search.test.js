import { describe, expect, it } from 'vitest'
import { findAll, fold, foldAligned, searchPages } from '../search'

describe('search', () => {
  it('ignora acento e caixa', () => {
    expect(fold('Educação ÁRVORE')).toBe('educacao arvore')
    expect(findAll('A Educação Estatística', 'educacao')).toEqual([2])
  })
  it('mantém os índices alinhados com o original', () => {
    const text = 'ﬁnal Ação ß straße'
    expect(foldAligned(text).length).toBe(text.length)
  })
  it('ignora consultas curtas e acha várias ocorrências', () => {
    expect(findAll('aaa', 'a')).toEqual([])
    expect(findAll('casa e casa', 'casa')).toEqual([0, 7])
  })
  it('busca por páginas com total e trecho', () => {
    const r = searchPages([{ n: 1, text: 'média e outra' }, { n: 2, text: 'MEDIA de novo; media' }], 'media')
    expect(r.total).toBe(3)
    expect(r.results[0].page).toBe(1)
    expect(searchPages([], 'x').total).toBe(0)
  })
})
