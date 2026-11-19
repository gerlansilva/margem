import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  countLabel,
  createLatest,
  createSearchRunner,
  debounce,
  groupHits,
  hitSegments,
  indexLabel,
  modeLabel,
} from '../library-search'

describe('hitSegments', () => {
  it('marca os ranges e preserva o resto', () => {
    expect(hitSegments('a amostra foi grande', [[2, 9]])).toEqual([
      { text: 'a ', mark: false },
      { text: 'amostra', mark: true },
      { text: ' foi grande', mark: false },
    ])
  })
  it('usa pontos de código, não unidades UTF-16', () => {
    // "😀" ocupa 2 unidades UTF-16 mas 1 caractere Unicode
    const parts = hitSegments('😀 média 😀', [[2, 7]])
    expect(parts.map((p) => p.text)).toEqual(['😀 ', 'média', ' 😀'])
    expect(parts[1].mark).toBe(true)
  })
  it('junta sobrepostos e colados, ordena e descarta inválidos', () => {
    const parts = hitSegments('abcdefghij', [[5, 8], [0, 2], [2, 3], [7, 9], [4, 4], [-3, -1], ['x', 2], null, [8, 99]])
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(['abc', 'fghij'])
  })
  it('sem ranges devolve o texto inteiro; sem texto devolve vazio', () => {
    expect(hitSegments('texto', [])).toEqual([{ text: 'texto', mark: false }])
    expect(hitSegments('texto', undefined)).toEqual([{ text: 'texto', mark: false }])
    expect(hitSegments('', [[0, 2]])).toEqual([])
    expect(hitSegments(null, null)).toEqual([])
  })
  it('limita ao tamanho do trecho', () => {
    expect(hitSegments('abc', [[1, 50]])).toEqual([
      { text: 'a', mark: false },
      { text: 'bc', mark: true },
    ])
  })
})

describe('groupHits', () => {
  const hits = [
    { doc_id: 'a', doc_title: 'A', page: 3, snippet: 'x' },
    { doc_id: 'b', doc_title: 'B', page: 1, snippet: 'y' },
    { doc_id: 'a', doc_title: 'A', page: 9, snippet: 'z' },
  ]
  it('agrupa por documento pela ordem do melhor acerto e numera na ordem da tela', () => {
    const { groups, flat } = groupHits(hits)
    expect(groups.map((g) => [g.docId, g.hits.map((h) => h.page)])).toEqual([
      ['a', [3, 9]],
      ['b', [1]],
    ])
    expect(flat.map((h) => [h.doc_id, h.page, h.index])).toEqual([
      ['a', 3, 0],
      ['a', 9, 1],
      ['b', 1, 2],
    ])
  })
  it('usa o título atual do documento (renomeado)', () => {
    const { groups } = groupHits(hits, (id, fallback) => (id === 'a' ? 'Renomeado' : fallback))
    expect(groups.map((g) => g.title)).toEqual(['Renomeado', 'B'])
  })
  it('aceita lista vazia ou ausente', () => {
    expect(groupHits([]).flat).toEqual([])
    expect(groupHits(undefined).groups).toEqual([])
  })
})

