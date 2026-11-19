import fs from 'node:fs'
import { launch, open, importPdf, shot, report } from './lib.mjs'
const results = []
const ok = (name, cond, extra = '') => { results.push([name, !!cond]); console.log(`${cond ? 'OK   ' : 'FALHA'} ${name} ${extra}`) }
const { browser, context, page, errors } = await launch({ dark: true })
try {
  await open(page)
  ok('tema escuro aplicado (auto)', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  // escaneado
  await importPdf(page, 'so-imagem', { wait: false })
  await page.waitForSelector('.toast', { timeout: 30000 })
  const t1 = await page.locator('.toast').innerText()
  ok('PDF escaneado avisa', /escaneado|selecion/i.test(t1), t1.replace(/\n/g, ' '))
  ok('PDF escaneado não fica na biblioteca', (await page.locator('.doc-item').count()) === 0)
  // corrompido
  await importPdf(page, 'corrompido', { wait: false })
  await page.waitForTimeout(2500)
  const t2 = await page.locator('.toast').innerText().catch(() => '')
  ok('corrompido mostra erro amigável', /corrompido|válido/i.test(t2), t2.replace(/\n/g, ' '))
  // senha
  await importPdf(page, 'com-senha', { wait: false })
  await page.waitForSelector('[role=dialog] input[type=password], .modal input[type=password]', { timeout: 15000 }).catch(() => {})
  ok('pede senha', await page.locator('input[type=password]').count())
  await shot(page, '10-senha')
  await page.locator('input[type=password]').fill('errada')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const wrong = await page.locator('.modal').innerText().catch(() => '')
  ok('senha errada pede de novo', /incorreta/i.test(wrong), wrong.slice(0, 80).replace(/\n/g, ' '))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  // grande 200p
  const t0 = Date.now()
  await importPdf(page, 'grande-200p', { wait: false })
  await page.waitForSelector('.reader .page', { timeout: 120000 })
  console.log('   200p importadas em', Date.now() - t0, 'ms')
  await page.waitForTimeout(800)
  const mounted = await page.locator('.reader .page:not(.placeholder)').count()
  const total = await page.locator('.reader .page').count()
  ok('200 páginas, montagem preguiçosa', total === 200 && mounted < 40, `${mounted}/${total} montadas`)
  // scroll longo sem travar
  const dt = await page.evaluate(async () => {
    const r = document.querySelector('.reader'); const t = performance.now()
    for (let i = 0; i < 30; i++) { r.scrollTop += 4000; await new Promise((x) => requestAnimationFrame(x)) }
    return performance.now() - t
  })
  ok('scroll em 200p fluido', dt < 4000, `${Math.round(dt)} ms p/ 30 saltos`)
  await shot(page, '11-200p-escuro')
  // exportação de notas (md) via download
  await importPdf(page, 'artigo-2colunas')
  await page.waitForTimeout(500)
  await page.keyboard.press('Control+2'); await page.waitForTimeout(400)
  await shot(page, '12-fichamento-escuro')
  const cols = await page.locator('table.fichamento th').count()
  console.log('   colunas th:', cols)
  // responsivo
  await page.keyboard.press('Control+1')
  await page.setViewportSize({ width: 720, height: 800 })
  await page.waitForTimeout(500)
  await shot(page, '13-estreito')
  await page.getByRole('button', { name: /Abrir o assistente/ }).click()
  await page.waitForTimeout(500)
  await shot(page, '14-estreito-chat')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Abrir a biblioteca/ }).click()
  await page.waitForTimeout(500)
  await shot(page, '15-estreito-nav')
} catch (e) { console.log('ERRO', e.message); await shot(page, 'erro').catch(() => {}) }
report(errors)
console.log(`${results.filter((r) => r[1]).length}/${results.length} ok`)
await browser.close()
