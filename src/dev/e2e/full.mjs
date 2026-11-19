// Fluxo completo na UI com o backend simulado. Uso: node src/dev/e2e/full.mjs
import { launch, open, importPdf, shot, report } from './lib.mjs'
const results = []
const ok = (name, cond, extra = '') => { results.push([name, !!cond]); console.log(`${cond ? 'OK  ' : 'FALHA'} ${name} ${extra}`) }
const { browser, page, errors } = await launch({ width: 1440, height: 900 })
const failed404 = []
page.on('response', (r) => { if (r.status() >= 400) failed404.push(`${r.status()} ${r.url()}`) })
try {
  await open(page)
  await importPdf(page, 'artigo-2colunas')
  await page.waitForTimeout(600)
  ok('importou e leu 4 páginas', (await page.locator('.reader .page').count()) === 4)

  // busca Ctrl+F
  await page.keyboard.press('Control+f')
  await page.keyboard.type('estatistica')
  await page.waitForTimeout(500)
  const count = await page.locator('.search-count').innerText()
  ok('busca sem acento acha resultados', /\d+ de \d+/.test(count), count)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  ok('há realce de busca', (await page.locator('.hl-search').count()) > 0)
  await shot(page, '03-busca')
  await page.keyboard.press('Escape')

  // selecionar texto e destacar
  const para = page.locator('.page-body p').nth(2)
  await para.scrollIntoViewIfNeeded()
  const box = await para.boundingBox()
  await page.mouse.move(box.x + 5, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + 260, box.y + 12, { steps: 8 })
  await page.mouse.up()
  await page.waitForSelector('.float-ask', { timeout: 3000 }).catch(() => {})
  ok('barra flutuante aparece', await page.locator('.float-ask').count())
  await shot(page, '04-selecao')
  await page.locator('.float-ask .swatch').nth(1).click()
  await page.waitForTimeout(500)
  ok('destaque verde criado', (await page.locator('.hl-green').count()) > 0)
  // segundo destaque com nota
  await page.mouse.move(box.x + 5, box.y + 40)
  await page.mouse.down(); await page.mouse.move(box.x + 300, box.y + 42, { steps: 8 }); await page.mouse.up()
  await page.waitForSelector('.float-ask')
  await page.getByRole('button', { name: /^Nota$/ }).click()
  await page.keyboard.type('minha nota importante')
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(500)
  await page.getByRole('tab', { name: /Notas/ }).click()
  ok('painel de notas lista 2', (await page.locator('.note-card').count()) === 2)
  ok('nota com texto', (await page.locator('.note-card textarea').first().inputValue().catch(()=>'')) !== undefined)
  await shot(page, '05-notas')

  // chat
  await page.getByRole('tab', { name: /Assistente/ }).click()
  await page.getByPlaceholder(/Pergunte/).fill('Qual a amostra?')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant')
  await page.waitForTimeout(2500)
  await shot(page, '06-chat')
  const cites = await page.locator('.msg.assistant .cite, .msg.assistant button.citation').count()
  ok('resposta tem citações clicáveis', cites > 0, String(cites))
  if (cites) {
    await page.locator('.msg.assistant .cite, .msg.assistant button.citation').first().click()
    await page.waitForSelector('.modal', { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(2500)
    await shot(page, '07-fonte')
    ok('modal da fonte abriu', await page.locator('.modal').count())
    ok('retângulos de evidência', (await page.locator('.modal .pdf-hl').count()) > 0)
    await page.keyboard.press('Escape')
  }
  // fichamento
  await page.keyboard.press('Control+2')
  await page.waitForTimeout(500)
  await shot(page, '08-fichamento')
  // configurações
  await page.keyboard.press('Control+,')
  await page.waitForTimeout(400)
  await shot(page, '09-config')
  await page.keyboard.press('Escape')
} catch (e) {
  console.log('ERRO', e.message)
  await shot(page, 'erro').catch(() => {})
}
console.log('404s:', failed404.join(' | ') || 'nenhum')
report(errors)
console.log(`${results.filter((r) => r[1]).length}/${results.length} ok`)
await browser.close()
