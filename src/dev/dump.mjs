// Uso: npx vite-node src/dev/dump.mjs arquivo.pdf [pagina]
// Imprime o Markdown extraído (build legacy do pdf.js em Node, sem recortes).
import fs from 'node:fs'
import * as lib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPagesWith } from '../pdf/extract.js'

const [file, only] = process.argv.slice(2)
const data = new Uint8Array(fs.readFileSync(file))
const pdf = await lib.getDocument({ data, isEvalSupported: false }).promise
const t0 = Date.now()
const pages = await extractPagesWith(lib, pdf, { figures: false })
console.error(`# ${pages.length} páginas em ${Date.now() - t0} ms`)
for (const page of pages) {
  if (only && Number(only) !== page.n) continue
  console.log(`\n======== PÁGINA ${page.n} ========\n${page.md}`)
}
