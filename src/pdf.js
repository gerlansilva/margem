// Ponte entre o app e o pdf.js: carrega a biblioteca sob demanda (chunk
// separado), cuida de cache, senha e erros legíveis.
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { extractPagesWith } from './pdf/extract'

export { normalize, matchingBlocks } from './pdf/layout'

let libPromise = null
/** Carrega o pdf.js na primeira vez que alguém precisa dele. */
export function getPdfLib() {
  if (!libPromise) {
    libPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = workerSrc
      return lib
    })
  }
  return libPromise
}

/** Pasta dos cmaps/fontes/wasm copiados pelo vite.config.js (precisa terminar em "/"). */
function assetBase() {
  return new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href
}

/** O App registra aqui como pedir senha ao usuário: (url, wrong) => Promise<string|null>. */
export const pdfHooks = { askPassword: null }

const MAX_OPEN = 3
const open = new Map() // url -> Promise<PDFDocumentProxy>, em ordem de uso
const passwords = new Map() // url -> senha, só nesta sessão

export function friendlyPdfError(error) {
  const name = error?.name || ''
  const msg = String(error?.message || error || '')
  if (name === 'AbortError') return 'Operação cancelada.'
  if (name === 'PasswordException') {
    return error.code === 2 ? 'Senha incorreta.' : 'PDF protegido por senha.'
  }
  if (name === 'InvalidPDFException' || /invalid pdf|Invalid PDF structure/i.test(msg))
    return 'O arquivo não é um PDF válido ou está corrompido.'
  if (name === 'MissingPDFException') return 'O arquivo PDF não foi encontrado.'
  if (/failed to fetch|NetworkError|Load failed/i.test(msg))
    return 'Não foi possível ler o arquivo do disco.'
  return msg || 'Erro desconhecido.'
}

async function openPdf(url) {
  const lib = await getPdfLib()
  let res
  try {
    res = await fetch(url)
  } catch (error) {
    throw new Error(friendlyPdfError(error))
  }
  if (!res.ok) throw new Error('Não foi possível abrir o PDF.')
  const data = await res.arrayBuffer()
  const task = lib.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: `${assetBase()}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase()}standard_fonts/`,
    wasmUrl: `${assetBase()}wasm/`,
  })
  let giveUp = null
  const gaveUp = new Promise((_, reject) => {
    giveUp = reject
  })
  gaveUp.catch(() => {}) // só vale se alguém a aguardar (Promise.race abaixo)
  task.onPassword = async (update, reason) => {
    const wrong = reason === lib.PasswordResponses.INCORRECT_PASSWORD
    const saved = !wrong && passwords.get(url)
    const password = saved || (await pdfHooks.askPassword?.(url, wrong))
    if (password == null || password === '') {
      // Sem senha: derruba a tarefa com um erro que a interface entende.
      const error = new Error('PDF protegido por senha.')
      error.name = 'PasswordException'
      error.code = 1
      // Não lança aqui: uma exceção dentro do callback vira "unhandledrejection".
      giveUp(error)
      task.destroy().catch(() => {})
      return
    }
    passwords.set(url, password)
    update(password)
  }
  try {
    return await Promise.race([task.promise, gaveUp])
  } catch (error) {
    if (error?.name === 'PasswordException') passwords.delete(url)
    throw error
  }
}

export function loadPdf(url) {
  const hit = open.get(url)
  if (hit) {
    open.delete(url)
    open.set(url, hit) // mais recente
    return hit
  }
  const promise = openPdf(url)
  open.set(url, promise)
  promise.catch(() => {
    if (open.get(url) === promise) open.delete(url)
  })
  // Evita acumular documentos (cada um guarda o arquivo inteiro na memória).
  while (open.size > MAX_OPEN) {
    const [oldUrl, oldPromise] = open.entries().next().value
    open.delete(oldUrl)
    oldPromise.then((doc) => doc.destroy()).catch(() => {})
  }
  return promise
}

export function forgetPdf(url) {
  const promise = open.get(url)
  open.delete(url)
  passwords.delete(url)
  promise?.then((doc) => doc.destroy()).catch(() => {})
}

/**
 * Extrai as páginas. `options` pode ser uma função (progresso) ou
 * `{ onProgress, onFigure, signal }`; ver extractPagesWith.
 */
export async function extractPages(pdf, options = {}) {
  const lib = await getPdfLib()
  const opts = typeof options === 'function' ? { onProgress: options } : options
  return extractPagesWith(lib, pdf, opts)
}

/** Texto selecionável total: 0 indica PDF escaneado (só imagem). */
export function textLength(pages) {
  return pages.reduce((sum, page) => sum + page.lines.reduce((s, line) => s + line.text.length, 0), 0)
}
