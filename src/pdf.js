import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

const openDocs = new Map()

export async function loadPdf(url) {
  if (openDocs.has(url)) return openDocs.get(url)
  const res = await fetch(url)
  if (!res.ok) throw new Error('Não foi possível abrir o PDF.')
  const data = await res.arrayBuffer()
  const doc = await pdfjsLib.getDocument({ data }).promise
  openDocs.set(url, doc)
  return doc
}

export function forgetPdf(url) {
  openDocs.delete(url)
}

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function joinItems(items) {
  let text = ''
  for (const item of items) {
    const value = item.str
    if (!text) {
      text = value
      continue
    }
    const needSpace =
      !/\s$/.test(text) &&
      !/^\s/.test(value) &&
      !/^[,.;:!?%)\]}]/.test(value) &&
      !/[(\[{]$/.test(text)
    text += (needSpace ? ' ' : '') + value
  }
  return text.replace(/\s+/g, ' ').trim()
}

function joinLine(a, b) {
  if (/-$/.test(a) && /^[a-zà-ÿ]/.test(b)) return a.slice(0, -1) + b
  return `${a} ${b}`.replace(/\s+/g, ' ')
}

/** Separa uma página em duas colunas quando existe uma calha vertical clara. */
// Cabeçalho de periódico: ISSN, DOI, "Revista X, v. 3, n. 4", "v. 36, n. 2,
// p. 203-217, 2016".
const MASTHEAD =
  /\b(e-?issn|issn|doi)\b|^(revista|cadernos|boletim|periódico|vidya)\b|\b(v\.|vol\.)\s*\d+\s*,?\s*n\.\s*\d+\b.*\b(19|20)\d{2}\b/i
// Começo de nota de rodapé: "1 Recebido em:", "Recebido em", "Aprovado em".
const FOOTNOTE_HEAD =
  /^(\d{1,2}|[¹²³⁴⁵⁶⁷⁸⁹⁰*∗†‡])\s*[.)]?\s*(recebido|aprovado|aceito|submetido|revisado)\b|^(recebido|aprovado|aceito|submetido)\s+em\b|^[*∗†‡]\s*\S/i
// Nota numerada em corpo menor que o texto: "2 Em Santos (2015), foram...".
const FOOTNOTE_MARK = /^(\d{1,2}|[*∗†‡])\s+\S/

/**
 * Remove o aparato da página: o cabeçalho de periódico no alto e, na metade de
 * baixo, a nota de rodapé (bios, "Recebido em", financiamento). Sem isso, a
 * biografia dos autores entra no texto que a IA lê como se fosse conteúdo.
 */
function stripApparatus(lines, height, bodySize = 0) {
  const kept = lines.filter(
    (line) =>
      !(line.y < height * 0.1 && (MASTHEAD.test(line.text.trim()) || /^\s*\d{1,3}\s*$/.test(line.text))),
  )
  const small = (line) => bodySize > 0 && line.size <= bodySize * 0.8
  const isNoteStart = (line, i) => {
    const text = line.text.trim()
    if (FOOTNOTE_HEAD.test(text)) return true
    // Nota numerada: corpo menor que o texto e linha seguinte também pequena
    // (ou fim da página). Um parágrafo normal nunca cai nisso.
    if (!small(line) || !FOOTNOTE_MARK.test(text)) return false
    return i + 1 >= kept.length || small(kept[i + 1])
  }
  const cut = kept.find(
    (line, i) => line.y > height * 0.5 && isNoteStart(line, i),
  )
  if (!cut) return kept

  // Os números de chamada ("... extensionista 1", "Miranda 2") apontam para as
  // notas que acabaram de sair. Só saem os que têm nota correspondente.
  const markers = new Set()
  for (const line of kept) {
    if (line.y < cut.y) continue
    const match = line.text.trim().match(/^(\d{1,2})\s+\S/)
    if (match) markers.add(match[1])
  }
  // O chamador pode estar no meio do parágrafo ("... brasileiras 1. O
  // critério..."), então casa o número solto antes de ponto final, e só quando
  // existe nota com aquele número na página.
  const call = /(\S)\s(\d{1,2})(?=\.\s|\.$|\s*$)/
  return kept
    .filter((line) => line.y < cut.y)
    .map((line) => {
      if (!markers.size) return line
      const match = line.text.match(call)
      if (!match || !markers.has(match[2])) return line
      return { ...line, text: line.text.replace(call, '$1') }
    })
}

