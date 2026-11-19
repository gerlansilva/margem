import { describe, expect, it } from 'vitest'
import {
  abntName,
  canDownload,
  citationsLabel,
  createCache,
  createLibraryMatcher,
  doiUrl,
  formatAuthors,
  formatReference,
  isDirectPdf,
  mergeWorks,
  normalizeDoi,
  normalizeTitle,
  sameTitle,
} from '../related'

describe('normalizeTitle / sameTitle', () => {
  it('ignora acento, caixa, pontuação e .pdf', () => {
    expect(normalizeTitle('Letramento Estatístico: um estudo (2021).pdf')).toBe('letramento estatistico um estudo 2021')
  })
  it('reconhece o mesmo título com formatação diferente', () => {
    expect(sameTitle('LETRAMENTO ESTATÍSTICO de professores', 'Letramento estatístico de professores.')).toBe(true)
  })
  it('aceita nome de arquivo cortado ou com sufixo, mas só com título longo', () => {
    expect(sameTitle('Letramento estatístico de professores - Souza', 'Letramento estatístico de professores')).toBe(true)
    expect(sameTitle('Introdução', 'Introdução')).toBe(false) // curto demais para confiar
    expect(sameTitle('Estatística na escola', 'Estatística na escola básica brasileira hoje')).toBe(false)
  })
  it('títulos diferentes não casam', () => {
    expect(sameTitle('Variabilidade e amostragem no ensino médio', 'Variabilidade e amostragem na licenciatura')).toBe(false)
  })
})

describe('normalizeDoi', () => {
  it('tira prefixos, caixa e pontuação final', () => {
    expect(normalizeDoi('https://doi.org/10.1234/ABC.def-1.')).toBe('10.1234/abc.def-1')
    expect(normalizeDoi('doi: 10.5555/xyz')).toBe('10.5555/xyz')
    expect(normalizeDoi('http://dx.doi.org/10.5555/xyz')).toBe('10.5555/xyz')
  })
  it('rejeita o que não é DOI', () => {
    expect(normalizeDoi('abc')).toBe('')
    expect(normalizeDoi(null)).toBe('')
    expect(normalizeDoi('10.12/curto')).toBe('')
  })
  it('doiUrl monta o link', () => {
    expect(doiUrl('DOI:10.1234/Abc')).toBe('https://doi.org/10.1234/abc')
    expect(doiUrl('')).toBe('')
  })
})

describe('createLibraryMatcher', () => {
  const docs = [
    { id: 'd1', name: 'artigo-2colunas', original_title: 'artigo-2colunas' },
    { id: 'd2', name: 'Letramento estatístico de professores: um estudo no Brasil', original_title: 'doc2.pdf' },
    { id: 'd3', name: 'Sem relação' },
  ]
  const known = { d1: { id: 'https://openalex.org/W1', doi: '10.1234/AAA', title: 'X' } }
  const match = createLibraryMatcher(docs, known)
  it('acha por id do trabalho', () => {
    expect(match({ id: 'https://openalex.org/W1', doi: null, title: 'qualquer coisa' })).toBe('d1')
  })
  it('acha por DOI normalizado', () => {
    expect(match({ id: 'W9', doi: 'https://doi.org/10.1234/aaa', title: 'outro' })).toBe('d1')
  })
  it('acha por título normalizado', () => {
    expect(match({ id: 'W9', doi: null, title: 'LETRAMENTO ESTATÍSTICO DE PROFESSORES - UM ESTUDO NO BRASIL' })).toBe('d2')
  })
  it('devolve null quando não está na biblioteca', () => {
    expect(match({ id: 'W9', doi: '10.9999/zzz', title: 'Algo inédito sobre amostragem' })).toBe(null)
    expect(match(null)).toBe(null)
  })
  it('ignora vínculos de documentos que saíram da biblioteca', () => {
    const m = createLibraryMatcher([{ id: 'd3', name: 'Sem relação' }], known)
    expect(m({ id: 'https://openalex.org/W1', title: 'x' })).toBe(null)
  })
})

