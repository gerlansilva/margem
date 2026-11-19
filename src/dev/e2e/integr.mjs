// Contratos novos do backend na UI: status, citações inválidas, truncado, chave, anotações, exportações.
import { launch, open, importPdf, shot, report } from './lib.mjs'
const results = []
const ok = (name, cond, extra = '') => { results.push([name, !!cond]); console.log(`${cond ? 'OK   ' : 'FALHA'} ${name} ${extra}`) }
const { browser, page, errors } = await launch()
const ask = async (q) => {
  await page.getByPlaceholder(/Pergunte/).fill(q)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.assistant')
}
try {
  await open(page)
  await importPdf(page, 'artigo-2colunas')
  await page.waitForTimeout(500)

  // status de nova tentativa
  await page.evaluate(() => { window.__MOCK__.chatRetry = true; window.__MOCK__.chatRetryMs = 1500 })
  await ask('pergunta com retentativa')
  await page.waitForSelector('[data-testid=chat-status]', { timeout: 5000 }).catch(() => {})
  const status = await page.locator('[data-testid=chat-status]').innerText().catch(() => '')
  ok('mostra "Nova tentativa em 2 s…"', /Nova tentativa em 2 s/.test(status), status)
  await shot(page, '30-status')
  await page.waitForTimeout(3500)
  ok('status some quando o texto chega', (await page.locator('[data-testid=chat-status]').count()) === 0)
  await page.evaluate(() => { window.__MOCK__.chatRetry = false })

  // citação inválida
  await page.evaluate(() => { window.__MOCK__.chatInvalidCite = true })
  await ask('com citação inventada')
  await page.waitForTimeout(3000)
  ok('citação inválida tracejada', (await page.locator('.cite.invalid').count()) >= 1)
  ok('citações válidas intactas', (await page.locator('.cite:not(.invalid)').count()) >= 1)
  ok('aviso de citações não verificadas', await page.locator('[data-testid=invalid-cite-note]').count())
  await shot(page, '31-citacao-invalida')
  await page.evaluate(() => { window.__MOCK__.chatInvalidCite = false })

  // truncado
  await page.evaluate(() => { window.__MOCK__.chatTruncate = true })
  await ask('resposta truncada')
  await page.waitForTimeout(3000)
  ok('aviso de resposta truncada', await page.locator('[data-testid=truncated-note]').count())
  ok('aviso do texto não duplicado', (await page.locator('.msg.assistant .md', { hasText: /limite de tamanho do modelo/ }).count()) === 0)
  await shot(page, '32-truncado')
  await page.evaluate(() => { window.__MOCK__.chatTruncate = false })

  // erro: só `error`, sem done
  await page.evaluate(() => { window.__MOCK__.chatFail = 'start' })
  await ask('vai dar erro de chave')
  await page.waitForTimeout(1200)
  ok('erro fecha a bolha (sem done)', (await page.locator('.typing').count()) === 0 && (await page.locator('.msg-error').count()) >= 1)
  await page.evaluate(() => { window.__MOCK__.chatFail = null })

  // exportar notas (.md) via write_text_file
  const para = page.locator('.page-body p').nth(2)
  await para.scrollIntoViewIfNeeded()
  const b = await para.boundingBox()
  await page.mouse.move(b.x + 5, b.y + 10); await page.mouse.down(); await page.mouse.move(b.x + 250, b.y + 12, { steps: 6 }); await page.mouse.up()
  await page.waitForSelector('.float-ask')
  await page.locator('.float-ask .swatch').nth(0).click()
  await page.waitForTimeout(900)
  await page.getByRole('tab', { name: /Notas/ }).click()
  await page.getByRole('button', { name: /Exportar/ }).first().click()
  await page.waitForTimeout(800)
  const calls = await page.evaluate(() => window.__MOCK__.calls.map((c) => c.cmd))
  ok('notas exportadas por write_text_file', calls.includes('write_text_file'))
  ok('anotação salva no backend', calls.includes('save_annotations'))

  // configurações: chave no cofre + remover
  await page.keyboard.press('Control+,'); await page.waitForTimeout(400)
  const ks = await page.locator('[data-testid=key-status]').innerText()
  ok('mostra chave guardada no cofre', /Keychain|Credential Manager/.test(ks), ks)
  await shot(page, '33-config-cofre')
  await page.getByRole('button', { name: /Remover chave/ }).click()
  await page.waitForTimeout(600)
  const ks2 = await page.locator('[data-testid=key-status]').innerText()
  ok('após remover: nenhuma chave', /Sem chave/.test(ks2), ks2)
  ok('chamou clear_api_key', (await page.evaluate(() => window.__MOCK__.calls.some((c) => c.cmd === 'clear_api_key'))))
  await shot(page, '34-config-sem-chave')
  await page.keyboard.press('Escape')

} catch (e) { console.log('ERRO', e.message); await shot(page, 'erro').catch(() => {}) }
report(errors)
console.log(`${results.filter((r) => r[1]).length}/${results.length} ok`)
await browser.close()
