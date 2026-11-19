import { describe, expect, it } from 'vitest'
import { citationLabel, isInvalidRef, listCitations, parseGroup, quoteBefore, splitCitations, stripTruncatedNotice } from '../citations'

describe('parseGroup', () => {
  it('lê página simples e intervalo', () => {
    expect(parseGroup('D1 p.7')).toEqual([{ doc: 1, page: 7, end: 7 }])
    expect(parseGroup('D2, p. 3-5')).toEqual([{ doc: 2, page: 3, end: 5 }])
    expect(parseGroup('D1 pp. 7–8')).toEqual([{ doc: 1, page: 7, end: 8 }])
  })
  it('lê várias páginas e vários documentos', () => {
    expect(parseGroup('D1 p.7, 9')).toHaveLength(2)
    const refs = parseGroup('D1 p.7; D2 p.3')
    expect(refs.map((r) => [r.doc, r.page])).toEqual([[1, 7], [2, 3]])
  })
  it('herda o documento anterior e ignora página 0', () => {
    expect(parseGroup('D3 p.1; p.2').map((r) => r.doc)).toEqual([3, 3])
    expect(parseGroup('D1 p.0')).toEqual([])
  })
})

describe('splitCitations', () => {
  it('separa texto e citações', () => {
    const parts = splitCitations('Fato [D1 p.7] e outro [D2 p.3].')
    expect(parts.map((p) => p.type)).toEqual(['text', 'cite', 'text', 'cite', 'text'])
    expect(parts[1].refs[0]).toMatchObject({ doc: 1, page: 7 })
  })
  it('aceita "[p. 7]" e não confunde colchetes comuns', () => {
    expect(splitCitations('veja [p. 7]').some((p) => p.type === 'cite')).toBe(true)
    expect(splitCitations('lista [1] e [a, b]').every((p) => p.type === 'text')).toBe(true)
  })
  it('lida com entradas vazias', () => {
    expect(splitCitations('')).toEqual([])
    expect(splitCitations(null)).toEqual([])
  })
})

describe('citationLabel / quoteBefore / listCitations', () => {
  it('formata o rótulo', () => {
    expect(citationLabel({ doc: 1, page: 7, end: 7 })).toBe('D1 p.7')
    expect(citationLabel({ doc: 1, page: 7, end: 9 })).toBe('D1 p.7–9')
  })
  it('acha o trecho entre aspas antes da citação', () => {
    const text = 'Diz: “a variabilidade é central ao pensamento estatístico” [D1 p.7]'
    expect(quoteBefore(text, text.indexOf('['))).toBe('a variabilidade é central ao pensamento estatístico')
    expect(quoteBefore('sem aspas [D1 p.1]', 10)).toBe('')
  })
  it('lista as citações do texto', () => {
    expect(listCitations('a [D1 p.1] b [D1 p.2]').length).toBe(2)
  })
})

describe('citações verificadas e resposta truncada', () => {
  const citations = [
    { label: 'D1', doc: 1, page: 7, valid: true },
    { label: 'D1', doc: 1, page: 99, valid: false },
    { label: 'D2', doc: 2, page: 3, valid: false },
  ]
  it('marca inválida só a citação que o backend recusou, inclusive em intervalo', () => {
    expect(isInvalidRef(citations, { doc: 1, page: 7, end: 7 })).toBe(false)
    expect(isInvalidRef(citations, { doc: 1, page: 99, end: 99 })).toBe(true)
    expect(isInvalidRef(citations, { doc: 1, page: 98, end: 100 })).toBe(true)
    expect(isInvalidRef(citations, { doc: 2, page: 3, end: 3 })).toBe(true)
    expect(isInvalidRef(citations, { doc: 3, page: 1, end: 1 })).toBe(false)
  })
  it('sem a lista nada é marcado', () => {
    expect(isInvalidRef(undefined, { doc: 1, page: 1, end: 1 })).toBe(false)
  })
  it('remove o aviso de truncamento do fim do texto', () => {
    const t = 'Texto.\n\n*(Resposta interrompida pelo limite de tamanho do modelo.)*'
    expect(stripTruncatedNotice(t)).toBe('Texto.')
    expect(stripTruncatedNotice('sem aviso')).toBe('sem aviso')
  })
})