/**
 * Ordem de leitura em linhas. Página de coluna única volta inteira, na ordem
 * vertical. Página de duas colunas volta fatiada por faixas: o que atravessa a
 * página (título, figura de largura total) fecha a faixa, e dentro da faixa a
 * coluna esquerda vem antes da direita. Sem isso, uma frase que muda de coluna
 * é montada com pedaços de linhas diferentes.
 */
function splitColumns(items, pageWidth) {
  const lines = linesFromItems(items)
  if (lines.length < 20) return [lines]
  const mid = pageWidth / 2
  const gap = pageWidth * 0.035
  const segments = segmentsFromItems(items, 24)
  const spans = (segment) => segment.x < mid - gap && segment.x + segment.w > mid + gap
  const crossing = segments.filter(spans)
  // Coluna única: quase toda linha atravessa o meio da página.
  if (crossing.length > segments.length * 0.15) return [lines]
  const left = segments.filter((s) => !spans(s) && s.x + s.w / 2 < mid)
  const right = segments.filter((s) => !spans(s) && s.x + s.w / 2 >= mid)
  if (left.length < 8 || right.length < 8) return [lines]

  const groups = []
  let band = []
  const flush = () => {
    if (!band.length) return
    const l = band.filter((s) => s.x + s.w / 2 < mid)
    const r = band.filter((s) => s.x + s.w / 2 >= mid)
    if (l.length) groups.push(l)
    if (r.length) groups.push(r)
    band = []
  }
  for (const segment of segments) {
    if (spans(segment)) {
      flush()
      groups.push([segment])
    } else {
      band.push(segment)
    }
  }
  flush()
  return groups
}

function linesFromItems(items, maxGap = Infinity) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines = []
  for (const item of sorted) {
    // A linha certa não é necessariamente a última: em duas colunas os itens
    // chegam alternando esquerda/direita, com a mesma altura e vãos diferentes.
    let target = null
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i--) {
      const candidate = lines[i]
      if (Math.abs(item.y - candidate.y) > Math.max(3, candidate.h * 0.55)) continue
      const gap = Math.max(
        item.x - (candidate.x + candidate.w),
        candidate.x - (item.x + item.w),
      )
      if (gap <= maxGap) {
        target = candidate
        break
      }
    }
    if (target) {
      target.items.push(item)
      target.x = Math.min(target.x, item.x)
      target.y = Math.min(target.y, item.y)
      target.w = Math.max(target.w, item.x + item.w - target.x)
      target.h = Math.max(target.h, item.h)
    } else {
      lines.push({ items: [item], x: item.x, y: item.y, w: item.w, h: item.h, size: item.size })
    }
  }
  return lines
    .map((line) => {
      line.items.sort((a, b) => a.x - b.x)
      return {
        items: line.items,
        text: joinItems(line.items),
        x: line.x,
        y: line.y,
        w: line.w,
        h: line.h,
        size: median(line.items.map((i) => i.size)) || line.h,
      }
    })
    .filter((line) => line.text)
}

/** Corta a linha quando há um vão largo: são duas colunas ou células vizinhas. */
function segmentsFromItems(items, maxGap = 24) {
  return linesFromItems(items, maxGap)
}

