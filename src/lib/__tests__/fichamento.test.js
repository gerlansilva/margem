import { describe, expect, it } from 'vitest'
import { parseCsv } from '../csv'
import {
  fichamentoTable,
  formatFichamento,
  mergeCells,
  moveItem,
  planExtraction,
  pruneSelection,
  runPool,
  runExtractionJob,
  isCancelledError,
  isBusyError,
  newExtractRequestId,
  scopeDocs,
  toCsvText,
  toHtmlTable,
  toMarkdownTable,
  toTsv,
  toggleId,
} from '../fichamento'

const docs = [
  { id: 'a', name: 'Artigo A', page_count: 4 },
  { id: 'b', name: 'Artigo B', page_count: 2 },
  { id: 'c', name: 'Sem texto', page_count: 0 },
]
const columns = [
  { id: 'c1', name: 'Objetivo' },
  { id: 'c2', name: 'Método' },
]
const cell = (doc, col, value, page = 1, quote = `trecho ${value}`) => ({
  doc_id: doc,
  column_id: col,
  value,
  page,
  quote,
  status: value ? 'ok' : 'not_found',
})

describe('seleção', () => {
  it('alterna ids na ordem de marcação', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b'])
  })
  it('sem seleção usa todos os documentos com texto; com seleção, só eles na ordem da biblioteca', () => {
    expect(scopeDocs(docs, []).map((d) => d.id)).toEqual(['a', 'b'])
    expect(scopeDocs(docs, ['b', 'a']).map((d) => d.id)).toEqual(['a', 'b'])
    expect(scopeDocs(docs, ['b']).map((d) => d.id)).toEqual(['b'])
    expect(scopeDocs(docs, ['c']).map((d) => d.id)).toEqual([])
  })
  it('descarta ids removidos ou sem texto', () => {
    expect(pruneSelection(['a', 'x', 'c'], docs)).toEqual(['a'])
    const same = ['a']
    expect(pruneSelection(same, docs)).toBe(same)
  })
})

describe('planExtraction', () => {
  const cells = [cell('a', 'c1', 'x'), cell('a', 'c2', ''), cell('b', 'c1', 'y'), cell('b', 'c2', 'z')]
  const ready = docs.slice(0, 2)
  it('all: uma tarefa por documento, todas as colunas (null)', () => {
    const plan = planExtraction({ docs: ready, columns, cells })
    expect(plan.map((t) => [t.doc.id, t.columnIds])).toEqual([['a', null], ['b', null]])
  })
  it('só uma coluna', () => {
    const plan = planExtraction({ docs: ready, columns, cells, columnIds: ['c2'] })
    expect(plan.map((t) => t.columnIds)).toEqual([['c2'], ['c2']])
  })
  it('pending: só células vazias ou não encontradas', () => {
    const plan = planExtraction({ docs: ready, columns, cells, mode: 'pending' })
    expect(plan.map((t) => [t.doc.id, t.columnIds])).toEqual([['a', ['c2']]])
  })
  it('pending sem nenhuma célula: tudo como null', () => {
    const plan = planExtraction({ docs: ready, columns, cells: [], mode: 'pending' })
    expect(plan.map((t) => t.columnIds)).toEqual([null, null])
  })
  it('coluna nova pendente só nos documentos que ainda não têm', () => {
    const plan = planExtraction({ docs: ready, columns, cells: [cell('a', 'c1', 'x')], mode: 'pending', columnIds: ['c1'] })
    expect(plan.map((t) => t.doc.id)).toEqual(['b'])
  })
  it('sem colunas, sem tarefas', () => {
    expect(planExtraction({ docs: ready, columns: [], cells })).toEqual([])
  })
})

describe('mergeCells', () => {
  const prev = [cell('a', 'c1', 'velho1'), cell('a', 'c2', 'velho2'), cell('b', 'c1', 'b1')]
  it('extrair só c2 mantém c1 do mesmo documento', () => {
    const next = mergeCells(prev, [cell('a', 'c2', 'novo2')], 'a', ['c2'])
    expect(next.find((c) => c.doc_id === 'a' && c.column_id === 'c1').value).toBe('velho1')
    expect(next.find((c) => c.doc_id === 'a' && c.column_id === 'c2').value).toBe('novo2')
    expect(next).toHaveLength(3)
  })
  it('backend que devolve o documento inteiro não duplica', () => {
    const next = mergeCells(prev, [cell('a', 'c1', 'velho1'), cell('a', 'c2', 'novo2')], 'a', ['c2'])
    expect(next.filter((c) => c.doc_id === 'a')).toHaveLength(2)
  })
  it('columnIds null substitui o documento todo', () => {
    const next = mergeCells(prev, [cell('a', 'c1', 'n1')], 'a', null)
    expect(next.filter((c) => c.doc_id === 'a').map((c) => c.value)).toEqual(['n1'])
    expect(next.some((c) => c.doc_id === 'b')).toBe(true)
  })
})