describe('rótulos', () => {
  it('contagem', () => {
    expect(countLabel(1, 1)).toBe('1 resultado')
    expect(countLabel(14, 1)).toBe('14 resultados')
    expect(countLabel(14, 3)).toBe('14 resultados em 3 documentos')
  })
  it('estado do índice', () => {
    expect(indexLabel(null, { done: 12, total: 40 })).toBe('Indexando 12/40')
    expect(indexLabel({ busy: true, docs_indexed: 3, docs_total: 9 }, null)).toBe('Indexando 3/9')
    expect(indexLabel({ busy: false, docs_indexed: 9, docs_total: 9 }, null)).toBe('')
    expect(indexLabel({ busy: false, docs_indexed: 4, docs_total: 9 }, null)).toBe('4/9 indexados')
    expect(indexLabel({ busy: false, docs_indexed: 0, docs_total: 0 }, { done: 5, total: 5 })).toBe('')
  })
  it('modo', () => {
    expect(modeLabel('hybrid')).toBe('Palavras + significado')
    expect(modeLabel('lexical')).toBe('Palavras')
    expect(modeLabel(undefined)).toBe('Palavras')
  })
})

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('só chama a última, depois do atraso', () => {
    const fn = vi.fn()
    const d = debounce(fn, 250)
    d('a')
    vi.advanceTimersByTime(200)
    d('ab')
    vi.advanceTimersByTime(249)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('ab')
  })
  it('cancel impede a chamada', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    d.cancel()
    vi.advanceTimersByTime(500)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('createLatest', () => {
  it('begin invalida o anterior e aborta o sinal', () => {
    const latest = createLatest()
    const a = latest.begin()
    expect(a.isCurrent()).toBe(true)
    const b = latest.begin()
    expect(a.isCurrent()).toBe(false)
    expect(a.signal.aborted).toBe(true)
    expect(b.isCurrent()).toBe(true)
    latest.cancel()
    expect(b.isCurrent()).toBe(false)
  })
})

describe('createSearchRunner', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (search) => {
    const states = []
    const runner = createSearchRunner({ search, onChange: (s) => states.push(s), delay: 250 })
    return { runner, states, last: () => states[states.length - 1] }
  }

  it('espera 250 ms sem digitação e faz uma só busca', async () => {
    const search = vi.fn(async () => ({ hits: [1] }))
    const { runner, last } = make(search)
    runner.schedule({ query: 'am' })
    vi.advanceTimersByTime(100)
    runner.schedule({ query: 'amo' })
    vi.advanceTimersByTime(100)
    runner.schedule({ query: 'amostra' })
    expect(last()).toEqual({ status: 'loading' })
    vi.advanceTimersByTime(249)
    expect(search).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await vi.runAllTimersAsync()
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][0]).toEqual({ query: 'amostra' })
    expect(last()).toEqual({ status: 'done', result: { hits: [1] } })
  })

  it('consulta curta volta ao estado vazio sem buscar', async () => {
    const search = vi.fn()
    const { runner, last } = make(search)
    runner.schedule({ query: ' a ' })
    await vi.runAllTimersAsync()
    expect(search).not.toHaveBeenCalled()
    expect(last()).toEqual({ status: 'idle' })
  })

  it('descarta a resposta de uma busca que ficou velha', async () => {
    const pending = {}
    const search = vi.fn(
      (params, signal) =>
        new Promise((resolve) => {
          pending[params.query] = { resolve, signal }
        }),
    )
    const { runner, states } = make(search)
    runner.schedule({ query: 'primeira' }, { immediate: true })
    await Promise.resolve()
    await Promise.resolve()
    runner.schedule({ query: 'segunda' }, { immediate: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(pending.primeira.signal.aborted).toBe(true)
    pending.segunda.resolve('B')
    await vi.runAllTimersAsync()
    pending.primeira.resolve('A') // chega depois, fora de hora
    await vi.runAllTimersAsync()
    expect(states.filter((s) => s.status === 'done').map((s) => s.result)).toEqual(['B'])
  })

  it('erro vira estado de erro; cancel descarta o que estava a caminho', async () => {
    const search = vi.fn(async () => {
      throw 'falhou'
    })
    const { runner, last, states } = make(search)
    runner.schedule({ query: 'abc' }, { immediate: true })
    await vi.runAllTimersAsync()
    expect(last()).toEqual({ status: 'error', error: 'falhou' })
    const count = states.length
    runner.schedule({ query: 'abcd' })
    runner.cancel()
    await vi.runAllTimersAsync()
    expect(search).toHaveBeenCalledTimes(1)
    expect(states.length).toBe(count + 1) // só o "loading" do agendamento
  })
})
