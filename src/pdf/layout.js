// Lógica pura de layout: itens de texto do pdf.js -> linhas, colunas, tabelas, parágrafos.
// Nada aqui depende do DOM nem do pdf.js, então roda em Node/Vitest.

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

/** Separa uma página em duas colunas quando existe uma calha vertical clara. */
// Cabeçalho de periódico: ISSN, DOI, "Revista X, v. 3, n. 4", "v. 36, n. 2,
// p. 203-217, 2016".
const MASTHEAD =
  /\b(e-?issn|issn|doi)\b|^(revista|cadernos|boletim|periódico|vidya)\b|\b(v\.|vol\.)\s*\d+\s*,?\s*n\.\s*\d+\b.*\b(19|20)\d{2}\b/i
// Número de página: "3", "– 3 –", "Página 3", "3 / 10".
const FOLIO =
  /^[–—-]?\s*(p[áa]g(ina)?\.?|page|p\.)?\s*\d{1,4}\s*[–—-]?(\s*(\/|de|of)\s*\d{1,4})?$/i
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
  const kept = lines.filter((line) => {
    const text = line.text.trim()
    if (line.y < height * 0.1 && (MASTHEAD.test(text) || FOLIO.test(text))) return false
    // Número de página isolado no pé (ou "3 / 10", "– 3 –").
    if (line.y > height * 0.86 && FOLIO.test(text)) return false
    return true
  })
  const small = (line) => bodySize > 0 && line.size <= bodySize * 0.86
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

// ---------------------------------------------------------------------------
// Texto: ligaduras, controles e hifenização
// ---------------------------------------------------------------------------

const LIGATURES = {
  '\u001b': 'ff',
  '\u001c': 'fi',
  '\u001d': 'fl',
  '\u001e': 'ffi',
  '\u001f': 'ffl',
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
}
const OT1_LIGATURES = { '\u000b': 'ff', '\u000c': 'fi', '\u000d': 'fl', '\u000e': 'ffi', '\u000f': 'ffl' }

