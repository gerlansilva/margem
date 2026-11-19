import { describe, expect, it } from 'vitest'
import { createAnnotation, normalizeAnnotations, sortAnnotations } from '../annotations'

describe('annotations', () => {
  it('cria com id único e datas', () => {
    const a = createAnnotation({ docId: 'd', page: 2, text: 't' })
    const b = createAnnotation({ docId: 'd', page: 2, text: 't' })
    expect(a.id).not.toBe(b.id)
    expect(a.color).toBe('yellow')
    expect(Date.parse(a.createdAt)).not.toBeNaN()
  })
  it('descarta registros inválidos', () => {
    const ok = createAnnotation({ docId: 'd', page: 1, text: 'x' })
    expect(normalizeAnnotations([ok, null, { id: 1 }, { ...ok, color: 'roxo' }])).toEqual([ok])
    expect(normalizeAnnotations('lixo')).toEqual([])
  })
  it('ordena por página e posição', () => {
    const list = [
      { page: 2, anchor: { offset: 1 } },
      { page: 1, anchor: { offset: 9 } },
      { page: 1, anchor: { offset: 2 } },
    ]
    expect(sortAnnotations(list).map((a) => `${a.page}:${a.anchor.offset}`)).toEqual(['1:2', '1:9', '2:1'])
  })
})
