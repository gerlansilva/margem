import { launch, open, importPdf, shot, report } from './lib.mjs'
const { browser, page, errors } = await launch()
try {
  await open(page)
  await shot(page, '01-vazio')
  await importPdf(page, 'artigo-2colunas')
  await page.waitForTimeout(800)
  await shot(page, '02-leitura')
  console.log('páginas:', await page.locator('.reader .page').count())
} catch (e) { console.log('ERRO', e.message); await shot(page, 'erro').catch(()=>{}) }
report(errors)
await browser.close()