/**
 * Conserta texto que o pdf.js entrega quebrado. PDFs do LaTeX com fonte T1
 * sem ToUnicode trazem "fi", "fl", "ff" como caracteres de controle
 * (U+001B..U+001F): "específicos" vira "especí\u001ccos" e o modelo lê
 * "especícos". Ligaduras Unicode (ﬁ) também são expandidas, para busca e
 * citações casarem com o que o usuário digita.
 */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/[\u001b-\u001fﬀ-ﬆ]/g, (c) => LIGATURES[c])
    .replace(/(\p{L})([\u000b-\u000f])(?=\p{L})/gu, (_, before, c) => before + OT1_LIGATURES[c])
    .replace(/­$/, '-')
    .replace(/­/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

const WORD = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu

/** Vocabulário do documento: palavras (com hífen) que aparecem DENTRO de uma linha. */
export function buildVocabulary(lineTexts) {
  const vocab = new Set()
  for (const text of lineTexts) {
    const words = text.toLowerCase().match(WORD)
    if (!words) continue
    // A última palavra pode ser metade de uma palavra hifenizada.
    const end = /-$/.test(text.trim()) ? words.length - 1 : words.length
    for (let i = 0; i < end; i += 1) vocab.add(words[i])
  }
  return vocab
}

// Pronomes oblíquos que se ligam ao verbo por hífen: "consolidou-se", "diz-lhe".
const ENCLITICS = new Set([
  'se', 'me', 'te', 'lhe', 'lhes', 'nos', 'vos', 'o', 'a', 'os', 'as', 'lo', 'la', 'los', 'las',
  'no', 'na', 'nas', 'ia', 'ei', 'á', 'ão',
])

/**
 * Junta duas linhas de um parágrafo. Hífen no fim da linha é quebra de
 * palavra ("estatís-" + "tica") ou hífen de verdade ("situações-" +
 * "problema", "consolidou-" + "se"). O vocabulário do próprio documento
 * decide; sem evidência, junta, exceto diante de pronome oblíquo.
 */
export function joinLine(a, b, vocab) {
  if (!/[-‐]$/.test(a) || !/^\p{L}/u.test(b)) return `${a} ${b}`.replace(/\s+/g, ' ')
  const stemMatch = a.slice(0, -1).match(/[\p{L}\p{N}]+$/u)
  const nextMatch = b.match(/^[\p{L}\p{N}]+/u)
  const stem = (stemMatch?.[0] || '').toLowerCase()
  const next = (nextMatch?.[0] || '').toLowerCase()
  if (!stem || !next) return `${a} ${b}`.replace(/\s+/g, ' ')
  const joined = stem + next
  const hyphened = `${stem}-${next}`
  let keep
  if (vocab?.has(hyphened)) keep = true
  else if (vocab?.has(joined)) keep = false
  else if (/^\p{Lu}/u.test(b) && /^\p{Lu}/u.test(stemMatch[0])) keep = true // Rio-Grande
  else keep = ENCLITICS.has(next)
  return keep ? a.slice(0, -1) + '-' + b : a.slice(0, -1) + b
}

// ---------------------------------------------------------------------------
// Colunas
// ---------------------------------------------------------------------------

function crosses(item, lo, hi) {
  return item.x < hi && item.x + item.w > lo
}

/** Vãos largos (>= 1,5 em) dentro da linha, fora da calha: candidatos a colunas de tabela. */
function wideGaps(line, skip) {
  const min = Math.max(10, line.size * 1.5)
  const gaps = []
  const items = [...line.items].sort((a, b) => a.x - b.x)
  for (let i = 1; i < items.length; i += 1) {
    const from = items[i - 1].x + items[i - 1].w
    const to = items[i].x
    if (to - from < min) continue
    if (skip && from <= skip[1] && to >= skip[0]) continue
    gaps.push([from, to])
  }
  return gaps
}

/**
 * Os vãos de uma linha se alinham com os da outra? Todo vão da linha com menos
 * vãos precisa ter par na outra, com 70% de sobreposição. Em texto justificado
 * os espaços esticados caem em posições diferentes a cada linha; em tabela, as
 * colunas ficam no mesmo lugar.
 */
export function alignedGaps(a, b, ratio = 0.7) {
  const [few, many] = a.length <= b.length ? [a, b] : [b, a]
  if (!few.length) return false
  return few.every(([a0, a1]) =>
    many.some(([b0, b1]) => {
      const overlap = Math.min(a1, b1) - Math.max(a0, b0)
      return overlap >= 1 && overlap >= ratio * Math.min(a1 - a0, b1 - b0)
    }),
  )
}

/**
 * Acha a calha entre duas colunas: a faixa vertical por onde passam menos
 * linhas. Devolve [x0, x1] ou null. Linhas de largura total (título, resumo,
 * figura) cruzam a calha e são toleradas até 25%.
 */
function findGutter(rows, items, pageWidth) {
  const g = 3
  const total = rows.length
  let best = null
  const counts = []
  for (let c = Math.round(pageWidth * 0.3); c <= Math.round(pageWidth * 0.7); c += 1) {
    let n = 0
    for (const row of rows) if (row.items.some((it) => crosses(it, c - g, c + g))) n += 1
    counts.push([c, n])
    if (!best || n < best.n) best = { n }
  }
  if (!best || best.n > total * 0.25) return null
  const ok = counts.filter(([, n]) => n <= best.n).map(([c]) => c)
  // Maior trecho contíguo de candidatos = a calha.
  let run = [ok[0], ok[0]]
  let top = run
  for (let i = 1; i < ok.length; i += 1) {
    if (ok[i] === run[1] + 1) run[1] = ok[i]
    else run = [ok[i], ok[i]]
    if (run[1] - run[0] > top[1] - top[0]) top = run
  }
  const lo = top[0] - g
  const hi = top[1] + g
  if (hi - lo < 6) return null
  const mid = (lo + hi) / 2
  const left = items.filter((it) => it.x + it.w / 2 < mid).length
  const right = items.length - left
  if (left < items.length * 0.2 || right < items.length * 0.2) return null
  return [lo, hi]
}

/**
 * Ordem de leitura em grupos de linhas. Página de coluna única volta inteira.
 * Página de duas colunas volta fatiada em faixas: linhas de largura total
 * (título, resumo, tabela larga) formam um grupo; abaixo delas vêm a coluna
 * esquerda inteira da faixa e depois a direita. Cada grupo vira parágrafos
 * por conta própria, então uma frase nunca mistura as duas colunas.
 */
export function splitColumns(items, pageWidth) {
  const rows = linesFromItems(items)
  if (rows.length < 16) return [rows]
  const gutter = findGutter(rows, items, pageWidth)
  if (!gutter) return [rows]
  const mid = (gutter[0] + gutter[1]) / 2

  const groups = []
  let full = []
  let band = []
  const flushFull = () => {
    if (full.length) groups.push(full)
    full = []
  }
  const flushBand = () => {
    if (!band.length) return
    const left = band.filter((it) => it.x + it.w / 2 < mid)
    const right = band.filter((it) => it.x + it.w / 2 >= mid)
    if (left.length) groups.push(linesFromItems(left))
    if (right.length) groups.push(linesFromItems(right))
    band = []
  }
  // Tabela de largura total: vãos largos que se repetem em 3 linhas seguidas
  // nos DOIS lados da calha. Texto justificado também tem vãos largos, mas eles
  // não se alinham de uma linha para a outra; e uma tabela só de uma coluna
  // ao lado de texto da outra fica na própria coluna (extractTables cuida).
  const sideGaps = (side) =>
    rows.map((row) =>
      wideGaps(
        { ...row, items: row.items.filter((it) => (it.x + it.w / 2 < mid) === (side === 'left')) },
        gutter,
      ),
    )
  const chainOf = (gapsBySide) => {
    const pairOk = gapsBySide.map(
      (g, i) => g.length >= 1 && gapsBySide[i + 1]?.length >= 1 && alignedGaps(g, gapsBySide[i + 1]),
    )
    return (i) =>
      Boolean((pairOk[i - 1] && pairOk[i]) || (pairOk[i] && pairOk[i + 1]) || (pairOk[i - 2] && pairOk[i - 1]))
  }
  const chainLeft = chainOf(sideGaps('left'))
  const chainRight = chainOf(sideGaps('right'))
  const tabularAt = (i) => chainLeft(i) && chainRight(i)
  // Bordas das colunas e extensão do texto, para reconhecer linhas centradas
  // (autores, legenda) e continuação de linha de largura total.
  const sorted = (values) => values.sort((a, b) => a - b)
  const pick = (values, q) => (values.length ? values[Math.floor((values.length - 1) * q)] : 0)
  const leftEdge = pick(sorted(items.filter((it) => it.x + it.w / 2 < mid).map((it) => it.x)), 0.1)
  const rightEdge = pick(sorted(items.filter((it) => it.x + it.w / 2 >= mid).map((it) => it.x + it.w)), 0.9)
  const textWidth = rightEdge - leftEdge

  let previous = null
  for (const [index, row] of rows.entries()) {
    const spans = row.items.some((it) => crosses(it, gutter[0], gutter[1]))
    const left = row.items.filter((it) => it.x + it.w / 2 < mid)
    const right = row.items.filter((it) => it.x + it.w / 2 >= mid)
    const slack = Math.max(18, row.size * 2)
    // Autores lado a lado, centrados na página: os dois lados começam e terminam
    // longe das bordas das colunas.
    const centered =
      left.length > 0 &&
      right.length > 0 &&
      Math.min(...left.map((it) => it.x)) > leftEdge + slack &&
      Math.max(...right.map((it) => it.x + it.w)) < rightEdge - slack
    // Segunda linha curta de um texto de largura total (resumo): sem nada à
    // direita, logo abaixo de uma linha que ocupava a página toda.
    const continues =
      !spans &&
      right.length === 0 &&
      band.length === 0 &&
      previous &&
      Math.abs(previous.x - row.x) <= 2 &&
      previous.w > textWidth * 0.8 &&
      Math.abs(previous.size - row.size) <= 0.6 &&
      row.y + row.h - (previous.y + previous.h) <= row.size * 1.4
    const wide = spans || centered || tabularAt(index) || continues
    if (wide) {
      flushBand()
      full.push(row)
      previous = row
    } else {
      flushFull()
      band.push(...row.items)
      previous = null
    }
  }
  flushFull()
  flushBand()
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


/** Intervalos vazios entre células consecutivas de uma linha. */
function gapsOf(cells) {
  const gaps = []
  for (let i = 1; i < cells.length; i += 1) gaps.push([cells[i - 1].x + cells[i - 1].w, cells[i].x])
  return gaps
}

/** Duas linhas de células têm as mesmas colunas? */
function sharesGap(a, b) {
  // Colunas numéricas alinhadas à direita deslocam o vão: 50% bastam.
  return alignedGaps(gapsOf(a), gapsOf(b), 0.5)
}

/**
 * Tira das linhas as regiões que parecem tabela e devolve o Markdown e o texto
 * delas. Uma tabela exige linhas com 2+ células cujos vãos se alinham
 * verticalmente em linhas consecutivas: texto justificado também tem vãos
 * largos, mas eles não se alinham de uma linha para a outra.
 */
export function extractTables(lines) {
  const plain = []
  const tables = []
  let run = [] // linhas com células, mais continuações de célula
  const candidates = () => run.filter((row) => row.cells.length >= 2)

  const revert = () => {
    for (const row of run) plain.push(row.line, ...row.conts)
    run = []
  }
  const flush = () => {
    const cand = candidates()
    if (cand.length >= 3) {
      const rows = run.map((row) => ({
        y: row.y,
        h: row.h,
        cells: row.cells.map((cell) => escapeCell(cell.text)),
      }))
      const left = Math.min(...run.map((row) => row.x))
      const right = Math.max(...run.map((row) => row.x + row.w))
      tables.push({
        y: Math.min(...run.map((row) => row.y)),
        bottom: Math.max(...run.map((row) => row.y + row.h)),
        x: left,
        w: right - left,
        rows,
        md: tableMarkdown(rows),
        text: run.map((row) => row.cells.map((cell) => cell.text).join(' | ')).join('\n'),
      })
      run = []
    } else {
      revert()
    }
  }

  for (const line of lines) {
    const cells = cellsFromLine(line)
    const row = { ...line, line, cells, conts: [] }
    if (cells.length >= 2 && cells.length <= 12) {
      const last = candidates().pop()
      if (run.length && last && !sharesGap(last.cells, cells)) flush()
      run.push(row)
      continue
    }
    // Célula quebrada em várias linhas: cola na coluna mais próxima, mas só se a
    // linha cabe dentro da largura da tabela. Parágrafo logo abaixo da tabela
    // (largura de página) não é continuação de célula.
    const last = run[run.length - 1]
    if (candidates().length >= 2 && cells.length === 1 && last) {
      const gap = line.y - (last.y + last.h)
      const left = Math.min(...run.map((r) => r.x))
      const right = Math.max(...run.map((r) => r.x + r.w))
      const inside = line.x >= left - 6 && line.x + line.w <= right + 6
      if (inside && gap < last.h * 1.2) {
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
        last.conts.push(line)
        continue
      }
    }
    flush()
    plain.push(line)
  }
  flush()
  return { plain, tables }
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

/**
 * Agrupa linhas em parágrafos/títulos. Parágrafo novo quando: espaçamento
 * vertical maior que o entrelinha típico, recuo de primeira linha, linha
 * anterior curta em texto justificado, salto de corpo ou mudança de papel
 * (título/corpo).
 */
export function blocksFromLines(lines, bodySize, vocab) {
  const blocks = []
  let current = null
  let prev = null
  // Centro de referência da coluna: linha centrada que muda de x (título de
  // duas linhas) continua sendo o mesmo parágrafo. Só o que foge do centro
  // (autor, epígrafe) é que quebra.
  const bodyLines = lines.filter((line) => Math.abs(line.size - bodySize) <= 0.6)
  const refLines = bodyLines.length ? bodyLines : lines
  const centers = refLines.map((line) => line.x + line.w / 2).sort((a, b) => a - b)
  const refCenter = centers.length ? centers[Math.floor(centers.length / 2)] : 0

  // Margem esquerda = x mais frequente (±1,5 pt) entre as linhas de corpo;
  // margem direita = percentil 90 do fim das linhas.
  let leftMargin = 0
  let best = 0
  for (const line of refLines) {
    const n = refLines.filter((other) => Math.abs(other.x - line.x) <= 1.5).length
    if (n > best || (n === best && line.x < leftMargin)) {
      best = n
      leftMargin = line.x
    }
  }
  const ends = refLines.map((line) => line.x + line.w).sort((a, b) => a - b)
  const rightMargin = ends.length ? ends[Math.floor((ends.length - 1) * 0.9)] : 0
  const flush = refLines.filter((line) => line.x + line.w >= rightMargin - 2).length
  const justified = refLines.length >= 6 && flush / refLines.length >= 0.55

  // Entrelinha típico: mediana da distância entre linhas de mesmo corpo.
  const steps = []
  for (let i = 1; i < lines.length; i += 1) {
    const a = lines[i - 1]
    const b = lines[i]
    const dy = b.y + b.h - (a.y + a.h)
    if (Math.abs(a.size - b.size) <= 0.6 && dy > a.size * 0.8 && dy < a.size * 2.5) steps.push(dy)
  }
  const leading = median(steps) || bodySize * 1.2

  // Recuo suspenso (referências): a primeira linha encosta na margem e as
  // seguintes ficam recuadas, em sequência. Recuo de parágrafo atinge uma
  // linha só; se há duas linhas seguidas recuadas, é recuo suspenso.
  const step = Math.max(5, bodySize * 0.8)
  let hanging = false
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (lines[i].x - leftMargin > step && Math.abs(lines[i + 1].x - lines[i].x) < 1.5) hanging = true
  }

  for (const line of lines) {
    if (!line.text) continue
    const caps = isCapsHeading(line.text)
    const named = isSectionName(line.text)
    const heading =
      caps ||
      named ||
      (bodySize > 0 && line.size >= bodySize * 1.25 && line.text.length < 140) ||
      // Subtítulo em corpo um pouco maior, curto e sem ponto final.
      (bodySize > 0 &&
        line.size >= bodySize * 1.12 &&
        line.text.length < 100 &&
        !/[.;,:]$/.test(line.text.trim()))
    let newBlock = !current
    if (current) {
      const dy = line.y + line.h - (prev.y + prev.h)
      const expected = Math.max(leading, prev.size * 1.25)
      const jump = bodySize > 0 && Math.abs(line.size - prev.size) / prev.size > 0.22
      const centered = Math.abs(line.x + line.w / 2 - refCenter) < bodySize * 4
      const shifted = !centered && Math.abs(line.x - current.x) > bodySize * 3
      // Título de duas linhas: mesmo corpo (±20%), centrado e acima do corpo.
      const continuesHeading =
        current.heading &&
        centered &&
        line.size >= bodySize * 1.05 &&
        Math.abs(line.size - prev.size) <= prev.size * 0.2
      const indent = line.x - leftMargin
      const outdent = hanging && line.x < prev.x - step && !current.heading
      const indented =
        !hanging &&
        indent > Math.max(5, bodySize * 0.8) &&
        indent < bodySize * 4 &&
        Math.abs(prev.x - leftMargin) < Math.max(3, bodySize * 0.5) &&
        !current.heading
      const shortPrev = justified && prev.x + prev.w < rightMargin - bodySize * 3 && !current.heading
      newBlock =
        dy > expected * 1.3 + 0.5 ||
        (jump && !continuesHeading) ||
        (heading && !continuesHeading) ||
        (current.heading && !continuesHeading) ||
        shifted ||
        indented ||
        outdent ||
        shortPrev
    }
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
      current.text = joinLine(current.text, line.text, vocab)
    }
    prev = line
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
  const items = [
    ...blocks.map((block) => ({ y: block.y, g: block.g || 0, block })),
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
    if (block.size >= body * 1.28 && text.length < 120) {
      md += `## ${text}\n\n`
      continue
    }
    if (block.size >= body * 1.12 && (block.heading || text.length < 200)) {
      md += `### ${text}\n\n`
      continue
    }
    if (block.heading) {
      md += `## ${text}\n\n`
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
  return md.trim()
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

const round2 = (value) => Math.round(value * 100) / 100

/** Multiplicação de matrizes 2x3 do pdf.js (Util.transform). */
export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det) return [1, 0, 0, 1, 0, 0]
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ]
}

/**
 * Retângulo da linha (espaço da tela a escala 1) -> espaço do PDF, desfazendo a
 * matriz da página (rotação /Rotate, MediaBox deslocada). Sem `vt`, assume
 * página sem rotação e origem em (0,0).
 */
export function screenToPdfRect(line, page) {
  const x0 = line.x
  const x1 = line.x + line.w
  const y0 = line.y
  const y1 = line.y + line.h
  if (!page.vt) {
    return [round2(x0), round2(page.height - y1), round2(x1), round2(page.height - y0)]
  }
  const inv = invert(page.vt)
  const pts = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [round2(Math.min(...xs)), round2(Math.min(...ys)), round2(Math.max(...xs)), round2(Math.max(...ys))]
}

/**
 * Converte os itens do getTextContent() de UMA página em material bruto
 * (linhas, tabelas, blocos extras). `transform` é pdfjs Util.transform
 * (multiplicação de matrizes 2x3). `viewport` precisa de width, height, scale e
 * transform, já com a rotação da página aplicada.
 */
export function rawPageFromItems(n, contentItems, viewport, transform) {
  const items = []
  const rotated = []
  for (const item of contentItems) {
    if (!item.str || !item.transform) continue
    const str = cleanText(item.str)
    if (!str.trim()) continue
    // Tudo é decidido no espaço da TELA (matriz da página já aplicada): numa
    // página com /Rotate 90 o texto normal está "de lado" no espaço do PDF.
    const tx = transform(viewport.transform, item.transform)
    const raw = item.transform
    const fontH = Math.hypot(raw[2], raw[3]) * viewport.scale
    const h = Math.abs((item.height || 0) * viewport.scale) || fontH || 10
    const slant = Math.abs(tx[1]) > Math.abs(tx[0]) * 0.15 + 0.01
    if (slant) {
      // Texto em pé (tabela girada, rótulo de eixo): não dá para reler como
      // linha, então vira recorte para o modelo enxergar.
      const len = Math.abs(item.width || 0) * viewport.scale
      const w = Math.max(len, h * Math.min(str.trim().length, 60) * 0.4)
      const corners = [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ].map(([u, v]) => transform(viewport.transform, transform(raw, [1, 0, 0, 1, u / viewport.scale, v / viewport.scale])))
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
    const w = Math.abs((item.width || 0) * viewport.scale)
    // Número solto no pé da página é folio, não conteúdo.
    if (/^\d{1,3}$/.test(str.trim()) && tx[5] > viewport.height * 0.9) continue
    items.push({ str, x: tx[4], y: tx[5] - h, w, h, size: h })
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
      ...stripApparatus(found.plain, viewport.height, body).map(({ items: _drop, ...line }) => ({
        ...line,
        g: gi,
      })),
    )
    tables = tables.concat(found.tables.map((t) => ({ ...t, g: gi })))
  }
  const extraBlocks = []
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
      tableBoxes.push({ x: table.x, y: table.y, w: table.w, h: table.bottom - table.y })
      for (const row of table.rows) {
        extraBlocks.push({
          text: row.cells.join(' — '),
          x: table.x,
          y: row.y,
          w: 200,
          h: row.h,
          size: body,
          g: table.g || 0,
          extra: true,
        })
      }
    }
  }
  return {
    n,
    lines,
    extraBlocks,
    tables: solid,
    height: viewport.height,
    vt: Array.from(viewport.transform),
    body,
    figureBoxes: [...rotated, ...tableBoxes],
  }
}

