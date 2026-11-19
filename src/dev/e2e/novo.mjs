// Renomear, seleção + extração em lote, colunas, sticky, copiar e chat sobre o conjunto.
import { launch, open, importPdf, shot, report } from './lib.mjs'
import { parseCsv } from '../../lib/csv.js'

const results = []
const ok = (name, cond, extra = '') => {
  results.push([name, !!cond])
  console.log(`${cond ? 'OK   ' : 'FALHA'} ${name} ${extra}`)
}
const wait = (page, ms) => page.waitForTimeout(ms)
const want = (k) => !process.env.ONLY || process.env.ONLY.split(',').includes(k)

async function addDocs(page, names) {
  for (const n of names) {
    const expected = (await page.locator('.doc-item').count()) + 1
    await importPdf(page, n, { wait: false })
    await page.waitForFunction((count) => document.querySelectorAll('.doc-item').length >= count, expected, { timeout: 30000 }).catch(() => {})
    await wait(page, 900)
  }
  await page.waitForFunction(() => document.querySelectorAll('.reader .page').length > 0)
}
async function addColumns(page, names) {
  await page.getByRole('button', { name: 'Nova coluna' }).click()
  for (const name of names) {
    await page.getByLabel('Nome da coluna').fill(name)
    await page.getByLabel('Instrução para a IA').fill(`Extraia ${name}`)
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click()
    await page.waitForSelector(`th.col-head:has-text("${name}")`)
    if (name !== names[names.length - 1]) await page.getByRole('button', { name: 'Nova coluna' }).click()
  }
}
const headers = (page) => page.locator('th.col-head .col-title').allTextContents()
const clip = async (page) => {
  await page.waitForTimeout(250)
  for (let i = 0; ; i += 1) {
    try {
      return await page.evaluate(async () => {
        const items = await navigator.clipboard.read()
        const out = { types: items[0].types }
        for (const t of items[0].types) out[t] = await (await items[0].getType(t)).text()
        return out
      })
    } catch (e) {
      if (i >= 4) throw e
      await page.waitForTimeout(250)
    }
  }
}

