// CSV para Excel (Windows e macOS): BOM UTF-8, CRLF, aspas duplas e proteção
// contra "injeção de fórmula" (=, +, -, @ no começo da célula).

const FORMULA = /^[=+\-@\t\r]/

/** Prefixa com apóstrofo o texto que uma planilha leria como fórmula (números ficam como estão). */
export function guardFormula(text) {
  return FORMULA.test(text) && !/^[-+]?\d+([.,]\d+)?%?$/.test(text) ? `'${text}` : text
}

export function csvEscape(value, { guardFormulas = true, delimiter = ',' } = {}) {
  const needsQuotes = (t) => t.includes('"') || t.includes(delimiter) || /[\r\n]/.test(t) || /^\s|\s$/.test(t)
  let text = value == null ? '' : String(value)
  if (guardFormulas) text = guardFormula(text)
  return needsQuotes(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows, { bom = true, eol = '\r\n', guardFormulas = true, delimiter = ',' } = {}) {
  const body = rows.map((row) => row.map((cell) => csvEscape(cell, { guardFormulas, delimiter })).join(delimiter)).join(eol)
  return `${bom ? '﻿' : ''}${body}${eol}`
}

/** Mesmas colunas do write_csv do backend: Documento, colunas…, Trechos. */
export function fichamentoRows({ docs, columns, cells }) {
  const rows = [['Documento', ...columns.map((c) => c.name), 'Trechos']]
  for (const doc of docs) {
    const quotes = []
    const values = columns.map((column) => {
      const cell = cells.find((c) => c.doc_id === doc.id && c.column_id === column.id)
      if (cell?.quote && cell.page) quotes.push(`[p.${cell.page}] ${cell.quote}`)
      return cell?.value || ''
    })
    rows.push([doc.name, ...values, quotes.join(' | ')])
  }
  return rows
}

export function buildFichamentoCsv(data, options) {
  return toCsv(fichamentoRows(data), options)
}

/** Leitor mínimo (RFC 4180) para os testes e para conferir a exportação. */
export function parseCsv(text, delimiter = ',') {
  const src = String(text).replace(/^﻿/, '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === delimiter) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
