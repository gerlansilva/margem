import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, convertFileSrc, errorText } from '../api'
import { friendlyPdfError, loadPdf, matchingBlocks } from '../pdf'
import { Icon } from './Icons'
import { Modal } from './Modal'

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const MAX_PIXELS = 16_000_000
const NONE = []

/** Passo de zoom a partir do valor atual (que pode estar entre dois passos). */
export function stepZoom(zoom, direction) {
  if (direction > 0) return ZOOMS.find((z) => z > zoom + 0.001) ?? ZOOMS[ZOOMS.length - 1]
  return [...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? ZOOMS[0]
}

export function SourceModal({ source, onClose, onGoToReader }) {
  const { doc, quote, evidenceId } = source
  const [pageNum, setPageNum] = useState(source.page)
  const [numPages, setNumPages] = useState(doc.page_count || 0)
  const [zoom, setZoom] = useState(1.3)
  const [fit, setFit] = useState(false)
  const [rotation, setRotation] = useState(0)
  const [dims, setDims] = useState(null)
  const [loading, setLoading] = useState(true)
  const [evidence, setEvidence] = useState(null)
  const [evState, setEvState] = useState('loading') // loading | found | none
  const [blocks, setBlocks] = useState([])
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const holderRef = useRef(null)
  const scrollRef = useRef(null)

  const onSourcePage = pageNum === source.page
  const activeQuote = onSourcePage ? quote : ''

  // Evidência: id salvo pela IA/fichamento ou resolvida agora a partir da citação.
  useEffect(() => {
    let dead = false
    setEvidence(null)
    if (!onSourcePage || (!evidenceId && !quote)) {
      setEvState('none')
      return undefined
    }
    setEvState('loading')
    ;(async () => {
      try {
        let found = null
        if (evidenceId) found = await api.getEvidence(evidenceId)
        if (!found && quote) found = await api.resolveEvidence(doc.id, pageNum, quote)
        if (dead) return
        setEvidence(found || null)
        setEvState(found ? 'found' : 'none')
      } catch {
        if (!dead) setEvState('none')
      }
    })()
    return () => {
      dead = true
    }
  }, [doc.id, pageNum, quote, evidenceId, onSourcePage])

  // Reserva: destaque por bloco, só quando a evidência não foi localizada.
  useEffect(() => {
    let dead = false
    setBlocks([])
    if (evState !== 'none' || !activeQuote) return undefined
    api
      .getDoc(doc.id)
      .then((data) => {
        if (!dead) setBlocks(data.pages.find((p) => p.n === pageNum)?.blocks || [])
      })
      .catch(() => {})
    return () => {
      dead = true
    }
  }, [doc.id, pageNum, evState, activeQuote])

  useEffect(() => {
    let dead = false
    let task = null
    setLoading(true)
    setError('')
    ;(async () => {
      try {
        const pdf = await loadPdf(convertFileSrc(doc.path))
        if (dead) return
        setNumPages(pdf.numPages)
        const target = Math.min(Math.max(1, pageNum), pdf.numPages)
        if (target !== pageNum) {
          setPageNum(target)
          return
        }
        const pdfPage = await pdf.getPage(target)
        if (dead) return
        const turn = (pdfPage.rotate + rotation) % 360
        let scale = zoom
        if (fit) {
          const box = scrollRef.current
          const base = pdfPage.getViewport({ scale: 1, rotation: turn })
          scale = Math.min(3, Math.max(0.3, ((box?.clientWidth || 800) - 48) / base.width))
        }
        const viewport = pdfPage.getViewport({ scale, rotation: turn })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const ratio = Math.min(dpr, Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)))
        // Cada renderização usa um canvas novo: duas ao mesmo tempo no mesmo
        // canvas fazem o pdf.js lançar "Cannot use the same canvas…".
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', `Página ${target} de ${doc.name}`)
        const ctx = canvas.getContext('2d')
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
        task = pdfPage.render({ canvasContext: ctx, viewport })
        await task.promise
        if (dead) return
        holderRef.current?.replaceChildren(canvas)
        setDims({ w: viewport.width, h: viewport.height, viewport, scale })
        setLoading(false)
      } catch (err) {
        if (dead || err?.name === 'RenderingCancelledException') return
        setError(friendlyPdfError(err) || errorText(err))
        setLoading(false)
      }
    })()
    return () => {
      dead = true
      task?.cancel()
    }
  }, [doc.path, doc.name, pageNum, zoom, fit, rotation, retry])

  const rects = useMemo(() => (onSourcePage && evidence?.rects) || NONE, [evidence, onSourcePage])
  const legacy = useMemo(
    () => (onSourcePage && activeQuote && !evidence ? matchingBlocks(blocks, activeQuote) : NONE),
    [onSourcePage, activeQuote, evidence, blocks],
  )
  const boxes = useMemo(
    () => (dims ? rects.map((rect) => convert(rect, dims.viewport)) : []),
    [dims, rects],
  )

  // Centraliza o primeiro destaque assim que a página e a evidência estiverem prontas.
  useEffect(() => {
    const box = scrollRef.current
    if (!dims || !box || !boxes.length) return
    const top = Math.min(...boxes.map((b) => b.top))
    box.scrollTo({ top: Math.max(0, top - box.clientHeight / 2), behavior: 'smooth' })
  }, [dims, boxes])

  const goTo = useCallback(
    (next) => {
      if (!numPages) return
      setPageNum(Math.min(Math.max(1, next), numPages))
    },
    [numPages],
  )

  useEffect(() => {
    const onKey = (event) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)) return
      if (event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === 'ArrowRight' || event.key === 'PageDown') goTo(pageNum + 1)
      else if (event.key === 'ArrowLeft' || event.key === 'PageUp') goTo(pageNum - 1)
      else if (event.key === '+' || event.key === '=') {
        setFit(false)
        setZoom((z) => stepZoom(dims?.scale ?? z, 1))
      } else if (event.key === '-') {
        setFit(false)
        setZoom((z) => stepZoom(dims?.scale ?? z, -1))
      } else if (event.key === '0') setFit(true)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, pageNum, dims])

  const shownScale = dims?.scale ?? zoom

  return (
    <Modal onClose={onClose} labelledBy="source-title" className="source-modal">
      <header className="modal-head">
        <div>
          <h3 id="source-title">{doc.name}</h3>
          <p>
            Página {pageNum}
            {numPages ? ` de ${numPages}` : ''}
            {onSourcePage &&
              (evState === 'found'
                ? ' · trecho localizado'
                : quote && evState === 'none'
                  ? ' · trecho não localizado'
                  : '')}
          </p>
        </div>
        <div className="modal-actions">
          <div className="zoom-bar" role="group" aria-label="Página">
            <button className="icon-btn" onClick={() => goTo(pageNum - 1)} disabled={pageNum <= 1} aria-label="Página anterior" title="Página anterior (←)">
              {Icon.chevronLeft({ className: 'ico' })}
            </button>
            <input
              className="page-input"
              type="number"
              min={1}
              max={numPages || undefined}
              value={pageNum}
              aria-label="Ir para a página"
              onChange={(event) => event.target.value && goTo(Number(event.target.value))}
            />
            <button className="icon-btn" onClick={() => goTo(pageNum + 1)} disabled={numPages > 0 && pageNum >= numPages} aria-label="Próxima página" title="Próxima página (→)">
              {Icon.chevronRight({ className: 'ico' })}
            </button>
          </div>
          <div className="zoom-bar" role="group" aria-label="Zoom">
            <button
              className="icon-btn"
              onClick={() => {
                setFit(false)
                setZoom(stepZoom(shownScale, -1))
              }}
              aria-label="Diminuir zoom"
              title="Diminuir zoom (−)"
            >
              −
            </button>
            <span aria-live="polite">{Math.round(shownScale * 100)}%</span>
            <button
              className="icon-btn"
              onClick={() => {
                setFit(false)
                setZoom(stepZoom(shownScale, 1))
              }}
              aria-label="Aumentar zoom"
              title="Aumentar zoom (+)"
            >
              +
            </button>
            <button className={`icon-btn ${fit ? 'on' : ''}`} onClick={() => setFit(true)} aria-label="Ajustar à largura" aria-pressed={fit} title="Ajustar à largura (0)">
              ⤢
            </button>
            <button className="icon-btn" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Girar página" title="Girar página">
              ⟳
            </button>
          </div>
          {onGoToReader && (
            <button className="btn ghost" onClick={() => onGoToReader(doc, pageNum)} title="Ir para esta página na leitura">
              {Icon.book({ className: 'ico' })} Ver na leitura
            </button>
          )}
          {quote && (
            <button
              className="btn ghost"
              onClick={() => navigator.clipboard?.writeText(quote).catch(() => {})}
              title="Copiar o trecho"
            >
              {Icon.copy({ className: 'ico' })} Copiar trecho
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Fechar" title="Fechar (Esc)">
            {Icon.close({ className: 'ico' })}
          </button>
        </div>
      </header>

      {onSourcePage && (evidence || quote) && (
        <blockquote className="source-quote">
          {evidence?.text || quote}
          {quote && evState === 'none' && (
            <span className="quote-warn">Trecho não localizado na camada de texto.</span>
          )}
        </blockquote>
      )}

      <div className="pdf-scroll" ref={scrollRef}>
        {error ? (
          <div className="pdf-error" role="alert">
            <p className="msg-error">Não foi possível renderizar o PDF: {error}</p>
            <button className="btn" onClick={() => setRetry((n) => n + 1)}>
              Tentar de novo
            </button>
          </div>
        ) : (
          <div
            className={`pdf-page ${loading ? 'loading' : ''}`}
            style={dims ? { width: dims.w, height: dims.h } : { width: 600, height: 780 }}
            aria-busy={loading}
          >
            <div ref={holderRef} className="canvas-holder" />
            {loading && <div className="pdf-spinner" role="status">Renderizando…</div>}
            {dims &&
              boxes.map((box, index) => (
                <span key={`e${index}`} className="pdf-hl" data-evidence={evidence.id} style={box} />
              ))}
            {dims &&
              !rects.length &&
              legacy.map((block, index) => (
                <span
                  key={`l${index}`}
                  className="pdf-hl fallback"
                  style={{
                    left: block.x * dims.scale,
                    top: block.y * dims.scale,
                    width: block.w * dims.scale,
                    height: block.h * dims.scale,
                  }}
                />
              ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Retângulo do PDF (origem embaixo) → posição na página renderizada. */
export function convert([x0, y0, x1, y1], viewport) {
  // Usa a matriz do viewport (zoom, rotação e crop já aplicados) em vez de
  // viewport.convertToViewportRectangle, que nem toda versão do pdf.js expõe.
  const [a, b, c, d, e, f] = viewport.transform
  const xs = [x0, x1].flatMap((x) => [y0, y1].map((y) => a * x + c * y + e))
  const ys = [x0, x1].flatMap((x) => [y0, y1].map((y) => b * x + d * y + f))
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return {
    left,
    top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  }
}
