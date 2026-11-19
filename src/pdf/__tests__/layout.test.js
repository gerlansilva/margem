import { describe, expect, it } from 'vitest'
import {
  buildVocabulary,
  cleanText,
  invert,
  joinLine,
  matchingBlocks,
  multiply,
  normalize,
  screenToPdfRect,
} from '../layout'
import { friendlyPdfError } from '../../pdf'

describe('cleanText', () => {
  it('reescreve ligaduras Unicode e controles de fontes T1', () => {
    expect(cleanText('ﬁnal ﬂuxo especí\u001cco')).toBe('final fluxo específico')
  })
  it('remove hífen macio e controles', () => {
    expect(cleanText('esta­tística')).toBe('estatística')
    expect(cleanText('a\u0000b')).toBe('ab')
  })
})

describe('joinLine (hifenização)', () => {
  const vocab = buildVocabulary(['a estatística é útil', 'situações-problema autênticas', 'consolidou-se bem'])
  it('une palavra quebrada pelo vocabulário', () => {
    expect(joinLine('a estatís-', 'tica é', vocab)).toBe('a estatística é')
  })
  it('mantém hífen verdadeiro', () => {
    expect(joinLine('as situações-', 'problema são', vocab)).toBe('as situações-problema são')
  })
  it('não junta com hífen quando é pronome oblíquo', () => {
    expect(joinLine('ele consolidou-', 'se', new Set())).toBe('ele consolidou-se')
  })
  it('sem hífen final só concatena com espaço', () => {
    expect(joinLine('uma linha', 'outra linha', vocab)).toBe('uma linha outra linha')
  })
})

describe('matrizes e retângulos', () => {
  it('multiply/invert são inversos', () => {
    const m = [0, 1, -1, 0, 100, 50]
    const id = multiply(m, invert(m))
    id.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 1, 0, 0][i], 6))
  })
  it('sem vt, vira o eixo Y', () => {
    expect(screenToPdfRect({ x: 10, y: 20, w: 100, h: 12 }, { height: 800 })).toEqual([10, 768, 110, 780])
  })
  it('desfaz uma página rotacionada em 90 graus', () => {
    // viewport de /Rotate 90 numa página 600x800: tela 800x600
    const vt = [0, 1, 1, 0, 0, 0]
    const rect = screenToPdfRect({ x: 100, y: 50, w: 20, h: 10 }, { height: 600, vt })
    expect(rect).toEqual([50, 100, 60, 120])
  })
})

describe('trechos e erros', () => {
  it('normaliza para comparar citações', () => {
    expect(normalize('  Estatís- tica   É ')).toBe('estatística é')
  })
  it('acha o bloco que contém o trecho citado', () => {
    const blocks = [{ text: 'Introdução curta demais' }, { text: 'A variabilidade é central ao pensamento estatístico moderno.' }]
    expect(matchingBlocks(blocks, 'variabilidade é central ao pensamento')).toEqual([blocks[1]])
    expect(matchingBlocks(blocks, 'curto')).toEqual([])
  })
  it('traduz erros do pdf.js', () => {
    expect(friendlyPdfError({ name: 'PasswordException', code: 1 })).toMatch(/senha/i)
    expect(friendlyPdfError({ name: 'PasswordException', code: 2 })).toMatch(/incorreta/i)
    expect(friendlyPdfError({ name: 'InvalidPDFException' })).toMatch(/corrompido/i)
    expect(friendlyPdfError(new Error('Failed to fetch'))).toMatch(/disco/i)
  })
})