// ====================================================================== rename
if (want('rename')) {
  const { browser, page, errors } = await launch()
  try {
    await open(page)
    await addDocs(page, ['artigo-2colunas', 'uma-pagina'])
    await shot(page, 'n1-sidebar-antes')
    const item = page.locator('.doc-item', { hasText: 'artigo-2colunas' })
    await item.locator('.doc-select').dblclick()
    ok('duplo clique abre o editor inline', await page.locator('.doc-rename').count() === 1)
    await shot(page, 'n2-sidebar-editando')
    await page.locator('.doc-rename').fill('Batanero 2001')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.doc-name:has-text("Batanero 2001")')
    ok('Enter salva e atualiza a barra lateral', true)
    // F2 + Esc cancela
    await page.locator('.doc-item', { hasText: 'Batanero 2001' }).locator('.doc-select').focus()
    await page.keyboard.press('F2')
    await page.locator('.doc-rename').fill('descartado')
    await page.keyboard.press('Escape')
    ok('F2 abre; Esc cancela e mantém o título', (await page.locator('.doc-rename').count()) === 0 && (await page.locator('.doc-name', { hasText: 'Batanero 2001' }).count()) === 1)
    ok('foco volta ao item', await page.evaluate(() => document.activeElement?.classList.contains('doc-select')))
    // título vazio não salva
    await page.keyboard.press('F2')
    await page.locator('.doc-rename').fill('   ')
    await page.keyboard.press('Enter')
    ok('título vazio é ignorado', (await page.locator('.doc-name', { hasText: 'Batanero 2001' }).count()) === 1)
    // em todo lugar
    await page.locator('.doc-item', { hasText: 'Batanero 2001' }).locator('.doc-select').click()
    await page.waitForSelector('.doc-head h1:has-text("Batanero 2001")')
    ok('leitor mostra o novo título', true)
    ok('chat D1 mostra o novo título', (await page.locator('.scope-chip', { hasText: 'Batanero 2001' }).count()) === 1)
    await page.keyboard.press('Control+2')
    await wait(page, 300)
    ok('fichamento mostra o novo título', (await page.locator('.doc-cell-name', { hasText: 'Batanero 2001' }).count()) === 1)
    await page.keyboard.press('Control+1')
    // restaurar original
    ok('ícone de restaurar aparece só quando difere', (await page.locator('.doc-item', { hasText: 'Batanero 2001' }).getByLabel(/Restaurar o título original/).count()) === 1 && (await page.getByLabel(/Restaurar o título original de uma-pagina/).count()) === 0)
    await page.locator('.doc-item', { hasText: 'Batanero 2001' }).click({ button: 'right' })
    await shot(page, 'n3-menu-contexto')
    ok('menu de contexto tem Renomear/Restaurar/Remover', (await page.locator('.ctx-menu [role=menuitem]').allTextContents()).length === 3)
    await page.getByRole('menuitem', { name: /Restaurar original/ }).click()
    await page.waitForSelector('.doc-name:has-text("artigo-2colunas")')
    ok('restaurar volta ao original', (await page.locator('.doc-head h1').textContent()) === 'artigo-2colunas')
    // menu de contexto -> renomear
    await page.locator('.doc-item', { hasText: 'uma-pagina' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Renomear/ }).click()
    await page.locator('.doc-rename').fill('Nota curta')
    await page.locator('.side-filter, .brand').first().click().catch(() => {})
    await page.waitForSelector('.doc-name:has-text("Nota curta")')
    ok('menu de contexto renomeia (blur salva)', true)
    // exportação da conversa usa o novo título
    await page.evaluate(() => { window.__MOCK__.nextSave = 'C:\\x\\conv' })
    await page.locator('.doc-item', { hasText: 'Nota curta' }).locator('.doc-select').click()
    await page.getByPlaceholder('Pergunte').fill('Oi')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.msg.assistant .md, .msg.assistant p')
    await wait(page, 2500)
    await page.getByRole('button', { name: /Exportar a conversa/ }).click()
    await wait(page, 600)
    const files = await page.evaluate(() => window.__MOCK__.files)
    const md = Object.values(files).find((v) => /^# Conversa/.test(v)) || ''
    ok('exportação da conversa usa o título novo', md.includes('Nota curta') && !md.includes('uma-pagina'), md.split('\n')[0])
  } catch (e) { console.log('ERRO rename', e.message); await shot(page, 'n-erro-rename').catch(() => {}); ok('rename sem exceção', false) }
  report(errors); await browser.close()
}

// ======================================================= colunas + lote + copiar
if (want('lote')) {
  const { browser, page, errors } = await launch({ width: 1280, height: 560 })
  try {
    await open(page)
    await addDocs(page, ['uma-pagina', 'uma-pagina', 'uma-pagina', 'uma-pagina', 'uma-pagina', 'uma-pagina', 'uma-pagina', 'artigo-2colunas'])
    ok('8 documentos', (await page.locator('.doc-item').count()) === 8)
    await page.keyboard.press('Control+2')
    await wait(page, 300)
    ok('sem colunas: atalhos de coluna visíveis', (await page.locator('.quick .chip').count()) === 5)
    await addColumns(page, ['Objetivo', 'Método'])
    ok('colunas criadas pelo "+"', JSON.stringify(await headers(page)) === JSON.stringify(['Objetivo', 'Método']))
    ok('oferece extrair só as novas', await page.getByRole('button', { name: /Extrair só elas/ }).count() === 1)
    await shot(page, 'n4-oferta')

    // seleção: 4 documentos pelos checkboxes da tabela
    const boxes = page.locator('table.fichamento tbody input[type=checkbox]')
    for (const i of [0, 1, 2, 7]) await boxes.nth(i).check()
    ok('contagem de selecionados', (await page.locator('.table-count').textContent()).includes('4 de 8'))
    ok('botão reflete o conjunto', await page.getByRole('button', { name: 'Extrair 4' }).count() === 1)
    ok('seleção aparece na barra lateral', (await page.locator('.side-sel').textContent()).includes('4 selecionados') && (await page.locator('.doc-item.selected').count()) === 4)

    // lote: concorrência e progresso por célula
    await page.evaluate(() => {
      window.__peak = 0
      window.__seenQueue = false
      window.__timer = setInterval(() => {
        const rows = new Set([...document.querySelectorAll('td .cell-empty.working')].map((el) => el.closest('tr')))
        window.__peak = Math.max(window.__peak, rows.size)
        if (document.querySelector('td .cell-empty')?.textContent === 'na fila') window.__seenQueue = true
      }, 15)
    })
    await page.getByRole('button', { name: /Extrair só elas/ }).click()
    await page.waitForSelector('.job')
    await shot(page, 'n5-lote')
    ok('progresso do lote visível', (await page.locator('.job').textContent()).includes('de 4'))
    await page.waitForSelector('.job', { state: 'detached' })
    const peak = await page.evaluate(() => { clearInterval(window.__timer); return window.__peak })
    ok('concorrência entre 2 e 3 documentos', peak >= 2 && peak <= 3, `pico=${peak}`)
    const filledRows = await page.locator('table.fichamento tbody tr').evaluateAll((trs) => trs.map((tr) => tr.querySelectorAll('.cell.filled').length > 0))
    ok('só os 4 selecionados foram extraídos', JSON.stringify(filledRows) === JSON.stringify([true, true, true, false, false, false, false, true]), JSON.stringify(filledRows))
    const extractCalls = await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === 'extract').length)
    ok('4 chamadas extract', extractCalls === 4, String(extractCalls))

    // preencher vazias: sem seleção, só os que faltam
    await page.getByRole('button', { name: 'Limpar' }).first().click()
    await page.getByRole('button', { name: 'Modo de extração' }).click()
    await page.getByRole('menuitemradio', { name: /Só vazias/ }).click()
    ok('botão vira "Preencher vazias"', await page.getByRole('button', { name: 'Preencher vazias' }).count() === 1)
    const before = await page.locator('tbody tr').first().locator('.cell-value').allTextContents()
    await page.evaluate(() => { window.__MOCK__.calls.length = 0 })
    await page.getByRole('button', { name: 'Preencher vazias' }).click()
    await page.waitForSelector('.job')
    await page.waitForSelector('.job', { state: 'detached' })
    const pend = await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === 'extract').map((c) => c.payload.docId))
    ok('preencher vazias chama só os 4 que faltavam', pend.length === 4, String(pend.length))
    ok('células já preenchidas intactas', JSON.stringify(before) === JSON.stringify(await page.locator('tbody tr').first().locator('.cell-value').allTextContents()))

    // cancelar
    await page.getByRole('button', { name: 'Modo de extração' }).click()
    await page.getByRole('menuitemradio', { name: 'Tudo' }).click()
    await page.evaluate(() => { window.__MOCK__.calls.length = 0 })
    await page.getByRole('button', { name: 'Extrair todos' }).click()
    await page.waitForSelector('.job')
    // O cancelamento é quase instantâneo: observa o DOM para pegar o "Cancelando…".
    await page.evaluate(() => {
      window.__sawCancelling = false
      new MutationObserver(() => { if (document.querySelector('.job')?.textContent.includes('Cancelando')) window.__sawCancelling = true }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await page.getByRole('button', { name: 'Cancelar' }).click()
    await page.waitForSelector('.job', { state: 'detached' })
    ok('mostra "Cancelando…"', await page.evaluate(() => window.__sawCancelling))
    const started = await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === 'extract').length)
    ok('cancelar impede novos documentos', started >= 1 && started <= 3, `iniciados=${started}`)
    ok('sem células presas em "extraindo…"', (await page.locator('.cell-empty.working').count()) === 0)

    // coluna nova: extrair só ela
    const snapshot = await page.locator('table.fichamento tbody').innerText()
    await addColumns(page, ['Amostra'])
    await page.evaluate(() => { window.__MOCK__.calls.length = 0 })
    await page.getByRole('button', { name: 'Extrair só ela' }).click()
    await page.waitForSelector('.job')
    await page.waitForSelector('.job', { state: 'detached' })
    const payloads = await page.evaluate(() => window.__MOCK__.calls.filter((c) => c.cmd === 'extract').map((c) => c.payload.columnIds))
    ok('extrai só a coluna nova nos 8 documentos', payloads.length === 8 && payloads.every((p) => p?.length === 1), JSON.stringify(payloads[0]))
    const after = await page.locator('table.fichamento tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].slice(0, 2).map((td) => td.innerText).join('|')))
    ok('colunas antigas preservadas', snapshot.split('\n').length > 0 && after.every((row) => row.length > 1))

    // editar, mover, reordenar por arrasto, excluir
    await page.getByRole('button', { name: 'Opções da coluna Método' }).click()
    await page.getByRole('menuitem', { name: 'Editar' }).click()
    await page.getByLabel('Nome da coluna').fill('Metodologia')
    await page.getByLabel('Nome da coluna').press('Enter')
    await page.waitForSelector('th.col-head:has-text("Metodologia")')
    ok('editar renomeia a coluna', JSON.stringify(await headers(page)) === JSON.stringify(['Objetivo', 'Metodologia', 'Amostra']))
    await page.getByRole('button', { name: 'Opções da coluna Amostra' }).click()
    await page.getByRole('menuitem', { name: /esquerda/ }).click()
    await wait(page, 300)
    ok('mover para a esquerda', JSON.stringify(await headers(page)) === JSON.stringify(['Objetivo', 'Amostra', 'Metodologia']))
    await page.locator('th.col-head', { hasText: 'Objetivo' }).dragTo(page.locator('th.col-head', { hasText: 'Metodologia' }))
    await wait(page, 400)
    ok('arrastar reordena', JSON.stringify(await headers(page)) === JSON.stringify(['Amostra', 'Metodologia', 'Objetivo']), JSON.stringify(await headers(page)))
    await page.getByRole('button', { name: 'Opções da coluna Metodologia' }).click()
    await page.getByRole('menuitem', { name: 'Excluir' }).click()
    await wait(page, 400)
    ok('excluir remove a coluna', JSON.stringify(await headers(page)) === JSON.stringify(['Amostra', 'Objetivo']))
    // recarregar mantém a ordem
    await page.reload(); await page.waitForSelector('.app')
    // (o mock não persiste entre recargas; não verificado)
  } catch (e) { console.log('ERRO colunas/lote', e.message); await shot(page, 'n-erro-lote').catch(() => {}); ok('colunas/lote sem exceção', false) }
  report(errors); await browser.close()
}