/** Separa as células de uma linha pelos vãos horizontais entre itens de texto. */
function cellsFromLine(line) {
  const size = line.size || 11
  const gapMin = Math.max(9, size * 1.1)
  const cells = []
  let current = null
  for (const item of line.items) {
    if (!current) {
      current = { x: item.x, y: item.y, w: item.w, h: item.h, items: [item], text: item.str }
      continue
    }
    const gap = item.x - (current.x + current.w)
    if (gap > gapMin) {
      current.text = joinItems(current.items)
      cells.push(current)
      current = { x: item.x, y: item.y, w: item.w, h: item.h, items: [item], text: item.str }
    } else {
      current.items.push(item)
      current.w = item.x + item.w - current.x
      current.h = Math.max(current.h, item.h)
    }
  }
  if (current) {
    current.text = joinItems(current.items)
    cells.push(current)
  }
  return cells.filter((cell) => cell.text)
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

/**
 * Tira das linhas as regiões que parecem tabela (linhas com 2+ células) e devolve
 * o Markdown da tabela e o texto corrido dela, para conferência de citações.
 */
function tableMarkdown(rows) {
  const cells = rows.map((row) => row.cells)
  const columns = Math.max(...cells.map((row) => row.length))
  const pad = (row) => row.concat(Array(columns - row.length).fill(' '))
  return [
    `| ${pad(cells[0]).join(' | ')} |`,
    `| ${Array(columns).fill('---').join(' | ')} |`,
    ...cells.slice(1).map((row) => `| ${pad(row).join(' | ')} |`),
  ].join('\n')
}

function extractTables(lines) {
  const plain = []
  const tables = []
  let run = []
  const flush = () => {
    if (run.length >= 2 && Math.max(...run.map((row) => row.cells.length)) >= 2) {
      const rows = run.map((row) => ({
        y: row.y,
        h: row.h,
        cells: row.cells.map((cell) => escapeCell(cell.text)),
      }))
      const text = run.map((row) => row.cells.map((cell) => cell.text).join(' | ')).join('\n')
      const left = Math.min(...run.map((row) => row.x))
      const right = Math.max(...run.map((row) => row.x + row.w))
      tables.push({
        y: Math.min(...run.map((row) => row.y)),
        bottom: Math.max(...run.map((row) => row.y + row.h)),
        x: left,
        w: right - left,
        rows,
        md: tableMarkdown(rows),
        text,
      })
    } else {
      for (const row of run) {
        plain.push({ ...row, text: row.cells.map((cell) => cell.text).join(' — ') })
      }
    }
    run = []
  }
  for (const line of lines) {
    const cells = cellsFromLine(line)
    const candidate = cells.length >= 2 && cells.length <= 12
    if (candidate) {
      run.push({ ...line, cells })
      continue
    }
    // Célula quebrada em várias linhas: cola no fim da coluna mais próxima.
    const last = run[run.length - 1]
    const gap = last ? line.y - (last.y + last.h) : Infinity
    if (run.length >= 2 && cells.length === 1 && gap < last.h * 2.4) {
      const cell = cells[0]
      let target = last.cells[0]
      let best = Infinity
      for (const other of last.cells) {
        const distance = Math.abs(other.x + other.w / 2 - (cell.x + cell.w / 2))
        if (distance < best) {
          best = distance
          target = other
        }
      }
      target.text = `${target.text} ${cell.text}`.trim()
      target.w = Math.max(target.w, cell.x + cell.w - target.x)
      last.text = last.cells.map((c) => c.text).join(' ')
      continue
    }
    flush()
    plain.push(line)
  }
  flush()
  return { plain, tables }
}

/** Cola tabelas que a divisão em colunas partiu ao meio (mesma faixa vertical). */
function mergeTables(tables) {
  const out = []
  for (const table of [...tables].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const host = out.find((t) => {
      const overlap =
        Math.min(t.bottom, table.bottom) - Math.max(t.y, table.y)
      const shorter = Math.min(t.bottom - t.y, table.bottom - table.y)
      return overlap > shorter * 0.5
    })
    if (host) {
      for (const row of table.rows) {
        const match = host.rows.find((other) => Math.abs(other.y - row.y) <= Math.max(4, row.h * 0.6))
        // A metade da direita ocupa as colunas seguintes da mesma linha.
        if (match) match.cells = match.cells.concat(row.cells)
        else host.rows.push({ ...row, cells: [...row.cells] })
      }
      host.rows.sort((a, b) => a.y - b.y)
      host.md = tableMarkdown(host.rows)
      host.text = host.rows.map((row) => row.cells.join(' | ')).join('\n')
      host.x = Math.min(host.x, table.x)
      host.y = Math.min(host.y, table.y)
      host.bottom = Math.max(host.bottom, table.bottom)
    } else {
      out.push({ ...table, rows: table.rows.map((row) => ({ ...row, cells: [...row.cells] })) })
    }
  }
  return out
}

async function pageFigures(page, viewport, extra = []) {
  let ops
  try {
    ops = await page.getOperatorList()
  } catch {
    ops = null
  }
  const OPS = pdfjsLib.OPS
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
    const m = pdfjsLib.Util.transform(viewport.transform, matrix)
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
      ctm = pdfjsLib.Util.transform(ctm, args.slice(0, 6))
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
    }
  }
  return figures
}


