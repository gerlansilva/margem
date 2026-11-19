// Utilidades dos testes de navegador (Playwright + Chrome do sistema).
import { chromium } from 'playwright-core'
import fs from 'node:fs'

export const URL = process.env.MARGEM_URL || 'http://localhost:1420/'
export const SHOTS = process.env.MARGEM_SHOTS || '/tmp/shots'
fs.mkdirSync(SHOTS, { recursive: true })

export async function launch({ width = 1440, height = 900, mac = false } = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  })
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: 'light',
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
    userAgent: mac
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      : undefined,
  })
  if (mac) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }))
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const errors = []
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) errors.push(`[${msg.type()}] ${msg.text()}`)
  })
  page.on('crash', () => { errors.push('[CRASH]'); console.log('[CRASH] renderer crashed') })
  browser.on('disconnected', () => console.log('[browser disconnected]'))
  if (process.env.E2E_VERBOSE) page.on('console', (m) => console.log('  >', m.type(), m.text().slice(0, 200)))
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`))
  return { browser, context, page, errors }
}

export async function open(page) {
  await page.goto(URL)
  await page.waitForSelector('.app')
}

/** Importa um PDF de teste pelo botão "Adicionar PDF" e espera a conversão. */
export async function importPdf(page, name, { wait = true } = {}) {
  await page.evaluate((n) => (window.__MOCK__.nextFile = `/__fixtures__/${n}.pdf`), name)
  await page.getByRole('button', { name: /Adicionar PDF/ }).click()
  if (wait) await page.waitForSelector('.reader .page', { timeout: 120000 })
}

export async function shot(page, name) {
  const file = `${SHOTS}/${name}.png`
  await page.screenshot({ path: file })
  return file
}

export function report(errors) {
  const uniq = [...new Set(errors)]
  console.log(uniq.length ? `CONSOLE (${uniq.length}):\n  ${uniq.join('\n  ')}` : 'CONSOLE: sem erros')
  return uniq
}