describe('runPool', () => {
  it('respeita o limite de concorrência e preserva a ordem dos resultados', async () => {
    let running = 0
    let peak = 0
    const out = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running -= 1
      return n * 2
    })
    expect(peak).toBe(3)
    expect(out.map((r) => r.value)).toEqual([2, 4, 6, 8, 10, 12, 14])
  })
  it('erro em um item não derruba os outros', async () => {
    const out = await runPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('falhou')
      return n
    })
    expect(out.map((r) => r.ok)).toEqual([true, false, true])
    expect(out[1].error.message).toBe('falhou')
  })
  it('cancelar impede novos itens e deixa o que já começou terminar', async () => {
    const controller = new AbortController()
    const started = []
    const out = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n)
      await new Promise((r) => setTimeout(r, 5))
      if (n === 1) controller.abort()
      return n
    }, { signal: controller.signal })
    expect(started).toEqual([1, 2])
    expect(out.filter((r) => r.skipped)).toHaveLength(3)
    expect(out.filter((r) => r.ok)).toHaveLength(2)
  })
  it('lista vazia', async () => {
    expect(await runPool([], 3, async () => 1)).toEqual([])
  })
})

describe('moveItem', () => {
  it('reordena sem mutar', () => {
    const list = ['a', 'b', 'c']
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveItem(list, 2, 0)).toEqual(['c', 'a', 'b'])
    expect(list).toEqual(['a', 'b', 'c'])
    expect(moveItem(list, 1, 1)).toBe(list)
    expect(moveItem(list, 0, 9)).toBe(list)
  })
})

describe('formatadores', () => {
  const cells = [
    cell('a', 'c1', 'Alvo\tcom tab', 3, 'Ele disse "oi"\ne saiu'),
    cell('a', 'c2', 'linha1\nlinha2', 5),
    cell('b', 'c1', '=SOMA(A1)', 1),
    cell('b', 'c2', '', 1),
  ]
  const data = { docs: docs.slice(0, 2), columns, cells }

  it('tabela básica: cabeçalho e linhas', () => {
    const t = fichamentoTable(data)
    expect(t.head).toEqual(['Documento', 'Objetivo', 'Método'])
    expect(t.rows[1]).toEqual(['Artigo B', '=SOMA(A1)', ''])
  })
  it('página e trecho opcionais', () => {
    const t = fichamentoTable({ ...data, page: true, quote: true })
    expect(t.rows[0][1]).toBe('Alvo\tcom tab (p.3)\n“Ele disse "oi"\ne saiu”')
    expect(fichamentoTable({ ...data, page: true }).rows[0][2]).toBe('linha1\nlinha2 (p.5)')
    expect(fichamentoTable({ ...data, quote: true }).rows[1][2]).toBe('')
  })
  it('TSV: escapa tab, quebra de linha e aspas; protege fórmula', () => {
    const tsv = toTsv(fichamentoTable({ ...data, quote: true }))
    const rows = parseCsv(tsv, '\t')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual(['Documento', 'Objetivo', 'Método'])
    expect(rows[1][1]).toBe('Alvo\tcom tab\n“Ele disse "oi"\ne saiu”')
    expect(rows[1][2]).toBe('linha1\nlinha2\n“trecho linha1\nlinha2”')
    expect(rows[2][1]).toBe("'=SOMA(A1)\n“trecho =SOMA(A1)”")
    expect(tsv.endsWith('\n')).toBe(false)
  })
  it('TSV simples não usa aspas', () => {
    expect(toTsv({ head: ['a', 'b'], rows: [['1', '2']] })).toBe('a\tb\n1\t2')
  })
  it('Markdown: escapa barra vertical e troca quebra por <br>', () => {
    const md = toMarkdownTable({ head: ['A', 'B'], rows: [['x|y', 'l1\nl2']] })
    expect(md).toBe('| A | B |\n| --- | --- |\n| x\\|y | l1<br>l2 |')
  })
  it('HTML: escapa tags e aspas; quebra vira <br>', () => {
    const html = toHtmlTable({ head: ['A'], rows: [['<b>"x"</b> & y\nz']] })
    expect(html).toContain('<th>A</th>')
    expect(html).toContain('<td>&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; y<br>z</td>')
    expect(html.startsWith('<table')).toBe(true)
  })
  it('CSV: aspas duplicadas, quebra preservada entre aspas, sem BOM', () => {
    const csv = toCsvText(fichamentoTable({ ...data, quote: true }))
    expect(csv.charCodeAt(0)).not.toBe(0xfeff)
    const rows = parseCsv(csv)
    expect(rows[1][1]).toBe('Alvo\tcom tab\n“Ele disse "oi"\ne saiu”')
    expect(rows[2][1]).toBe("'=SOMA(A1)\n“trecho =SOMA(A1)”")
  })
  it('formatFichamento devolve html só para tabela', () => {
    expect(formatFichamento('table', data).html).toContain('<table')
    expect(formatFichamento('markdown', data).html).toBeUndefined()
    expect(formatFichamento('csv', data).text.split('\n')[0]).toBe('Documento,Objetivo,Método')
  })
})

