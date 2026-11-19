import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const pdfjsRoot = path.resolve('node_modules/pdfjs-dist')
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm']
const MIME = { '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.png': 'image/png' }

/**
 * Entrega cmaps, fontes padrão e wasm do pdf.js como arquivos estáticos (o
 * Tauri não tem rede garantida). Sem eles, PDFs com fontes CJK/não embutidas
 * extraem texto errado e JPEG2000/JBIG2 não decodificam.
 */
function pdfjsAssets() {
  const files = () =>
    PDFJS_DIRS.flatMap((dir) =>
      fs.existsSync(path.join(pdfjsRoot, dir))
        ? fs.readdirSync(path.join(pdfjsRoot, dir)).map((name) => `${dir}/${name}`)
        : [],
    )
  return {
    name: 'margem-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
        const file = path.join(pdfjsRoot, rel)
        if (!file.startsWith(pdfjsRoot + path.sep) || !fs.existsSync(file)) return next()
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const rel of files()) {
        this.emitFile({
          type: 'asset',
          fileName: `pdfjs/${rel}`,
          source: fs.readFileSync(path.join(pdfjsRoot, rel)),
        })
      }
    },
  }
}

/** Só em `vite --mode mock`: serve os PDFs de teste (MARGEM_FIXTURES) em /__fixtures__/. */
function mockFixtures(mode) {
  const dir = path.resolve(process.env.MARGEM_FIXTURES || '/tmp/margem-fixtures')
  return {
    name: 'margem-mock-fixtures',
    apply: 'serve',
    configureServer(server) {
      if (mode !== 'mock') return
      server.middlewares.use('/__fixtures__/', (req, res, next) => {
        const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
        const file = path.join(dir, name)
        if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return next()
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), pdfjsAssets(), mockFixtures(mode)],
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari15',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // O pdf.js (import dinâmico) já vira chunk próprio; aqui separamos o
        // resto para o primeiro carregamento ficar pequeno e cacheável.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (/node_modules\/(react-markdown|remark-|rehype-|mdast-|hast-|micromark|unified|vfile|unist-|decode-named|character-|property-information|space-separated|comma-separated|trim-lines|ccount|devlop|bail|trough|zwitch|longest-streak|markdown-table|is-plain|estree-util|html-url|style-to|inline-style|trim)/.test(id))
            return 'markdown'
          return undefined
        },
      },
    },
  },
  test: {
    include: ['src/**/*.test.{js,jsx}'],
    environment: 'node',
    css: false,
  },
}))
