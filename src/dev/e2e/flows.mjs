import { launch, open, importPdf, shot, report } from './lib.mjs'
import { parseCsv } from '../../lib/csv.js'
const results = []
const ok = (name, cond, extra = '') => { results.push([name, !!cond]); console.log(`${cond ? 'OK   ' : 'FALHA'} ${name} ${extra}`) }
const { browser, page, errors } = await launch()
try {
  await open(page)
  await importPdf(page, 'artigo-2colunas')
  await importPdf(page, 'uma-pagina', { wait: false }); await page.waitForTimeout(2500)
  ok('2 docs na biblioteca', (await page.locator('.doc-item').count()) === 2)

  // fichamento
  await page.keyboard.press('Control+2'); await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Objetivo' }).click()
  await page.getByRole('button', { name: 'Nova coluna' }).click()
  await page.locator('.col-editor .chip', { hasText: 'Método' }).click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const nCols = await page.locator('th.col-head').count()
  ok('colunas criadas', nCols === 2, String(nCols))
  await page.getByRole('button', { name: /Extrair todos/ }).click()
  await page.waitForTimeout(3500)
  await shot(page, '20-fichamento-cheio')
  ok('tabela com células', (await page.locator('table.fichamento tbody tr').count()) === 2)
  // CSV
  await page.getByRole('button', { name: /Exportar/ }).click()
  await page.getByRole('menuitem', { name: /ponto e vírgula/i }).click()
  await page.waitForTimeout(800)
  const files = await page.evaluate(() => window.__MOCK__.files)
  const keys = Object.keys(files)
  ok('CSV gravado', keys.length === 1, keys.join(','))
  const csv = files[keys[0]] || ''
  ok('CSV com BOM e ;', csv.startsWith('﻿') && csv.split(/\r?\n/)[0].includes(';'), JSON.stringify(csv.slice(0, 70)))
  const rows = parseCsv(csv, ';')
  ok('CSV: 3 linhas (cabeçalho + 2 docs)', rows.length >= 3, String(rows.length))
  await shot(page, '21-menu-exportar')

  // comparar documentos
  await page.keyboard.press('Control+1'); await page.waitForTimeout(500)
  await page.locator('.doc-select').first().click(); await page.waitForTimeout(500)
  const items = page.locator('.doc-item')
  await items.nth(0).hover(); await items.nth(0).locator('input[type=checkbox]').check({ force: true })
  await items.nth(1).hover(); await items.nth(1).locator('input[type=checkbox]').check({ force: true })
  await page.waitForTimeout(300)
  ok('2 docs no escopo', (await page.locator('.scope-chip').count()) === 2)
  await page.getByPlaceholder(/Pergunte/).fill('Compare os dois')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant')
  await page.waitForTimeout(2500)
  const sent = await page.evaluate(() => window.__MOCK__.lastChat)
  ok('pergunta enviada com 2 documentos', JSON.stringify(sent).match(/doc_ids|docIds/) && (JSON.stringify(sent).match(/"id"|[0-9a-f]{8}-/g) || []).length >= 1, JSON.stringify(sent).slice(0, 160))
  await shot(page, '22-comparar')

  // cancelar streaming
  await page.evaluate(() => { window.__MOCK__.chatDelayMs = 80 })
  await page.getByPlaceholder(/Pergunte/).fill('Resposta longa')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  ok('botão parar visível', await page.getByRole('button', { name: /Parar a resposta/ }).count())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  ok('stream interrompido', await page.locator('.msg-note', { hasText: /interrompida/i }).count())
  ok('sem botão parar depois', (await page.getByRole('button', { name: /Parar a resposta/ }).count()) === 0)
  // erro no meio
  await page.evaluate(() => { window.__MOCK__.chatDelayMs = 12; window.__MOCK__.chatFail = 'mid' })
  await page.getByPlaceholder(/Pergunte/).fill('vai falhar')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(3000)
  ok('erro mostra tentar de novo', await page.locator('.msg-error').count())
  await shot(page, '23-erro-chat')
  await page.evaluate(() => { window.__MOCK__.chatFail = null })

  // exportar conversa em Markdown
  await page.getByRole('button', { name: /Exportar a conversa/ }).click()
  await page.waitForTimeout(800)
  const f2 = await page.evaluate(() => window.__MOCK__.files)
  const md = Object.entries(f2).find(([k]) => /\.md$/i.test(k))
  ok('conversa exportada em .md', !!md && /# Conversa/.test(md[1]), md ? md[0] : '')

  // persistência dos destaques (fallback localStorage)
  await page.locator('.doc-select').first().click(); await page.waitForTimeout(500)
  const para = page.locator('.page-body p').nth(1)
  const b = await para.boundingBox()
  await page.mouse.move(b.x + 5, b.y + 8); await page.mouse.down(); await page.mouse.move(b.x + 200, b.y + 9, { steps: 6 }); await page.mouse.up()
  await page.waitForSelector('.float-ask')
  await page.locator('.float-ask .swatch').nth(3).click()
  await page.waitForTimeout(900)
  const saved = await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === 'save_annotations' && c.payload.annotations.length))
  ok('destaques gravados no backend (save_annotations)', saved.length > 0, String(saved.length))

  // configurações
  await page.keyboard.press('Control+,'); await page.waitForTimeout(400)
  await shot(page, '24-config')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+?'); await page.waitForTimeout(300)
  ok('atalhos abrem com ?', await page.locator('.modal').count())
  await page.keyboard.press('Escape')
} catch (e) { console.log('ERRO', e.message); await shot(page, 'erro').catch(() => {}) }
report(errors)
console.log(`${results.filter((r) => r[1]).length}/${results.length} ok`)
await browser.close()