describe('erros de extração', () => {
  it('reconhece cancelamento e documento ocupado (string ou Error)', () => {
    expect(isCancelledError('Operação cancelada.')).toBe(true)
    expect(isCancelledError(new Error('Operação cancelada.'))).toBe(true)
    expect(isCancelledError('Falhou')).toBe(false)
    expect(isBusyError('Este documento já está sendo extraído. Aguarde terminar.')).toBe(true)
    expect(isBusyError('Operação cancelada.')).toBe(false)
    expect(isBusyError(undefined)).toBe(false)
  })
  it('requestId é único por chamada', () => {
    expect(newExtractRequestId('a')).not.toBe(newExtractRequestId('a'))
  })
})

describe('runExtractionJob', () => {
  const task = (id) => ({ doc: { id, name: id }, columnIds: null })
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

  /** Backend falso: grava ao terminar; cancelar durante a espera não grava nada. */
  function fakeBackend({ delay = 30, busy = new Set() } = {}) {
    const saved = []
    const cancelled = new Set()
    const calls = []
    let running = 0
    let peak = 0
    const extract = async (docId, ids, requestId) => {
      calls.push({ docId, requestId })
      if (busy.has(docId)) throw 'Este documento já está sendo extraído. Aguarde terminar.'
      running += 1
      peak = Math.max(peak, running)
      try {
        const until = Date.now() + delay
        while (Date.now() < until) {
          if (cancelled.has(requestId)) throw 'Operação cancelada.'
          await tick(2)
        }
        saved.push(docId)
        return [{ doc_id: docId, column_id: 'c1' }]
      } finally {
        running -= 1
      }
    }
    return { extract, saved, calls, cancelRequest: async (id) => cancelled.add(id), peak: () => peak, cancelled }
  }

  it('sem cancelar: tudo gravado, no máximo 3 ao mesmo tempo, requestId distinto por documento', async () => {
    const be = fakeBackend()
    const out = await runExtractionJob({ tasks: ['a', 'b', 'c', 'd', 'e'].map(task), extract: be.extract, cancelRequest: be.cancelRequest })
    expect(out.map((o) => o.status)).toEqual(Array(5).fill('done'))
    expect(be.peak()).toBe(3)
    expect(new Set(be.calls.map((c) => c.requestId)).size).toBe(5)
    expect(be.saved).toHaveLength(5)
  })

  it('cancelar no meio: cancel_chat para as em andamento, as da fila nem começam, nada gravado delas', async () => {
    const be = fakeBackend({ delay: 80 })
    const controller = new AbortController()
    const started = []
    const finished = []
    const job = runExtractionJob({
      tasks: ['a', 'b', 'c', 'd', 'e'].map(task),
      extract: be.extract,
      cancelRequest: be.cancelRequest,
      signal: controller.signal,
      onStart: (t, id) => started.push([t.doc.id, id]),
      onFinish: (t, _id, o) => finished.push([t.doc.id, o.status]),
    })
    await tick(20)
    controller.abort()
    const out = await job
    expect(started.map(([d]) => d)).toEqual(['a', 'b', 'c'])
    expect([...be.cancelled].sort()).toEqual(started.map(([, id]) => id).sort())
    expect(be.saved).toEqual([])
    expect(out.every((o) => o.status === 'cancelled')).toBe(true)
    expect(out.filter((o) => o.skipped)).toHaveLength(2)
    expect(finished.every(([, st]) => st === 'cancelled')).toBe(true)
    expect(be.calls).toHaveLength(3)
  })

  it('cancelar depois de um documento terminar mantém o que já foi gravado', async () => {
    const be = fakeBackend({ delay: 30 })
    const controller = new AbortController()
    const out = await runExtractionJob({
      tasks: ['a', 'b', 'c', 'd', 'e', 'f'].map(task),
      extract: be.extract,
      cancelRequest: be.cancelRequest,
      signal: controller.signal,
      onFinish: (_t, _id, o) => o.status === 'done' && controller.abort(),
    })
    expect(be.saved.length).toBeGreaterThanOrEqual(1)
    expect(out.filter((o) => o.status === 'done')).toHaveLength(be.saved.length)
    expect(out.length).toBe(6)
  })

  it('documento já em extração vira "busy" (não é erro nem derruba os outros)', async () => {
    const be = fakeBackend({ busy: new Set(['b']) })
    const out = await runExtractionJob({ tasks: ['a', 'b', 'c'].map(task), extract: be.extract, cancelRequest: be.cancelRequest })
    expect(out.map((o) => o.status)).toEqual(['done', 'busy', 'done'])
    expect(be.saved).toEqual(['a', 'c'])
  })

  it('erro comum vira "error"; "Operação cancelada." sem abortar vira "cancelled"', async () => {
    const extract = async (id) => {
      if (id === 'a') throw 'A DeepSeek devolveu um erro: x'
      throw 'Operação cancelada.'
    }
    const out = await runExtractionJob({ tasks: ['a', 'b'].map(task), extract })
    expect(out.map((o) => o.status)).toEqual(['error', 'cancelled'])
    expect(out[0].error).toMatch(/DeepSeek/)
  })
})