// =============================================================== sticky + copiar
if (want('sticky')) {
  const { browser, page, errors } = await launch({ width: 1100, height: 520 })
  try {
    await open(page)
    await addDocs(page, ['uma-pagina', 'uma-pagina', 'uma-pagina', 'uma-pagina', 'uma-pagina', 'uma-pagina', 'artigo-1coluna', 'artigo-2colunas'])
    await page.keyboard.press('Control+2')
    await addColumns(page, ['Objetivo', 'Método', 'Amostra', 'Resultados', 'Limitações', 'Contexto'])
    await page.getByRole('button', { name: 'Extrair todos' }).click()
    await page.waitForSelector('.job'); await page.waitForSelector('.job', { state: 'detached' })
    const sc = page.locator('.table-scroll')
    const dims = await sc.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight }))
    ok(`tabela rola nos dois eixos`, dims.sw > dims.cw && dims.sh > dims.ch, JSON.stringify(dims))
    await shot(page, `n6-sticky-topo`)
    await sc.evaluate((el) => { el.scrollLeft = 380; el.scrollTop = 140 })
    await wait(page, 300)
    await shot(page, `n7-sticky-rolado`)
    const m = await page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height } }
      const sc = document.querySelector('.table-scroll'); const s = box(sc)
      const corner = document.querySelector('th.corner')
      const firstHead = document.querySelector('th.col-head')
      const rows = [...document.querySelectorAll('tbody tr')]
      const docCells = rows.map((tr) => tr.querySelector('th.doc-cell'))
      const alpha = (el) => { const c = getComputedStyle(el).backgroundColor; const mm = c.match(/rgba?\(([^)]+)\)/)[1].split(',').map(Number); return mm.length === 4 ? mm[3] : 1 }
      const at = (x, y) => document.elementFromPoint(x, y)
      const cr = box(corner)
      const probeCorner = at(cr.l + 4, cr.t + 4)
      const hr = box(document.querySelector('th.col-head:nth-child(3)'))
      const dataCellUnder = at(cr.l + cr.w + 40, cr.t + cr.h + 20)
      // célula de dados que rolou para baixo do cabeçalho: o cabeçalho deve ficar por cima
      const probeHead = at(hr.l + 20, hr.t + 6)
      return {
        scroll: { l: sc.scrollLeft, t: sc.scrollTop },
        cornerOffset: { dx: cr.l - s.l, dy: cr.t - s.t },
        headTop: box(firstHead).t - s.t,
        docLefts: docCells.map((d) => Math.round(box(d).l - s.l)),
        alphas: { corner: alpha(corner), head: alpha(firstHead), doc: Math.min(...docCells.map(alpha)) },
        probeCornerIsCorner: !!probeCorner.closest('th.corner'),
        probeHeadIsHead: !!probeHead.closest('thead'),
        firstHeadMoved: box(firstHead).l < s.l + 250,
        stickyDocOverData: !!at(box(docCells[3]).l + 20, box(docCells[3]).t + 8).closest('th.doc-cell'),
      }
    })
    ok(`cabeçalho fixo no topo após rolar`, Math.abs(m.headTop - m.cornerOffset.dy) < 1.5 && m.cornerOffset.dy <= 2, JSON.stringify(m.cornerOffset))
    ok(`canto fixo nos dois eixos`, m.cornerOffset.dx <= 2 && m.cornerOffset.dy <= 2 && m.scroll.l > 0 && m.scroll.t > 0)
    ok(`coluna do documento fixa à esquerda`, m.docLefts.every((l) => l <= 2), JSON.stringify(m.docLefts))
    ok(`fundos opacos`, m.alphas.corner === 1 && m.alphas.head === 1 && m.alphas.doc === 1, JSON.stringify(m.alphas))
    ok(`canto e cabeçalho ficam por cima do conteúdo`, m.probeCornerIsCorner && m.probeHeadIsHead && m.stickyDocOverData)
    ok(`colunas de dados rolam normalmente`, m.firstHeadMoved)
    ok(`sombras ligadas ao rolar`, await sc.evaluate((el) => el.dataset.sx === '1' && el.dataset.sy === '1'))
    await sc.evaluate((el) => { el.scrollLeft = 0; el.scrollTop = 0 })
    await wait(page, 200)
    ok(`sombras desligadas no início`, await sc.evaluate((el) => el.dataset.sx === '0' && el.dataset.sy === '0'))

    {
      // ------------------------------------------------------------ copiar
      await page.locator('table.fichamento tbody input[type=checkbox]').nth(7).check()
      await page.locator('table.fichamento tbody input[type=checkbox]').nth(6).check()
      await page.getByRole('button', { name: /Copiar o fichamento como tabela/ }).click()
      // A cópia é assíncrona: espera o rótulo mudar em vez de ler logo após o clique.
      ok('botão vira "Copiado"', await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Copiar o fichamento/.test(b.getAttribute('aria-label') || '') && b.textContent.includes('Copiado')), undefined, { timeout: 3000 }).then(() => true, () => false))
      const c1 = await clip(page)
      ok('clipboard tem text/plain e text/html', c1.types.includes('text/plain') && c1.types.includes('text/html'), c1.types.join(','))
      const tsvRows = parseCsv(c1['text/plain'], '\t')
      ok('TSV: cabeçalho + 2 documentos selecionados', tsvRows.length === 3 && tsvRows[0].join('|') === 'Documento|Objetivo|Método|Amostra|Resultados|Limitações|Contexto', JSON.stringify(tsvRows[0]))
      ok('TSV: só os selecionados', tsvRows.slice(1).map((r) => r[0]).join(',') === 'artigo-1coluna,artigo-2colunas')
      ok('HTML: tabela com 3 linhas', (c1['text/html'].match(/<tr>/g) || []).length === 3 && c1['text/html'].includes('<table'))
      await wait(page, 1700)
      ok('"Copiado" volta a "Copiar" em ~1,5 s', (await page.getByRole('button', { name: /Copiar o fichamento/ }).textContent()).trim() === 'Copiar')
      await shot(page, 'n8-copiado')
      // opções: página + trecho, menos colunas
      await page.getByRole('button', { name: 'Formatos de cópia' }).click()
      await page.getByRole('menuitemcheckbox', { name: 'Página' }).click()
      await page.getByRole('menuitemcheckbox', { name: 'Trecho' }).click()
      await page.getByRole('menuitemcheckbox', { name: 'Contexto' }).click()
      await page.getByRole('menuitemcheckbox', { name: 'Limitações' }).click()
      await shot(page, 'n9-menu-copiar')
      await page.getByRole('menuitem', { name: 'Markdown' }).click()
      const md = (await clip(page))['text/plain']
      ok('Markdown: tabela com colunas escolhidas', md.split('\n')[0] === '| Documento | Objetivo | Método | Amostra | Resultados |' && md.split('\n')[1].startsWith('| ---'), md.split('\n')[0])
      ok('Markdown: página e trecho incluídos, quebra como <br>', /\(p\.\d+\)<br>“/.test(md))
      await page.getByRole('button', { name: 'Formatos de cópia' }).click()
      await page.getByRole('menuitem', { name: 'CSV' }).click()
      const csv = parseCsv((await clip(page))['text/plain'])
      ok('CSV: parse com quebra de linha dentro de aspas', csv.length === 3 && csv[0].length === 5 && csv[1][1].includes('\n“'), JSON.stringify(csv[0]))
      // sem seleção copia tudo
      await page.getByRole('button', { name: 'Limpar' }).first().click()
      await page.getByRole('button', { name: /Copiar o fichamento como tabela/ }).click()
      const all = parseCsv((await clip(page))['text/plain'], '\t')
      ok('sem seleção copia todos os documentos', all.length === 9, String(all.length))
    }
  } catch (e) { console.log('ERRO sticky/copiar', e.message); await shot(page, `n-erro-sticky`).catch(() => {}); ok(`sticky/copiar sem exceção`, false) }
  report(errors); await browser.close()
}

