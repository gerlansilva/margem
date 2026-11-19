import { launch, open, importPdf, shot, report } from './lib.mjs'
const { browser, page, errors } = await launch()
try {
  await open(page); await importPdf(page, 'artigo-2colunas')
  await page.getByPlaceholder(/Pergunte/).fill('Qual a amostra e a tabela?')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(3000)
  const cites = page.locator('.msg.assistant .cite')
  const n = await cites.count()
  for (let i = 0; i < n; i++) console.log(i, await cites.nth(i).innerText())
  console.log(await page.locator('.msg.assistant').first().innerText())
  for (const i of [0, 1, 2]) {
    if (i >= n) break
    await cites.nth(i).click()
    await page.waitForSelector('.pdf-hl, .pdf-error', { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1500)
    console.log('cite', i, 'pagina', await page.locator('.modal-head p').innerText(), 'hl', await page.locator('.pdf-hl').count(), await page.locator('.source-quote').count())
    await shot(page, `cite-${i}`)
    await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  }
} catch (e) { console.log('ERRO', e.message) }
report(errors); await browser.close()
