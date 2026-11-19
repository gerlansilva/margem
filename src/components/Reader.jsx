import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import { Icon } from './Icons'
import { convertFileSrc } from '../api'
import { COLORS } from '../lib/annotations'
import { makeAnchor, resolveAnchor, searchRanges } from '../lib/anchors'
import { searchPages } from '../lib/search'
import { hasMod, shortcut } from '../lib/platform'

/** Caixas que estão inteiramente dentro de outra saem (getClientRects repete). */
function dedupe(boxes) {
  return boxes.filter(
    (a, i) =>
      !boxes.some(
        (b, j) =>
          j !== i &&
          b.left <= a.left + 0.5 &&
          b.top <= a.top + 0.5 &&
          b.left + b.width >= a.left + a.width - 0.5 &&
          b.top + b.height >= a.top + a.height - 0.5 &&
          (b.width > a.width || b.height > a.height || j < i),
      ),
  )
}

function useSeen(ref, rootRef, force, margin = '1500px 0px') {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen || force) return undefined
    const el = ref.current
    if (!el) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return undefined
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { root: rootRef.current, rootMargin: margin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [seen, force, ref, rootRef, margin])
  return seen || force
}

const PageView = memo(function PageView({
  page,
  doc,
  anns,
  query,
  currentHit,
  hitNonce,
  forceMount,
  activeId,
  rootRef,
  getEstimate,
  onGrew,
  onSource,
}) {
  const sectionRef = useRef(null)
  const bodyRef = useRef(null)
  const visible = useSeen(sectionRef, rootRef, forceMount || page.n <= 2)
  const [layout, setLayout] = useState({ ann: [], hits: [] })
  const placeholderHeight = useRef(null)

  // Placeholder com a altura média das páginas já medidas; quando a página real
  // monta e muda de altura acima da tela, o Reader compensa o scroll.
  if (!visible && placeholderHeight.current == null) placeholderHeight.current = getEstimate()
  useLayoutEffect(() => {
    if (!visible || placeholderHeight.current == null) return
    const real = sectionRef.current.offsetHeight
    onGrew(sectionRef.current, real - placeholderHeight.current, real)
    placeholderHeight.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const measure = useCallback(() => {
    const section = sectionRef.current
    const root = bodyRef.current
    if (!section || !root) return
    const base = section.getBoundingClientRect()
    const toBoxes = (range) =>
      dedupe(
        Array.from(range.getClientRects())
          .filter((r) => r.width > 1 && r.height > 1)
          .map((r) => ({
            left: r.left - base.left,
            top: r.top - base.top,
            width: r.width,
            height: r.height,
          })),
      )
    const ann = anns.map((a) => {
      const range = a.anchor ? resolveAnchor(root, a.anchor) : null
      return { id: a.id, color: a.color, note: !!a.note, boxes: range ? toBoxes(range) : [] }
    })
    const hits = query ? searchRanges(root, query).map(toBoxes) : []
    setLayout({ ann, hits })
  }, [anns, query])

  useLayoutEffect(() => {
    if (visible && (anns.length || query)) measure()
    else setLayout((prev) => (prev.ann.length || prev.hits.length ? { ann: [], hits: [] } : prev))
  }, [visible, anns, query, page.md, measure])

  // Largura da janela/painéis muda a quebra de linha: remede.
  useEffect(() => {
    if (!visible || !(anns.length || query) || typeof ResizeObserver === 'undefined') return undefined
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    ro.observe(sectionRef.current)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [visible, anns.length, query, measure])

  // Leva o resultado da busca atual para o terço superior da tela.
  useEffect(() => {
    if (currentHit < 0 || !layout.hits[currentHit]?.length) return
    const box = layout.hits[currentHit][0]
    const container = rootRef.current
    const section = sectionRef.current
    if (!container || !section) return
    const top = section.getBoundingClientRect().top + box.top - container.getBoundingClientRect().top
    container.scrollTo({ top: container.scrollTop + top - container.clientHeight / 3, behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitNonce, currentHit, layout.hits.length])

  if (!visible) {
    return (
      <section
        className="page placeholder"
        id={`page-${page.n}`}
        data-page={page.n}
        ref={sectionRef}
        style={{ minHeight: placeholderHeight.current }}
      >
        <div className="page-gutter">{page.n}</div>
      </section>
    )
  }

  const empty = !page.md?.trim()
  return (
    <section
      className="page"
      id={`page-${page.n}`}
      data-page={page.n}
      ref={sectionRef}
      aria-label={`Página ${page.n}`}
    >
      <div className="hl-layer" aria-hidden="true">
        {layout.ann.map((a) =>
          a.boxes.map((box, i) => (
            <span
              key={`${a.id}-${i}`}
              className={`hl hl-${a.color}${a.id === activeId ? ' active' : ''}`}
              data-ann={a.id}
              style={box}
            />
          )),
        )}
        {layout.ann.map((a) => {
          const last = a.boxes[a.boxes.length - 1]
          return a.note && last ? (
            <span
              key={`pin-${a.id}`}
              className="hl-pin"
              style={{ left: last.left + last.width - 3, top: last.top - 5 }}
            />
          ) : null
        })}
        {layout.hits.map((boxes, hit) =>
          boxes.map((box, i) => (
            <span
              key={`s${hit}-${i}`}
              className={`hl-search${hit === currentHit ? ' current' : ''}`}
              style={box}
            />
          )),
        )}
      </div>
      <div className="page-gutter">{page.n}</div>
      <div ref={bodyRef} className="page-body">
        {empty ? (
          <p className="page-empty">
            Esta página não tem texto selecionável (pode ser uma imagem). Use “Ver esta página no PDF”.
          </p>
        ) : (
          <Markdown>{page.md}</Markdown>
        )}
      </div>
      {page.figures?.length > 0 && (
        <div className="page-figures">
          {page.figures.map((figure) => (
            <button
              key={figure.index}
              className="figure"
              title={`Ver a página ${page.n} no PDF`}
              onClick={() => onSource({ doc, page: page.n })}
            >
              <img
                src={convertFileSrc(figure.path)}
                alt={`Figura ou tabela da página ${page.n}`}
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}
      <button className="page-pdf" onClick={() => onSource({ doc, page: page.n })}>
        Ver esta página no PDF
      </button>
    </section>
  )
})

function sameList(a, b) {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

export function Reader({
  data,
  annotations,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onAsk,
  onSource,
  onReprocess,
  focusRequest,
}) {
  const readerRef = useRef(null)
  const searchInput = useRef(null)
  const heights = useRef({ sum: 0, n: 0 })
  const [toolbar, setToolbar] = useState(null)
  const [popover, setPopover] = useState(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const [hitNonce, setHitNonce] = useState(0)
  const deferred = useDeferredValue(query)

  const doc = data?.doc
  const pages = useMemo(() => data?.pages || [], [data])

  // Destaques agrupados por página, mantendo a identidade dos arrays que não mudaram.
  const prevByPage = useRef(new Map())
  const byPage = useMemo(() => {
    const next = new Map()
    for (const ann of annotations) {
      if (!next.has(ann.page)) next.set(ann.page, [])
      next.get(ann.page).push(ann)
    }
    for (const [page, list] of next) {
      const old = prevByPage.current.get(page)
      if (old && sameList(old, list)) next.set(page, old)
    }
    prevByPage.current = next
    return next
  }, [annotations])

  const search = useMemo(() => searchPages(pages, deferred), [pages, deferred])
  const total = search.total
  const safeHit = total ? Math.min(hit, total - 1) : 0
  const current = total ? search.results[safeHit] : null

  useEffect(() => {
    setHit(0)
  }, [deferred, doc?.id])

  useEffect(() => {
    setToolbar(null)
    setPopover(null)
    setSearchOpen(false)
    setQuery('')
  }, [doc?.id])

  const goHit = useCallback(
    (delta) => {
      if (!total) return
      setHit((h) => (Math.min(h, total - 1) + delta + total) % total)
      setHitNonce((n) => n + 1)
    },
    [total],
  )

  // Ctrl/Cmd+F, F3 e Ctrl/Cmd+G.
  useEffect(() => {
    if (!doc) return undefined
    const onKey = (event) => {
      const key = event.key.toLowerCase()
      if (hasMod(event) && key === 'f') {
        event.preventDefault()
        const selected = window.getSelection()?.toString().trim()
        setSearchOpen(true)
        if (selected && selected.length < 80 && !selected.includes('\n')) setQuery(selected)
        requestAnimationFrame(() => {
          searchInput.current?.focus()
          searchInput.current?.select()
        })
      } else if (searchOpen && (key === 'f3' || (hasMod(event) && key === 'g'))) {
        event.preventDefault()
        goHit(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doc, searchOpen, goHit])

  // Esconde o que flutua quando a leitura rola.
  useEffect(() => {
    const hide = (event) => {
      if (event.target?.closest?.('.ann-popover')) return
      setToolbar(null)
      setPopover(null)
    }
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [])

  // Pedido vindo do painel de notas / citações: ir até a página (e destaque).
  useEffect(() => {
    if (!focusRequest || !readerRef.current) return
    const section = readerRef.current.querySelector(`[data-page="${focusRequest.page}"]`)
    section?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    if (focusRequest.annId) setPopover(null)
  }, [focusRequest])

  const getEstimate = useCallback(() => {
    const { sum, n } = heights.current
    return n ? Math.round(sum / n) : 1000
  }, [])

  const onGrew = useCallback((el, delta, real) => {
    heights.current.sum += real
    heights.current.n += 1
    const box = readerRef.current
    if (!box || !delta) return
    // Página que cresce acima da tela empurra o resto: compensa para o texto
    // que está sendo lido não pular.
    if (el.getBoundingClientRect().top < box.getBoundingClientRect().top) box.scrollTop += delta
  }, [])

  function readSelection() {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
    const range = selection.getRangeAt(0)
    const startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
    const body = startEl?.closest?.('.page-body')
    const section = body?.closest('[data-page]')
    if (!body || !section || !readerRef.current?.contains(section)) return null
    const clipped = range.cloneRange()
    if (!body.contains(range.endContainer)) clipped.setEnd(body, body.childNodes.length)
    const text = clipped.toString().replace(/\s+/g, ' ').trim()
    if (text.length < 3) return null
    const rect = clipped.getBoundingClientRect()
    return {
      text,
      page: Number(section.dataset.page),
      anchor: makeAnchor(body, clipped),
      rect,
    }
  }

  function onPointerUp(event) {
    if (event.target.closest?.('.float-ask, .ann-popover, .search-bar')) return
    // Espera o navegador fechar a seleção (duplo clique, arrastar).
    requestAnimationFrame(() => {
      const found = readSelection()
      if (!found) {
        setToolbar(null)
        return
      }
      setPopover(null)
      const above = found.rect.top > 96
      setToolbar({
        ...found,
        x: Math.min(Math.max(found.rect.left + found.rect.width / 2, 150), window.innerWidth - 150),
        y: above ? found.rect.top - 8 : found.rect.bottom + 8,
        above,
      })
    })
  }

  function highlight(color, withNote) {
    if (!toolbar) return
    const ann = onCreateAnnotation({
      page: toolbar.page,
      color,
      text: toolbar.text,
      anchor: toolbar.anchor,
    })
    window.getSelection()?.removeAllRanges()
    const { rect, above } = toolbar
    setToolbar(null)
    if (withNote && ann) {
      setPopover({
        id: ann.id,
        x: Math.min(Math.max(rect.left + rect.width / 2, 170), window.innerWidth - 170),
        y: rect.bottom + 8,
        focusNote: true,
        above,
      })
    }
  }

  // Clique sobre um destaque abre a nota.
  function onReaderClick(event) {
    if (event.target.closest?.('button, a, .ann-popover, .float-ask')) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    const section = event.target.closest?.('[data-page]')
    if (!section) {
      setPopover(null)
      return
    }
    const base = section.getBoundingClientRect()
    const x = event.clientX - base.left
    const y = event.clientY - base.top
    const hitEl = [...section.querySelectorAll('.hl[data-ann]')].find((el) => {
      const left = el.offsetLeft
      const top = el.offsetTop
      return x >= left && x <= left + el.offsetWidth && y >= top && y <= top + el.offsetHeight
    })
    if (!hitEl) {
      setPopover(null)
      return
    }
    const rect = hitEl.getBoundingClientRect()
    setPopover({
      id: hitEl.dataset.ann,
      x: Math.min(Math.max(rect.left + rect.width / 2, 170), window.innerWidth - 170),
      y: rect.bottom + 8,
    })
  }

  if (!data) {
    return (
      <div className="empty">
        <div className="empty-art">{Icon.book({ className: 'ico big' })}</div>
        <h2>Abra um PDF para começar</h2>
        <p>
          O texto é convertido em uma página de leitura com âncoras por página. Selecione um trecho para
          perguntar ou destacar, ou use o painel ao lado. Você também pode arrastar um PDF para esta janela.
        </p>
        <p className="muted tip">Dica: {shortcut('O')} adiciona um PDF · {shortcut('F')} busca no texto.</p>
      </div>
    )
  }

  if (!pages.length) {
    return (
      <div className="empty">
        <div className="empty-art">{Icon.doc({ className: 'ico big' })}</div>
        <h2>{doc.name}</h2>
        <p>Este PDF ainda não foi convertido para leitura (a importação pode ter sido interrompida).</p>
        <button className="btn primary" style={{ marginTop: 16 }} onClick={onReprocess}>
          Converter agora
        </button>
      </div>
    )
  }

  const activeAnn = popover ? annotations.find((a) => a.id === popover.id) : null

  return (
    <div className="reader-wrap">
      {searchOpen && (
        <div className="search-bar" role="search">
          {Icon.search({ className: 'ico' })}
          <input
            ref={searchInput}
            type="search"
            aria-label="Buscar no documento"
            placeholder="Buscar no documento…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                goHit(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                event.stopPropagation()
                setSearchOpen(false)
                setQuery('')
              }
            }}
          />
          <span className="search-count" aria-live="polite">
            {query.trim().length < 2 ? '' : total ? `${safeHit + 1} de ${total}` : 'sem resultados'}
          </span>
          <button className="icon-btn subtle" onClick={() => goHit(-1)} disabled={!total} aria-label="Resultado anterior" title="Anterior (Shift+Enter)">
            {Icon.chevronUp({ className: 'ico' })}
          </button>
          <button className="icon-btn subtle" onClick={() => goHit(1)} disabled={!total} aria-label="Próximo resultado" title="Próximo (Enter)">
            {Icon.chevronDown({ className: 'ico' })}
          </button>
          <button
            className="icon-btn subtle"
            onClick={() => {
              setSearchOpen(false)
              setQuery('')
            }}
            aria-label="Fechar busca"
          >
            {Icon.close({ className: 'ico' })}
          </button>
        </div>
      )}

      <div
        className="reader"
        ref={readerRef}
        onMouseUp={onPointerUp}
        onKeyUp={(event) => {
          if (event.shiftKey || event.key.startsWith('Arrow')) onPointerUp(event)
        }}
        onClick={onReaderClick}
      >
        <div className="doc-head">
          <h1>{doc.name}</h1>
          <span className="pill">{doc.page_count} páginas</span>
          <button className="btn tiny" onClick={onReprocess} title="Converter o texto novamente">
            Reprocessar
          </button>
        </div>

        {pages.map((page) => (
          <PageView
            key={page.n}
            page={page}
            doc={doc}
            anns={byPage.get(page.n) || EMPTY}
            query={deferred.trim().length >= 2 ? deferred : ''}
            currentHit={current && current.page === page.n ? current.index : -1}
            hitNonce={hitNonce}
            forceMount={!!current && current.page === page.n}
            activeId={popover?.id}
            rootRef={readerRef}
            getEstimate={getEstimate}
            onGrew={onGrew}
            onSource={onSource}
          />
        ))}
      </div>

      {toolbar && (
        <div
          className={`float-ask ${toolbar.above ? '' : 'below'}`}
          style={{ left: toolbar.x, top: toolbar.y }}
          onMouseDown={(event) => event.preventDefault()}
          role="toolbar"
          aria-label="Ações para o trecho selecionado"
        >
          <button
            className="btn accent"
            onClick={() => {
              onAsk(toolbar.text, toolbar.page)
              window.getSelection()?.removeAllRanges()
              setToolbar(null)
            }}
          >
            {Icon.quote({ className: 'ico' })}
            Perguntar
          </button>
          <span className="float-sep" />
          {COLORS.map((color) => (
            <button
              key={color.id}
              className="swatch"
              style={{ '--c': color.hex }}
              title={`Destacar de ${color.name.toLowerCase()}`}
              aria-label={`Destacar de ${color.name.toLowerCase()}`}
              onClick={() => highlight(color.id, false)}
            />
          ))}
          <span className="float-sep" />
          <button className="btn accent" onClick={() => highlight('yellow', true)} title="Destacar e escrever uma nota">
            {Icon.note({ className: 'ico' })}
            Nota
          </button>
        </div>
      )}

      {popover && activeAnn && (
        <AnnotationPopover
          key={activeAnn.id}
          ann={activeAnn}
          x={popover.x}
          y={popover.y}
          focusNote={popover.focusNote}
          onChange={(patch) => onUpdateAnnotation(activeAnn.id, patch)}
          onDelete={() => {
            onDeleteAnnotation(activeAnn.id)
            setPopover(null)
          }}
          onAsk={() => {
            onAsk(activeAnn.text, activeAnn.page)
            setPopover(null)
          }}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  )
}

const EMPTY = []

function AnnotationPopover({ ann, x, y, focusNote, onChange, onDelete, onAsk, onClose }) {
  const [note, setNote] = useState(ann.note || '')
  const ref = useRef(null)
  const area = useRef(null)

  useEffect(() => {
    if (focusNote) area.current?.focus()
  }, [focusNote])

  useEffect(() => {
    const onDown = (event) => {
      if (!ref.current?.contains(event.target)) onClose()
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  // Posição: abaixo do destaque, sem sair da tela.
  const left = Math.min(Math.max(x - 160, 8), Math.max(8, window.innerWidth - 328))
  const top = Math.min(y, window.innerHeight - 250)

  return (
    <div
      ref={ref}
      className="ann-popover"
      style={{ left, top }}
      role="dialog"
      aria-label={`Destaque da página ${ann.page}`}
    >
      <blockquote className="ann-quote">{ann.text.length > 160 ? `${ann.text.slice(0, 160)}…` : ann.text}</blockquote>
      <div className="ann-colors" role="group" aria-label="Cor do destaque">
        {COLORS.map((color) => (
          <button
            key={color.id}
            className={`swatch ${ann.color === color.id ? 'on' : ''}`}
            style={{ '--c': color.hex }}
            aria-label={color.name}
            aria-pressed={ann.color === color.id}
            title={color.name}
            onClick={() => onChange({ color: color.id })}
          />
        ))}
      </div>
      <textarea
        ref={area}
        rows={3}
        placeholder="Escreva uma nota…"
        aria-label="Nota do destaque"
        value={note}
        onChange={(event) => {
          setNote(event.target.value)
          onChange({ note: event.target.value })
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && hasMod(event)) {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <div className="ann-actions">
        <button className="btn tiny" onClick={onAsk}>
          Perguntar
        </button>
        <button className="btn tiny danger" onClick={onDelete}>
          {Icon.trash({ className: 'ico' })} Excluir
        </button>
        <button className="btn tiny primary" onClick={onClose}>
          Pronto
        </button>
      </div>
    </div>
  )
}