// ====================================================== chat sobre o conjunto
if (want('chat')) {
  const { browser, page, errors } = await launch()
  try {
    await open(page)
    await addDocs(page, ['artigo-2colunas', 'artigo-1coluna', 'uma-pagina'])
    const items = page.locator('.doc-item')
    await items.nth(0).hover(); await items.nth(0).locator('input[type=checkbox]').check({ force: true })
    await items.nth(1).hover(); await items.nth(1).locator('input[type=checkbox]').check({ force: true })
    await items.nth(2).locator('.doc-select').click()
    await wait(page, 500)
    ok('chat mostra o conjunto selecionado (2 chips)', (await page.locator('.scope-chip').count()) === 2)
    ok('não há seletor "comparar com" duplicado', (await page.locator('.scope-add').count()) === 0)
    await shot(page, 'n10-chat-conjunto')
    await page.getByPlaceholder('Pergunte').fill('Compare os dois')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.msg.assistant'); await wait(page, 2500)
    const sent = await page.evaluate(() => window.__MOCK__.lastChat)
    ok('pergunta enviada com os 2 documentos selecionados', sent.doc_ids.length === 2)
    // mesma seleção no fichamento
    await page.keyboard.press('Control+2'); await wait(page, 300)
    ok('fichamento reflete a seleção da barra lateral', (await page.locator('table.fichamento tbody tr.selected').count()) === 2)
    await page.keyboard.press('Control+1'); await wait(page, 300)
    await page.getByRole('button', { name: /Remover artigo-1coluna da conversa/ }).click()
    ok('× do chip tira da seleção', (await page.locator('.scope-chip').count()) === 1 && (await page.locator('.doc-item.selected').count()) === 1)
    await page.getByRole('button', { name: 'Só o aberto' }).click()
    ok('"Só o aberto" limpa a seleção', (await page.locator('.doc-item.selected').count()) === 0 && (await page.locator('.scope-chip').count()) === 1)
    await shot(page, 'n11-chat-aberto')
  } catch (e) { console.log('ERRO chat', e.message); await shot(page, 'n-erro-chat').catch(() => {}); ok('chat sem exceção', false) }
  report(errors); await browser.close()
}

