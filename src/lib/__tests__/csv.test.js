import { describe, expect, it } from 'vitest'
import { buildFichamentoCsv, csvEscape, parseCsv, toCsv } from '../csv'

describe('csv', () => {
  it('escapa aspas, vírgulas e quebras de linha', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('diz "oi"')).toBe('"diz ""oi"""')
    expect(csvEscape('l1\nl2')).toBe('"l1\nl2"')
    expect(csvEscape(null)).toBe('')
  })
  it('protege contra injeção de fórmula, mas preserva números', () => {
    expect(csvEscape('=SOMA(A1)')).toBe("'=SOMA(A1)")
    expect(csvEscape('@cmd')).toBe("'@cmd")
    expect(csvEscape('-12,5')).toBe('-12,5'.includes(',') ? '"-12,5"' : '-12,5')
    expect(csvEscape('-5')).toBe('-5')
  })
  it('usa BOM e CRLF (Excel)', () => {
    const csv = toCsv([['a', 'b'], ['1', '2']])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('\r\n')
  })
  it('ida e volta com acentos', () => {
    const rows = [['Documento', 'Método'], ['Título "x", ç', 'linha1\nlinha2']]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })
  it('monta o fichamento com a coluna de trechos', () => {
    const csv = buildFichamentoCsv({
      docs: [{ id: 'd1', name: 'Artigo.pdf' }, { id: 'd2', name: 'Outro.pdf' }],
      columns: [{ id: 'c1', name: 'Objetivo' }],
      cells: [{ doc_id: 'd1', column_id: 'c1', value: 'Medir', quote: 'medimos tudo', page: 3 }],
    })
    const rows = parseCsv(csv)
    expect(rows[0]).toEqual(['Documento', 'Objetivo', 'Trechos'])
    expect(rows[1]).toEqual(['Artigo.pdf', 'Medir', '[p.3] medimos tudo'])
    expect(rows[2]).toEqual(['Outro.pdf', '', ''])
  })
  it('aceita ponto e vírgula (Excel pt-BR)', () => {
    const csv = buildFichamentoCsv({ docs: [{ id: 'a', name: 'x' }], columns: [{ id: 'c', name: 'N' }], cells: [] }, { delimiter: ';' })
    expect(csv).toContain('Documento;N;Trechos')
  })
})