describe('formatAuthors', () => {
  it('até 3 autores, sem et al.', () => {
    expect(formatAuthors(['A', 'B', 'C'], 3)).toBe('A, B, C')
    expect(formatAuthors(['A'], 1)).toBe('A')
  })
  it('mais de 3: três e et al.', () => {
    expect(formatAuthors(['A', 'B', 'C', 'D', 'E'], 5)).toBe('A, B, C et al.')
  })
  it('usa authors_total quando a lista veio cortada', () => {
    expect(formatAuthors(['A', 'B'], 9)).toBe('A, B et al.')
    expect(formatAuthors(['A', 'B', 'C'], 7)).toBe('A, B, C et al.')
  })
  it('vazio', () => {
    expect(formatAuthors([], 0)).toBe('')
    expect(formatAuthors(undefined)).toBe('')
  })
})

describe('formatReference', () => {
  const work = {
    title: 'Letramento estatístico de professores: um estudo no Brasil.',
    authors: ['Ana Souza', 'Carlos Pereira'],
    authors_total: 2,
    year: 2021,
    venue: 'Educação Matemática Pesquisa',
    doi: '10.5555/mock.letramento',
    url: 'https://openalex.org/W1',
  }
  it('abntName', () => {
    expect(abntName('Celi Espasandin Lopes')).toBe('LOPES, Celi Espasandin')
    expect(abntName('Platão')).toBe('Platão')
  })
  it('monta a referência com DOI', () => {
    expect(formatReference(work)).toBe(
      'SOUZA, Ana; PEREIRA, Carlos. Letramento estatístico de professores: um estudo no Brasil. Educação Matemática Pesquisa, 2021. Disponível em: https://doi.org/10.5555/mock.letramento.',
    )
  })
  it('mais de três autores: primeiro et al.; sem DOI usa a URL; sem periódico', () => {
    const ref = formatReference({ ...work, authors: ['Ana Souza', 'B C', 'D E'], authors_total: 6, doi: null, venue: null })
    expect(ref).toBe('SOUZA, Ana et al. Letramento estatístico de professores: um estudo no Brasil. 2021. Disponível em: https://openalex.org/W1.')
  })
  it('sem autores', () => {
    expect(formatReference({ title: 'Só título', authors: [], year: null, venue: null, doi: null, url: '' })).toBe('Só título.')
    expect(formatReference(null)).toBe('')
  })
})

describe('PDF direto e baixar', () => {
  it('isDirectPdf', () => {
    expect(isDirectPdf('https://repo.example.org/a/b.pdf')).toBe(true)
    expect(isDirectPdf('https://repo.example.org/a/b.PDF?download=1')).toBe(true)
    expect(isDirectPdf('https://arxiv.org/pdf/2101.00001')).toBe(true)
    expect(isDirectPdf('https://www.scielo.org/artigo/W1')).toBe(false)
    expect(isDirectPdf('https://x.org/pdf.html')).toBe(false)
    expect(isDirectPdf('ftp://x.org/a.pdf')).toBe(false)
    expect(isDirectPdf(null)).toBe(false)
  })
  it('canDownload exige acesso aberto e PDF direto', () => {
    expect(canDownload({ is_oa: true, oa_url: 'https://x.org/a.pdf' })).toBe(true)
    expect(canDownload({ is_oa: false, oa_url: 'https://x.org/a.pdf' })).toBe(false)
    expect(canDownload({ is_oa: true, oa_url: 'https://x.org/pagina' })).toBe(false)
    expect(canDownload(null)).toBe(false)
  })
})

describe('citationsLabel / mergeWorks / createCache', () => {
  it('citações', () => {
    expect(citationsLabel(0)).toBe('0 citações')
    expect(citationsLabel(1)).toBe('1 citação')
    expect(citationsLabel(128)).toBe('128 citações')
    expect(citationsLabel(1200)).toBe('1,2 mil citações')
    expect(citationsLabel(25000)).toBe('25 mil citações')
  })
  it('mergeWorks não repete ids', () => {
    expect(mergeWorks([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]).map((w) => w.id)).toEqual([1, 2, 3])
  })
  it('cache com validade', () => {
    let t = 0
    const cache = createCache(1000, () => t)
    expect(cache.get('a')).toBe(null)
    cache.set('a', 1)
    expect(cache.get('a')).toEqual({ value: 1, fresh: true })
    t = 1000
    expect(cache.get('a')).toEqual({ value: 1, fresh: false })
    cache.delete('a')
    expect(cache.get('a')).toBe(null)
  })
})