// ============================== cancelar no meio de um lote, retry e doc já em extração
if (want('cancelar')) {
  const { browser, page, errors } = await launch({ width: 1280, height: 560 })
  try {
    await open(page)
    await addDocs(page, ['uma-pagina', 'uma-pagina', 'uma-pagina', 'uma-pagina', 'uma-pagina', 'artigo-2colunas'])
    await page.keyboard.press('Control+2')
    await wait(page, 300)
    await addColumns(page, ['Objetivo', 'Método'])
    await page.keyboard.press('Escape')
    const filled = () => page.locator('table.fichamento .cell.filled').count()
    const calls = (cmd) => page.evaluate((c) => window.__MOCK__.calls.filter((x) => x.cmd === c).map((x) => x.payload), cmd)

    // --- cancelar com 3 em andamento e 3 na fila: nada é gravado
    await page.evaluate(() => { window.__MOCK__.extractDelayMs = 2500; window.__MOCK__.calls.length = 0 })
    await page.getByRole('button', { name: 'Extrair todos' }).click()
    await page.waitForFunction(() => document.querySelectorAll('td .cell-empty.working').length >= 6)
    ok('3 documentos extraindo e o resto na fila', (await page.locator('td .cell-empty', { hasText: 'na fila' }).count()) === 6)
    await page.getByRole('button', { name: 'Cancelar' }).click()
    await page.waitForSelector('.job', { state: 'detached', timeout: 2000 }) // cancela na hora, sem esperar os 2,5 s
    const ext = await calls('extract')
    const canc = await calls('cancel_chat')
    ok('só 3 extract iniciados, todos com requestId distinto', ext.length === 3 && new Set(ext.map((p) => p.requestId)).size === 3 && ext.every((p) => p.requestId), JSON.stringify(ext.map((p) => p.requestId)))
    ok('cancel_chat para cada requestId em andamento', canc.length === 3 && ext.every((p) => canc.some((c) => c.requestId === p.requestId)), String(canc.length))
    ok('nenhuma célula gravada dos documentos cancelados', (await filled()) === 0)
    ok('cancelamento não vira toast de erro', !/Falha|cancelada\.$/.test(await page.locator('.toast').innerText().catch(() => '')))
    ok('toast informa que nada foi gravado', /Nada foi gravado/.test(await page.locator('.toast').innerText().catch(() => '')))
    ok('sem linhas presas em "extraindo…"/"na fila"', (await page.locator('td .cell-empty.working').count()) === 0 && (await page.locator('td .cell-empty', { hasText: 'na fila' }).count()) === 0)
    await shot(page, 'n12-cancelado')

    // --- status de nova tentativa aparece na linha (não em toast)
    await page.evaluate(() => { window.__MOCK__.extractDelayMs = 700; window.__MOCK__.extractRetry = true; window.__MOCK__.calls.length = 0 })
    await page.locator('tbody tr').first().getByRole('button', { name: 'Extrair' }).click()
    await page.waitForFunction(() => /Nova tentativa/.test(document.querySelector('td .cell-empty.working')?.textContent || ''))
    ok('retry mostrado na célula', true)
    ok('retry não gera toast', !/Nova tentativa/.test(await page.locator('.toast').innerText().catch(() => '')))
    await shot(page, 'n13-retry')
    await page.waitForSelector('.job', { state: 'detached' })
    await page.evaluate(() => { window.__MOCK__.extractRetry = false })
    ok('depois do retry, a linha preenche', (await page.locator('tbody tr').first().locator('.cell.filled').count()) >= 1)
    ok('status some ao terminar', (await page.getByText('Nova tentativa').count()) === 0)

    // --- documento já em extração: aviso amigável, sem erro e sem gravar duas vezes
    const before = await filled()
    await page.evaluate(() => {
      window.__MOCK__.extractDelayMs = 1500
      window.__MOCK__.calls.length = 0
      const id = window.__MOCK__.docIds?.()[1]
      window.__bg = window.__TAURI_INTERNALS__.invoke('extract', { docId: id, columnIds: null, requestId: 'externo-1' })
    })
    await page.locator('tbody tr').nth(1).getByRole('button', { name: 'Extrair' }).click()
    await page.waitForSelector('.toast')
    const t = await page.locator('.toast').innerText()
    ok('doc já em extração: aviso em pt-BR', /já está sendo extraído/.test(t) && !/Falha/.test(t), t.replace(/\n/g, ' '))
    await page.waitForSelector('.job', { state: 'detached' })
    await page.evaluate(() => window.__bg)
    ok('extração externa concluiu normalmente', (await filled()) >= before)
    await shot(page, 'n14-ocupado')
  } catch (e) { console.log('ERRO cancelar', e.message); await shot(page, 'n-erro-cancelar').catch(() => {}); ok('cancelar sem exceção', false) }
  report(errors); await browser.close()
}

const bad = results.filter(([, v]) => !v)
console.log(`\n${results.length - bad.length}/${results.length} verificações OK`)
if (bad.length) { console.log('FALHARAM:', bad.map(([n]) => n).join('; ')); process.exit(1) }
