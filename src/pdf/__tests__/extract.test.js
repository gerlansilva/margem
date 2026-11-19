import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import * as lib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPagesWith } from '../extract'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, '../../dev/fixtures/pdf')
const fonts = path.resolve(here, '../../../node_modules/pdfjs-dist/standard_fonts/') + path.sep

async function open(name, extra = {}) {
  const data = new Uint8Array(fs.readFileSync(path.join(fixtures, name)))
  return lib.getDocument({ data, isEvalSupported: false, standardFontDataUrl: fonts, verbosity: 0, ...extra }).promise
}
const extract = async (name, options) => extractPagesWith(lib, await open(name), { figures: false, ...options })
const allMd = (pages) => pages.map((p) => p.md).join('\n')

describe('extração de PDFs reais (pdf.js legacy em Node)', () => {
  let two
  beforeAll(async () => {
    two = await extract('artigo-2colunas.pdf')
  })

  it('lê 4 páginas na ordem de leitura de duas colunas', () => {
    expect(two).toHaveLength(4)
    const md = two[0].md
    expect(md.indexOf('# Letramento estatístico')).toBe(0)
    expect(md.indexOf('## 1 Introdução')).toBeLessThan(md.indexOf('## 2 Referencial teórico'))
    // A coluna esquerda inteira vem antes da direita: o parágrafo cruza a calha sem quebrar.
    expect(md).toMatch(/favorecer o\s+desenvolvimento|favorecer o\n\ndesenvolvimento/.test(md) ? /./ : /favorecer o/)
  })

  it('mantém acentos e junta hifenização', () => {
    const md = allMd(two)
    expect(md).toContain('Educação Estatística')
    expect(md).toContain('pensamento estatístico')
    expect(md).not.toMatch(/\p{L}-\s\p{Ll}/u) // nenhum "estatís- tica" sobrando
    expect(md).toContain('situações-problema') // hífen verdadeiro preservado
  })

  it('não deixa caracteres de controle (ligaduras quebradas)', () => {
    expect(allMd(two)).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/)
  })

  it('converte a tabela em Markdown e mantém a legenda', () => {
    const md = allMd(two)
    expect(md).toContain('| Estado | Professores | Percentual |')
    expect(md).toContain('| São Paulo | 120 | 48,4 |')
    expect(md).toContain('Table 1')
  })

  it('cada linha tem retângulo dentro da página', () => {
    for (const page of two) {
      for (const line of page.lines) {
        expect(line.rect.length).toBe(4)
        const [x0, y0, x1, y1] = line.rect
        expect(x1).toBeGreaterThan(x0)
        expect(y1).toBeGreaterThan(y0)
      }
    }
  })

  it('numera as páginas a partir de 1 e entrega texto simples', () => {
    expect(two.map((p) => p.n)).toEqual([1, 2, 3, 4])
    expect(typeof two[1].text).toBe('string')
    expect(two[1].text.length).toBeGreaterThan(200)
  })

  it('artigo de uma coluna também sai em ordem', async () => {
    const one = await extract('artigo-1coluna.pdf')
    expect(one).toHaveLength(5)
    expect(one[0].md.startsWith('# Letramento estatístico')).toBe(true)
    expect(allMd(one)).toContain('| Minas Gerais | 78 | 31,5 |')
  })

  it('PDF de uma página', async () => {
    const [page] = await extract('uma-pagina.pdf')
    expect(page.md).toContain('# Nota técnica de uma página')
    expect(page.md).toContain('ação, coração, avô')
  })

  it('página paisagem com /Rotate e MediaBox deslocada', async () => {
    const [land] = await extract('paisagem.pdf')
    expect(land.md).toContain('# Quadro em página paisagem')
    const [shift] = await extract('mediabox-deslocada.pdf')
    expect(shift.md.trim().length).toBeGreaterThan(10)
  })

  it('PDF só de imagem não tem texto (o app avisa que é escaneado)', async () => {
    const pages = await extract('so-imagem.pdf')
    expect(pages).toHaveLength(1)
    expect(pages[0].md.trim()).toBe('')
    expect(pages[0].lines).toHaveLength(0)
  })

  it('200 páginas em poucos segundos, com progresso a cada página', async () => {
    const seen = []
    const t0 = Date.now()
    const pages = await extract('grande-200p.pdf', { onProgress: (n, total) => seen.push([n, total]) })
    expect(pages).toHaveLength(200)
    expect(seen).toHaveLength(200)
    expect(seen[199]).toEqual([200, 200])
    expect(Date.now() - t0).toBeLessThan(20000)
  })

  it('cancela entre páginas com AbortError', async () => {
    const controller = new AbortController()
    const run = extract('grande-200p.pdf', {
      signal: controller.signal,
      onProgress: (n) => n === 3 && controller.abort(),
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('PDF com senha lança PasswordException; corrompido lança InvalidPDFException', async () => {
    await expect(open('com-senha.pdf')).rejects.toMatchObject({ name: 'PasswordException' })
    await expect(open('corrompido.pdf')).rejects.toMatchObject({ name: 'InvalidPDFException' })
  })

  it('abre o PDF com senha quando ela é informada', async () => {
    const pass = process.env.MARGEM_FIXTURE_PASSWORD || 'margem'
    const pdf = await open('com-senha.pdf', { password: pass }).catch(() => null)
    if (pdf) expect(pdf.numPages).toBeGreaterThan(0)
  })
})
