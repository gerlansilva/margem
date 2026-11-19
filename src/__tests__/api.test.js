import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const backend = { annotations: {}, calls: [] }
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p) => p,
  invoke: vi.fn(async (cmd, args) => {
    backend.calls.push(cmd)
    if (cmd === 'list_annotations') return backend.annotations[args.docId] || []
    if (cmd === 'save_annotations') {
      backend.annotations[args.docId] = args.annotations
      return null
    }
    if (cmd === 'write_text_file') return null
    if (cmd === 'write_csv') return args
    throw new Error(`comando inesperado ${cmd}`)
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

const { api } = await import('../api')
const { kvGet, kvSet } = await import('../store')

const legacy = (id, docId) => ({
  id,
  docId,
  page: 2,
  color: 'blue',
  text: 'trecho',
  note: '',
  anchor: { text: 'trecho', prefix: '', suffix: '', offset: 1 },
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
})

describe('api dentro do Tauri', () => {
  beforeEach(() => {
    backend.annotations = {}
    backend.calls = []
    globalThis.window = globalThis.window || globalThis
    window.__TAURI_INTERNALS__ = {}
  })

  it('migra as anotações antigas do IndexedDB uma única vez e apaga a cópia local', async () => {
    await kvSet('ann:d1', [legacy('a', 'd1'), { id: 'ruim', page: 1, color: 'roxo', text: 'x' }])
    const first = await api.getAnnotations('d1')
    expect(first.map((a) => a.id)).toEqual(['a']) // a inválida fica de fora
    expect(await kvGet('ann:d1')).toBeUndefined()
    backend.calls = []
    const second = await api.getAnnotations('d1')
    expect(second).toHaveLength(1)
    expect(backend.calls).toEqual(['list_annotations'])
  })

  it('não sobrescreve o que o backend já tem', async () => {
    backend.annotations.d2 = [legacy('novo', 'd2')]
    await kvSet('ann:d2', [legacy('velho', 'd2')])
    const list = await api.getAnnotations('d2')
    expect(list.map((a) => a.id)).toEqual(['novo'])
    expect(await kvGet('ann:d2')).toBeUndefined()
  })

  it('grava texto e CSV pelos comandos do backend', async () => {
    expect(await api.writeTextFile('/x/a.md', 'oi')).toEqual({ saved: true })
    expect(await api.writeCsv('/x/a.csv', ';')).toEqual({ path: '/x/a.csv', delimiter: ';' })
  })
})

describe('api no navegador (sem backend)', () => {
  it('guarda anotações no IndexedDB', async () => {
    delete window.__TAURI_INTERNALS__
    await api.saveAnnotations('d9', [legacy('z', 'd9')])
    expect(await kvGet('ann:d9')).toHaveLength(1)
    expect(await api.getAnnotations('d9')).toHaveLength(1)
  })
})
