import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export { convertFileSrc, listen }

export const api = {
  importDoc: (path) => invoke('import_doc', { path }),
  listDocs: () => invoke('list_docs'),
  getDoc: (docId) => invoke('get_doc', { docId }),
  resolveEvidence: (docId, page, quote) => invoke('resolve_evidence', { docId, page, quote }),
  getEvidence: (id) => invoke('get_evidence', { id }),
  deleteDoc: (docId) => invoke('delete_doc', { docId }),
  savePages: (docId, pages) => invoke('save_pages', { docId, pages }),
  saveFigure: (docId, page, index, data) =>
    invoke('save_figure', { docId, page, index, data }),

  getSettings: () => invoke('get_settings'),
  saveSettings: (settings) => invoke('save_settings', settings),

  getColumns: () => invoke('get_columns'),
  saveColumns: (columns) => invoke('save_columns', { columns }),
  getCells: (docId) => invoke('get_cells', { docId: docId || null }),
  updateCell: (docId, columnId, value) => invoke('update_cell', { docId, columnId, value }),
  extract: (docId, columnIds) => invoke('extract', { docId, columnIds: columnIds || null }),
  writeCsv: (path) => invoke('write_csv', { path }),

  chat: ({ requestId, docIds, history, selection }) =>
    invoke('chat', {
      req: { request_id: requestId, doc_ids: docIds, history, selection: selection || null },
    }),
  cancelChat: (requestId) => invoke('cancel_chat', { requestId }),
}