/**
 * Parágrafo que termina no pé da coluna esquerda e continua no alto da direita
 * ("... de modo" / "a favorecer ..."): vira um só. Só junta quando o primeiro
 * não fecha frase e o segundo começa em minúscula; muda `blocks` no lugar.
 */
export function joinAcrossGroups(blocks, vocab) {
  for (let i = blocks.length - 1; i > 0; i -= 1) {
    const a = blocks[i - 1]
    const b = blocks[i]
    if (a.g === b.g || a.heading || b.heading || a.extra || b.extra) continue
    if (/[.!?…:;»”")\]]$/.test(a.text.trim()) || !/^\p{Ll}/u.test(b.text.trim())) continue
    if (Math.abs(a.size - b.size) > 0.8) continue
    a.text = joinLine(a.text, b.text, vocab)
    a.w = Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x)
    a.x = Math.min(a.x, b.x)
    blocks.splice(i, 1)
  }
}

/**
 * Segunda passada, sobre o documento inteiro: tira cabeçalho/rodapé repetido
 * (só dá para ver depois de conhecer todas as páginas) e monta o Markdown, os
 * blocos e as linhas com retângulo (espaço do PDF, origem embaixo à esquerda).
 */
export function finalizePages(pages) {
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

  const kept = pages.map((page) =>
    page.lines.filter((line) => !(inBand(line, page.height) && repeated.has(strip(line.text)))),
  )
  const vocab = buildVocabulary(kept.flatMap((lines) => lines.map((line) => line.text)))

  return pages.map((page, pageIndex) => {
    const lines = kept[pageIndex]
    const blocks = []
    const byGroup = new Map()
    for (const line of lines) {
      if (!byGroup.has(line.g)) byGroup.set(line.g, [])
      byGroup.get(line.g).push(line)
    }
    for (const [g, group] of byGroup) {
      blocks.push(...blocksFromLines(group, page.body, vocab).map((b) => ({ ...b, g })))
    }
    blocks.push(...page.extraBlocks)
    blocks.sort((a, b) => a.g - b.g || a.y - b.y)
    joinAcrossGroups(blocks, vocab)
    const outLines = lines.map((line, index) => ({
      i: index,
      text: line.text,
      // Retângulo no espaço do PDF (origem embaixo à esquerda), que é o que
      // sobrevive a zoom, rotação e redimensionamento.
      rect: screenToPdfRect(line, page),
    }))
    return {
      n: page.n,
      md: markdownFromBlocks(blocks, page.n === 1, page.tables),
      text: [blocks.map((b) => b.text).join('\n\n'), page.tables.map((t) => t.text).join('\n\n')]
        .filter(Boolean)
        .join('\n\n'),
      lines: outLines,
      blocks: blocks.map(({ text, x, y, w, h, size }) => ({
        text,
        x: round2(x),
        y: round2(y),
        w: round2(w),
        h: round2(h),
        size: round2(size),
      })),
      figures: page.figures || [],
    }
  })
}