function isCapsHeading(text) {
  const clean = text.trim()
  if (clean.length < 3 || clean.length > 70) return false
  if (/[.;:,]$/.test(clean)) return false
  const letters = clean.replace(/[^A-Za-zÁÀÂÃÉÊÍÓÔÕÚÇáàâãéêíóôõúç]/g, '')
  if (letters.length < 3) return false
  const upper = letters.replace(/[^A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/g, '').length
  return upper / letters.length > 0.8
}

function blocksFromLines(lines, bodySize) {
  const blocks = []
  let current = null
  // Centro de referência da coluna: linha centrada que muda de x (título de
  // duas linhas) continua sendo o mesmo parágrafo. Só o que foge do centro
  // (autor, epígrafe) é que quebra.
  // O centro de referência vem das linhas de corpo: em página 1, autor e
  // filiação deslocam a mediana de todas as linhas.
  const bodyCenters = lines
    .filter((line) => Math.abs(line.size - bodySize) <= 0.5)
    .map((line) => line.x + line.w / 2)
    .sort((a, b) => a - b)
  const allCenters = lines.map((line) => line.x + line.w / 2).sort((a, b) => a - b)
  const centers = bodyCenters.length ? bodyCenters : allCenters
  const refCenter = centers.length ? centers[Math.floor(centers.length / 2)] : 0
  for (const line of lines) {
    if (!line.text) continue
    const gap = current ? line.y - (current.y + current.h) : 0
    const jump = current && bodySize > 0 && Math.abs(line.size - current.size) / current.size > 0.22
    const caps = isCapsHeading(line.text)
    const named = isSectionName(line.text)
    const heading =
      caps || named || (bodySize > 0 && line.size >= bodySize * 1.25 && line.text.length < 140)
    // Linha que começa muito à direita (autor, epígrafe) não é continuação do
    // parágrafo anterior, mesmo com o espaçamento certo.
    const centered = Math.abs(line.x + line.w / 2 - refCenter) < bodySize * 4
    const shifted =
      !centered && current && Math.abs(line.x - current.x) > bodySize * 3
    // Título de duas linhas: a segunda linha pode vir um pouco menor, mas
    // ainda é título se está centrada e acima do corpo do texto.
    const continuesHeading =
      current?.heading &&
      centered &&
      line.size >= bodySize * 1.05 &&
      Math.abs(line.size - current.size) <= current.size * 0.35
    const newBlock =
      !current ||
      gap > Math.max(7, current.h * 0.8) ||
      (jump && !continuesHeading) ||
      (heading && !continuesHeading) ||
      (current.heading && !continuesHeading) ||
      shifted
    if (newBlock) {
      current = {
        text: line.text,
        x: line.x,
        y: line.y,
        w: line.w,
        h: line.h,
        size: line.size,
        heading,
      }
      blocks.push(current)
    } else {
      const right = Math.max(current.x + current.w, line.x + line.w)
      const bottom = Math.max(current.y + current.h, line.y + line.h)
      current.x = Math.min(current.x, line.x)
      current.y = Math.min(current.y, line.y)
      current.w = right - current.x
      current.h = bottom - current.y
      current.text = joinLine(current.text, line.text)
    }
  }
  return blocks
}

const SECTION_NAMES = new Set([
  'abstract',
  'introduction',
  'related work',
  'background',
  'literature review',
  'theoretical framework',
  'method',
  'methods',
  'methodology',
  'materials and methods',
  'approach',
  'experiments',
  'experimental setup',
  'results',
  'discussion',
  'conclusions',
  'conclusion',
  'limitations',
  'references',
  'bibliography',
  'acknowledgments',
  'acknowledgements',
  'appendix',
  'data analysis',
  // português
  'resumo',
  'abstract',
  'palavras-chave',
  'introdução',
  'introducao',
  'referencial teórico',
  'referencial teorico',
  'fundamentação teórica',
  'fundamentacao teorica',
  'metodologia',
  'materiais e métodos',
  'materiais e metodos',
  'procedimentos metodológicos',
  'resultados',
  'resultados e discussão',
  'resultados e discussao',
  'discussão',
  'discussao',
  'considerações finais',
  'consideracoes finais',
  'conclusões',
  'conclusoes',
  'conclusão',
  'conclusao',
  'referências',
  'referencias',
  'referências bibliográficas',
  'referencias bibliograficas',
  'bibliografia',
  'agradecimentos',
  'apêndice',
  'apendice',
  'anexo',
])

const BOILERPLATE =
  /provided proper attribution|arxiv:\d{4}\.|permission to reproduce the tables|all rights reserved/i

function isSectionName(text) {
  const clean = text
    .replace(/^\d+(\.\d+)*[.)]?\s*/, '')
    .replace(/[.:]$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return SECTION_NAMES.has(clean)
}

const REFERENCE_HEADING = /^(refer[êe]ncias?|bibliografia|references|bibliography)\b/i

/**
 * Uma lista ABNT vira um parágrafo único na extração. Aqui cada entrada começa
 * de novo no sobrenome em caixa alta (AGUDO, Marcela…) ou em nome institucional.
 */
function splitReferences(text) {
  if (/\[\d{1,3}\]/.test(text)) {
    return text
      .split(/(?=\[\d{1,3}\]\s)/)
      .map((part) => part.trim())
      .filter(Boolean)
  }
  const institutos =
    /^(BRASIL|INSTITUTO|UNIVERSIDADE|MINIST[ÉE]RIO|ORGANIZA[ÇC][ÃA]O|FUNDA[ÇC][ÃA]O|SECRETARIA|CONSELHO|ASSOCIA[ÇC][ÃA]O|COMISS[ÃA]O)\b/
  const chunks = []
  let current = ''
  const words = text.split(/\s+/)
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]
    const next = (words[i + 1] || '').replace(/^[",;]+/, '')
    const bare = word.replace(/[,;.:]+$/, '')
    const capsName =
      bare.length >= 3 && /^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][A-ZÁÀÂÃÉÊÍÓÔÕÚÇ'’\-]+$/.test(bare)
    const before = current.trim()
    const startsEntry =
      before.length > 40 &&
      /\.$/.test(before) &&
      capsName &&
      (/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(next) || /[,.]$/.test(word) || institutos.test(bare))
    if (startsEntry) {
      chunks.push(before)
      current = ''
    }
    current += `${current ? ' ' : ''}${word}`
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

/** Bloco que parece lista de referências: entradas numeradas ou várias ABNT. */
function isReferenceBlock(text) {
  const clean = text.trim()
  if (/\[1\]\s/.test(clean) && (clean.match(/\[\d{1,3}\]\s/g) || []).length >= 2) return true
  if (!/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(clean)) return false
  return splitReferences(clean).length >= 2 && /\b(19|20)\d{2}\b/.test(clean)
}

function markdownFromBlocks(blocks, firstPage, tables = []) {
  const weighted = blocks.flatMap((b) => (b.text.length > 20 ? [b.size] : []))
  const body = median(weighted) || median(blocks.map((b) => b.size)) || 11
  const title = firstPage
    ? blocks
        .filter(
          (b) =>
            b.text.length <= 110 &&
            !/arxiv|copyright|permission|license|preprint|proceedings/i.test(b.text),
        )
        .sort((a, b) => b.size - a.size)[0]
    : null
  const hasTitle = title && title.size >= body * 1.15
  const refHeading = blocks.find(
    (b) => REFERENCE_HEADING.test(b.text.trim()) && b.text.trim().length < 60,
  )
  // Em página de duas colunas, referências e título saem intercalados pelo y.
  // Aqui o título vai para o fim e as entradas ficam sob ele, em ordem de página.
  const refBlocks = []
  const rest = []
  for (const block of blocks) {
    if (block === refHeading) continue
    const raw = block.text.length
    const cut = refHeading && isReferenceBlock(block.text) ? block.text.search(/\[1\]\s/) : -1
    if (cut > 0) {
      // O parágrafo anterior absorveu o começo da lista: corta no [1].
      const head = block.text.slice(0, cut).trim()
      rest.push({ ...block, text: head })
      refBlocks.push({
        ...block,
        text: block.text.slice(cut).trim(),
        y: block.y + (block.h * cut) / Math.max(1, raw),
      })
      continue
    }
    if (cut === 0) refBlocks.push(block)
    else if (refHeading && cut < 0 && isReferenceBlock(block.text)) refBlocks.push(block)
    else rest.push(block)
  }
  const items = [
    ...rest.map((block) => ({ y: block.y, g: block.g || 0, block })),
    ...tables.map((table) => ({ y: table.y, g: table.g || 0, table })),
  ].sort((a, b) => a.g - b.g || a.y - b.y)

  let md = ''
  for (const item of items) {
    if (item.table) {
      md += `${item.table.md}\n\n`
      continue
    }
    const block = item.block
    const text = block.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (BOILERPLATE.test(text) && text.length < 500) continue
    if (hasTitle && block === title) {
      md += `# ${text}\n\n`
      continue
    }
    if (isSectionName(text)) {
      md += `## ${text}\n\n`
      continue
    }
    if (block.heading || (block.size >= body * 1.28 && text.length < 120)) {
      md += `## ${text}\n\n`
      continue
    }
    if (block.size >= body * 1.12 && text.length < 200) {
      md += `### ${text}\n\n`
      continue
    }
    // Página seguinte da lista sai sem o título "REFERÊNCIAS": reconhece pela forma.
    if (isReferenceBlock(text)) {
      md += `${splitReferences(text).join('\n\n')}\n\n`
      continue
    }
    if (/^[•·‣∙▪]\s+/.test(text)) {
      const items = text.split(/\s*[•·‣∙▪]\s+/).filter(Boolean)
      md += items.map((item) => `- ${item}`).join('\n') + '\n\n'
      continue
    }
    if (/^\d+[.)]\s+/.test(text) && text.length < 300) {
      md += `- ${text.replace(/^\d+[.)]\s+/, '')}\n\n`
      continue
    }
    md += `${text}\n\n`
  }
  if (refHeading) {
    md += `## ${refHeading.text.replace(/\s+/g, ' ').trim()}\n\n`
    for (const block of refBlocks.sort((a, b) => a.y - b.y)) {
      const text = block.text.replace(/\s+/g, ' ').trim()
      md += `${splitReferences(text).join('\n\n')}\n\n`
    }
  }
  return md.trim()
}

export async function extractPages(pdf, onProgress) {
  const pages = []
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items = []
    const rotated = []
    for (const item of content.items) {
      if (!item.str || !item.str.trim() || !item.transform) continue
      const [a, b, c, d] = item.transform
      if (Math.abs(b) > 0.15 || Math.abs(c) > 0.15) {
        // Texto em pé (tabela girada, rótulo de eixo): não dá para reler como
        // linha, então vira recorte para o modelo enxergar.
        const h = Math.abs(item.height || Math.hypot(c, d) || 10)
        const w = Math.max(Math.abs(item.width || 0), h * Math.min(item.str.trim().length, 60) * 0.4)
        const corners = [
          [0, 0],
          [w, 0],
          [0, h],
          [w, h],
        ].map(([u, v]) =>
          pdfjsLib.Util.transform(
            viewport.transform,
            pdfjsLib.Util.transform(item.transform, [1, 0, 0, 1, u, v]),
          ),
        )
        const xs = corners.map((m) => m[4])
        const ys = corners.map((m) => m[5])
        rotated.push({
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
        })
        continue
      }
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
      const h = Math.abs((item.height || Math.hypot(c, d) || 10) * viewport.scale) || 10
      const w = Math.abs((item.width || 0) * viewport.scale)
      // Número solto no pé da página é folio, não conteúdo.
      if (/^\d{1,3}$/.test(item.str.trim()) && tx[5] > viewport.height * 0.9) continue
      items.push({ str: item.str, x: tx[4], y: tx[5] - h, w, h, size: h })
    }

    const body = median(items.map((i) => i.size)) || 11
    const groups = splitColumns(items, viewport.width)
    const parsed = groups.map((group) => extractTables(group))
    // Cabeçalho de periódico e nota de rodapé saem antes de virar parágrafo.
    // O grupo guarda a ordem de leitura; o y só ordena dentro dele.
    const lines = []
    let tables = []
    for (const [gi, found] of parsed.entries()) {
      lines.push(
        ...stripApparatus(found.plain, viewport.height, body).map((line) => ({ ...line, g: gi })),
      )
      tables = tables.concat(found.tables.map((t) => ({ ...t, g: gi })))
    }
    const extraBlocks = []
    tables = mergeTables(tables)
    // Grade de duas colunas com poucas linhas costuma ser texto com um vão
    // grande no meio; nesse caso volta a ser parágrafo.
    const solid = []
    const tableBoxes = []
    for (const table of tables) {
      const columns = Math.max(...table.rows.map((row) => row.cells.length))
      if (columns >= 3 || table.rows.length >= 4) {
        solid.push(table)
      } else {
        // Não virou grade: guarda o recorte para o modelo conseguir ler a tabela.
        tableBoxes.push({
          x: table.x,
          y: table.y,
          w: table.w,
          h: table.bottom - table.y,
        })
        for (const row of table.rows) {
          extraBlocks.push({
            text: row.cells.join(' — '),
            x: table.x,
            y: row.y,
            w: 200,
            h: row.h,
            size: body,
            g: table.g || 0,
          })
        }
      }
    }
    tables = solid

    const figures = await pageFigures(page, viewport, [...rotated, ...tableBoxes])

    // Guarda o material bruto: cabeçalho/rodapé repetido só dá para detectar
    // depois de ver a biblioteca inteira.
    pages.push({ n, lines, extraBlocks, tables, figures, height: viewport.height, body })
    onProgress?.(n, pdf.numPages)
  }

  const strip = (text) => normalize(text).replace(/\d+/g, '').slice(0, 80)
  const inBand = (line, height) => line.y < height * 0.08 || line.y > height * 0.9
  // Conta por linha, não por parágrafo: na primeira página o cabeçalho costuma
  // vir colado no texto da chamada e o parágrafo deixa de casar com os outros.
  const counts = new Map()
  for (const page of pages) {
    for (const line of page.lines) {
      if (!inBand(line, page.height) || line.text.trim().length < 6) continue
      const key = strip(line.text)
      if (key) counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  const limit = Math.max(2, Math.ceil(pages.length * 0.4))
  const repeated = new Set(
    [...counts.entries()].filter(([, count]) => count >= limit).map(([key]) => key),
  )

  return pages.map((page) => {
    const lines = page.lines.filter(
      (line) => !(inBand(line, page.height) && repeated.has(strip(line.text))),
    )
    const blocks = []
    const byGroup = new Map()
    for (const line of lines) {
      if (!byGroup.has(line.g)) byGroup.set(line.g, [])
      byGroup.get(line.g).push(line)
    }
    for (const [g, group] of byGroup) {
      blocks.push(...blocksFromLines(group, page.body).map((b) => ({ ...b, g })))
    }
    blocks.push(...page.extraBlocks)
    blocks.sort((a, b) => a.g - b.g || a.y - b.y)
    const outLines = lines.map((line, index) => ({
      i: index,
      text: line.text,
      // Retângulo no espaço do PDF (origem embaixo à esquerda), que é o que
      // sobrevive a zoom, rotação e redimensionamento.
      rect: [
        Math.round(line.x * 100) / 100,
        Math.round((page.height - (line.y + line.h)) * 100) / 100,
        Math.round((line.x + line.w) * 100) / 100,
        Math.round((page.height - line.y) * 100) / 100,
      ],
    }))
    return {
      n: page.n,
      md: markdownFromBlocks(blocks, page.n === 1, page.tables),
      text: [
        blocks.map((b) => b.text).join('\n\n'),
        page.tables.map((t) => t.text).join('\n\n'),
      ]
        .filter(Boolean)
        .join('\n\n'),
      lines: outLines,
      blocks: blocks.map(({ text, x, y, w, h, size }) => ({
        text,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        w: Math.round(w * 100) / 100,
        h: Math.round(h * 100) / 100,
        size: Math.round(size * 100) / 100,
      })),
      figures: page.figures,
    }
  })
}

export function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*-\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function matchingBlocks(blocks, quote) {
  const q = normalize(quote)
  if (q.length < 12) return []
  const direct = blocks.filter((b) => {
    const t = normalize(b.text)
    return t.length > 8 && (q.includes(t) || t.includes(q))
  })
  if (direct.length) return direct
  const head = q.split(' ').slice(0, 8).join(' ')
  if (head.length < 12) return []
  return blocks.filter((b) => normalize(b.text).includes(head))
}
