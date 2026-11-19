import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { normalizeAnnotations } from './lib/annotations'
import { kvDelete, kvGet, kvSet } from './store'

export { convertFileSrc, listen }

/** Texto legível de qualquer erro (o backend devolve string; o resto, Error). */
export function errorText(error) {
  if (!error) return 'erro desconhecido'
  if (typeof error === 'string') return error
  return error.message || String(error)
}

/** Dentro do Tauri (ou do mock, que instala o mesmo objeto) os comandos existem. */
export function inTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

/**
 * Anotações guardadas pelas versões 0.1 no IndexedDB passam para o backend uma
 * única vez: grava, confere e só então apaga a cópia local.
 */
const migrating = new Map()
function migrateLegacyAnnotations(docId) {
  if (!migrating.has(docId)) {
    const job = migrateNow(docId).finally(() => migrating.delete(docId))
    migrating.set(docId, job)
  }
  return migrating.get(docId)
}

async function migrateNow(docId) {
  const legacy = normalizeAnnotations(await kvGet(`ann:${docId}`)).map((a) => ({ ...a, docId }))
  if (!legacy.length) {
    await kvDelete(`ann:${docId}`)
    return
  }
  const current = await invoke('list_annotations', { docId })
  if (!current.length) {
    await invoke('save_annotations', { docId, annotations: legacy })
    const check = await invoke('list_annotations', { docId })
    if (check.length < legacy.length) return // não apaga a cópia local se algo não gravou
  }
  await kvDelete(`ann:${docId}`)
}

export const api = {
  importDoc: (path) => invoke('import_doc', { path }),
  listDocs: () => invoke('list_docs'),
  getDoc: (docId) => invoke('get_doc', { docId }),
  resolveEvidence: (docId, page, quote) => invoke('resolve_evidence', { docId, page, quote }),
  getEvidence: (id) => invoke('get_evidence', { id }),
  /** Troca o título exibido; para restaurar, envie `original_title`. Devolve o Doc atualizado. */
  renameDoc: (docId, title) => invoke('rename_doc', { docId, title }),
  deleteDoc: async (docId) => {
    await invoke('delete_doc', { docId })
    // O backend não conhece o que é só do frontend: limpa junto.
    await Promise.all([kvDelete(`ann:${docId}`), kvDelete(`chat:${docId}`)])
  },
  savePages: (docId, pages) => invoke('save_pages', { docId, pages }),
  saveFigure: (docId, page, index, data) => invoke('save_figure', { docId, page, index, data }),

  getSettings: () => invoke('get_settings'),
  saveSettings: (settings) => invoke('save_settings', settings),

  getColumns: () => invoke('get_columns'),
  saveColumns: (columns) => invoke('save_columns', { columns }),
  getCells: (docId) => invoke('get_cells', { docId: docId || null }),
  updateCell: (docId, columnId, value) => invoke('update_cell', { docId, columnId, value }),
  /** `requestId` (um por documento) permite `cancelChat(requestId)` e liga os eventos `ai` ao documento. */
  extract: (docId, columnIds, requestId) =>
    invoke('extract', { docId, columnIds: columnIds || null, requestId: requestId || null }),
  /** delimiter: ',' (padrão) ou ';' (Excel em pt-BR). O arquivo leva BOM UTF-8. */
  writeCsv: (path, delimiter = ',') => invoke('write_csv', { path, delimiter }),

  chat: ({ requestId, docIds, history, selection }) =>
    invoke('chat', {
      req: { request_id: requestId, doc_ids: docIds, history, selection: selection || null },
    }),
  cancelChat: (requestId) => invoke('cancel_chat', { requestId }),

  clearApiKey: () => invoke('clear_api_key'),

  // ------------------------------------------------------------------ busca
  /** { mode: 'lexical'|'hybrid', hits: [{ doc_id, doc_title, page, score, snippet, ranges, quote }] } */
  searchLibrary: (query, docIds, limit = 30) =>
    invoke('search_library', { query, docIds: docIds?.length ? docIds : null, limit }),
  /** { docs_total, docs_indexed, chunks, embeddings, model, busy } */
  indexStatus: () => invoke('index_status'),
  reindex: (docId) => invoke('reindex', { docId: docId || null }),

  // --------------------------------------------------------------- OpenAlex
  /** { source: 'link'|'doi'|'title'|'manual', work, candidates } */
  openalexLookup: (docId, query) => invoke('openalex_lookup', { docId, query: query || null }),
  /** `workId` null desvincula. */
  openalexLink: (docId, workId) => invoke('openalex_link', { docId, workId: workId || null }),
  /** kind: 'related' | 'references' | 'cited_by'. -> { works, total, page } */
  openalexRelated: (workId, kind, page = 1) => invoke('openalex_related', { workId, kind, page }),
  /** Baixa um PDF aberto; devolve { path, name } para o fluxo normal de importação. */
  downloadPdf: (url) => invoke('download_pdf', { url }),

  // -------------------------------------------------------------- anotações
  // No Tauri ficam no SQLite do backend; no navegador (sem backend), no IndexedDB.

  getAnnotations: async (docId) => {
    if (!inTauri()) return (await kvGet(`ann:${docId}`)) || []
    try {
      await migrateLegacyAnnotations(docId)
    } catch (error) {
      console.warn('migração das anotações antigas falhou', error)
    }
    return (await invoke('list_annotations', { docId })) || []
  },
  /** Substitui a lista inteira de anotações do documento. */
  saveAnnotations: async (docId, annotations) => {
    if (!inTauri()) return kvSet(`ann:${docId}`, annotations)
    return invoke('save_annotations', { docId, annotations })
  },
  /** Migra as anotações antigas de vários documentos (ao abrir o app). */
  migrateAnnotations: async (docIds) => {
    if (!inTauri()) return
    for (const docId of docIds) {
      try {
        await migrateLegacyAnnotations(docId)
      } catch (error) {
        console.warn('migração das anotações antigas falhou', docId, error)
      }
    }
  },

  /** Conversa por escopo (ids dos documentos juntos): só local. */
  getChat: async (scopeKey) => (await kvGet(`chat:${scopeKey}`)) || [],
  saveChat: (scopeKey, messages) => kvSet(`chat:${scopeKey}`, messages),
  clearChat: (scopeKey) => kvDelete(`chat:${scopeKey}`),

  /**
   * Grava UTF-8 em `path` (vindo do diálogo "salvar"; só .md/.txt/.csv). Sem
   * backend (navegador), baixa pelo navegador.
   * Devolve { saved: true } ou { saved: false, downloaded: true }.
   */
  writeTextFile: async (path, contents, { mime = 'text/plain' } = {}) => {
    if (inTauri()) {
      await invoke('write_text_file', { path, contents })
      return { saved: true }
    }
    downloadText(String(path).split(/[\\/]/).pop() || 'margem.txt', contents, mime)
    return { saved: false, downloaded: true }
  },
}

/** Baixa um texto como arquivo (reserva quando o backend não grava arquivos). */
export function downloadText(name, contents, mime = 'text/plain') {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
