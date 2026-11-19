// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { locate, makeAnchor, rangeFromOffsets, resolveAnchor, searchRanges, textOf } from '../anchors'

function setup(html) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}

describe('anchors', () => {
  it('cria e resolve a âncora atravessando elementos', () => {
    const root = setup('<p>A média é <em>sensível</em> a valores extremos.</p><p>A média é outra.</p>')
    const range = rangeFromOffsets(root, textOf(root).indexOf('sensível'), textOf(root).indexOf('sensível') + 8)
    const anchor = makeAnchor(root, range)
    expect(anchor.text).toBe('sensível')
    expect(resolveAnchor(root, anchor).toString()).toBe('sensível')
  })
  it('desambigua repetições pelo contexto', () => {
    const root = setup('<p>A média é alta. A média é baixa.</p>')
    const all = textOf(root)
    const second = all.lastIndexOf('média')
    const anchor = makeAnchor(root, rangeFromOffsets(root, second, second + 5))
    expect(locate(all, anchor).start).toBe(second)
  })
  it('devolve null se o trecho sumiu', () => {
    const root = setup('<p>texto novo</p>')
    expect(resolveAnchor(root, { text: 'antigo', prefix: '', suffix: '', offset: 0 })).toBeNull()
  })
  it('acha ocorrências da busca sem acento', () => {
    const root = setup('<p>Estatística, estatistica e ESTATÍSTICA.</p>')
    expect(searchRanges(root, 'estatistica')).toHaveLength(3)
  })
})
