// Extração de páginas a partir de um documento do pdf.js.
// Recebe a biblioteca (`lib`) por parâmetro para rodar tanto no navegador
// (build moderno + worker) quanto em Node (build legacy) nos testes.
import { finalizePages, rawPageFromItems } from './layout'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function abortError() {
  const error = new Error('Operação cancelada.')
  error.name = 'AbortError'
  return error
}

async function pageFigures(lib, page, viewport, extra = []) {
  let ops
  try {
    ops = await page.getOperatorList()
  } catch {
    ops = null
  }
  const OPS = lib.OPS
  const images = new Set([
    OPS.paintImageXObject,
    OPS.paintJpegXObject,
    OPS.paintImageMaskXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageXObjectRepeat,
  ])
  const clips = new Set([OPS.clip, OPS.eoClip])
  const boxes = extra
    .map((box) => {
      const x = Math.max(0, box.x)
      const y = Math.max(0, box.y)
      return {
        x,
        y,
        w: Math.min(viewport.width, box.x + box.w) - x,
        h: Math.min(viewport.height, box.y + box.h) - y,
      }
    })
    .filter((box) => box.w >= 60 && box.h >= 40)
  let ctm = [1, 0, 0, 1, 0, 0]
  let path = null // último retângulo construído, em coordenadas do PDF
  let clip = null // recorte corrente, no espaço da página
  const stack = []

  const quad = (matrix, x0, y0, x1, y1) => {
    const m = lib.Util.transform(viewport.transform, matrix)
    const pts = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]])
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  const intersect = (a, b) => {
    if (!a) return b
    if (!b) return a
    const x = Math.max(a.x, b.x)
    const y = Math.max(a.y, b.y)
    const right = Math.min(a.x + a.w, b.x + b.w)
    const bottom = Math.min(a.y + a.h, b.y + b.h)
    return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) }
  }

  for (let i = 0; ops && i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i]
    if (fn === OPS.save) {
      stack.push({ ctm: ctm.slice(), clip })
    } else if (fn === OPS.restore) {
      const prev = stack.pop()
      if (prev) {
        ctm = prev.ctm
        clip = prev.clip
      }
    } else if (fn === OPS.transform) {
      ctm = lib.Util.transform(ctm, args.slice(0, 6))
    } else if (fn === OPS.constructPath) {
      const box = args && args[2]
      path =
        box && Object.keys(box).length
          ? quad(ctm, box[0], box[1], box[2], box[3])
          : null
    } else if (clips.has(fn)) {
      if (path) clip = intersect(clip, path)
    } else if (images.has(fn)) {
      // A matriz da imagem mapeia o quadrado unitário; o recorte corrente é que
      // diz o tamanho real (banners, por exemplo, usam uma imagem esticada).
      const box = intersect(quad(ctm, 0, 0, 1, 1), clip)
      if (box.w >= 60 && box.h >= 60) boxes.push(box)
    }
  }

  // Junta pedaços próximos (figuras compostas por várias imagens).
  const merged = []
  for (const box of boxes.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = merged[merged.length - 1]
    const near =
      last &&
      box.x < last.x + last.w + 16 &&
      box.x + box.w > last.x - 16 &&
      box.y < last.y + last.h + 16 &&
      box.y + box.h > last.y - 16
    if (near) {
      const right = Math.max(last.x + last.w, box.x + box.w)
      const bottom = Math.max(last.y + last.h, box.y + box.h)
      last.x = Math.min(last.x, box.x)
      last.y = Math.min(last.y, box.y)
      last.w = right - last.x
      last.h = bottom - last.y
    } else {
      merged.push({ ...box })
    }
  }

  const pageArea = viewport.width * viewport.height
  const chosen = merged
    .filter((box) => {
      // faixas de largura total no topo/rodapé são cabeçalho, não figura
      const banner = box.w > viewport.width * 0.8 && box.h < viewport.height * 0.16
      if (banner) return false
      if (box.w < 80 || box.h < 80) return false
      return box.w * box.h >= pageArea * 0.012
    })
    .slice(0, 4)

  const scale = 2
  const cleanViewport = page.getViewport({ scale })
  const figures = []
  for (let index = 0; index < chosen.length; index += 1) {
    const box = chosen[index]
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(box.w * scale))
    canvas.height = Math.max(1, Math.round(box.h * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    try {
      await page.render({
        canvasContext: ctx,
        viewport: cleanViewport,
        transform: [1, 0, 0, 1, -box.x * scale, -box.y * scale],
      }).promise
      figures.push({
        index,
        data: canvas.toDataURL('image/png'),
        w: Math.round(box.w),
        h: Math.round(box.h),
      })
    } catch {
      /* figura que não renderiza é ignorada */
    } finally {
      // WebKit segura a memória do canvas até ele ser zerado.
      canvas.width = 0
      canvas.height = 0
    }
  }
  return figures
}



/**
 * Extrai as páginas do PDF.
 *
 * - `onProgress(n, total)` a cada página.
 * - `onFigure(pageN, figure)` (opcional) recebe cada recorte assim que sai; se
 *   devolver um caminho, o base64 é descartado na hora. Sem isso, um PDF de
 *   200 páginas com figuras mantém centenas de MB de PNG em memória até o fim.
 * - `signal` (AbortSignal) cancela entre páginas.
 * - `figures: false` pula os recortes (Node, ou quando não há DOM).
 */
export async function extractPagesWith(lib, pdf, options = {}) {
  const { onProgress, onFigure, signal } = options
  const wantFigures = options.figures !== false && typeof document !== 'undefined'
  const raw = []
  let lastYield = Date.now()
  for (let n = 1; n <= pdf.numPages; n += 1) {
    if (signal?.aborted) throw abortError()
    const page = await pdf.getPage(n)
    try {
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const found = rawPageFromItems(n, content.items, viewport, lib.Util.transform)
      let figures = []
      if (wantFigures) {
        figures = await pageFigures(lib, page, viewport, found.figureBoxes)
        if (onFigure) {
          for (const figure of figures) {
            const path = await onFigure(n, figure)
            if (path) {
              figure.path = path
              delete figure.data
            }
          }
        }
      }
      delete found.figureBoxes
      raw.push({ ...found, figures })
    } finally {
      page.cleanup?.()
    }
    onProgress?.(n, pdf.numPages)
    // Devolve o controle à interface a cada ~40 ms, para a barra de progresso
    // e o botão de cancelar continuarem respondendo em PDFs grandes.
    if (Date.now() - lastYield > 40) {
      await tick()
      lastYield = Date.now()
    }
  }
  if (signal?.aborted) throw abortError()
  return finalizePages(raw)
}
