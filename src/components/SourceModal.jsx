import { useEffect, useRef, useState } from 'react'
import { api, convertFileSrc } from '../api'
import { loadPdf, matchingBlocks } from '../pdf'
import { Icon } from './Icons'

const ZOOMS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]

export function SourceModal({ source, onClose }) {
  const { doc, page, quote, evidenceId } = source
  const canvasRef = useRef(null)
  const scrollRef = useRef(null)
  const [zoom, setZoom] = useState(1.3)
  const [rotation, setRotation] = useState(0)
  const [dims, setDims] = useState(null)
  const [blocks, setBlocks] = useState([])
  const [evidence, setEvidence] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Evidência: id salvo pela IA/fichamento ou resolvida agora a partir da citação.
  useEffect(() => {
    let dead = false
    setEvidence(null)
    ;(async () => {
      try {
        if (evidenceId) {
          const found = await api.getEvidence(evidenceId)
          if (!dead && found) return setEvidence(found)
        }
        if (!quote) return
        const found = await api.resolveEvidence(doc.id, page, quote)
        if (!dead) setEvidence(found)
      } catch {
        /* sem evidência: cai no destaque por bloco */
      }
    })()
    return () => {
      dead = true
    }
  }, [doc.id, page, quote, evidenceId])

  useEffect(() => {
    let dead = false
    setBlocks([])
    api
      .getDoc(doc.id)
      .then((data) => {
        if (dead) return
        const found = data.pages.find((p) => p.n === page)
        setBlocks(found?.blocks || [])
      })
      .catch(() => {})
    return () => {
      dead = true
    }
  }, [doc.id, page])

  useEffect(() => {
    let dead = false
    setDims(null)
    setError('')
    ;(async () => {
      try {
        const pdf = await loadPdf(convertFileSrc(doc.path))
        const pdfPage = await pdf.getPage(page)
        const viewport = pdfPage.getViewport({ scale: zoom, rotation })
        const canvas = canvasRef.current
        if (!canvas || dead) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const ctx = canvas.getContext('2d')
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        await pdfPage.render({ canvasContext: ctx, viewport }).promise
        if (!dead) setDims({ w: viewport.width, h: viewport.height, viewport })
      } catch (err) {
        if (!dead) setError(String(err?.message || err))
      }
    })()
    return () => {
      dead = true
    }
  }, [doc.path, page, zoom, rotation])

  const legacy = quote && !evidence ? matchingBlocks(blocks, quote) : []
  const rects = evidence?.rects || []

  // Centraliza o primeiro destaque assim que a página termina de renderizar.
  useEffect(() => {
    const box = scrollRef.current
    if (!dims || !box) return
    const boxes = rects.map((rect) => convert(rect, dims.viewport))
    const top = boxes.length ? Math.min(...boxes.map((b) => b.top)) : 0
    if (!top) return
    box.scrollTo({ top: Math.max(0, top - box.clientHeight / 2), behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal source-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h3>{doc.name}</h3>
            <p>
              Página {page} do PDF
              {evidence ? ' · trecho localizado' : quote ? ' · trecho não localizado' : ''}
            </p>
          </div>
          <div className="modal-actions">
            <div className="zoom-bar" role="group" aria-label="Zoom">
              <button
                className="icon-btn"
                onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)] || 0.75)}
                title="Diminuir zoom"
              >
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                className="icon-btn"
                onClick={() =>
                  setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)] || 1.3)
                }
                title="Aumentar zoom"
              >
                +
              </button>
              <button
                className="icon-btn"
                onClick={() => setRotation((r) => (r + 90) % 360)}
                title="Girar página"
              >
                ⟳
              </button>
            </div>
            {quote && (
              <button
                className="btn ghost"
                onClick={() => navigator.clipboard?.writeText(quote)}
                title="Copiar o trecho"
              >
                {Icon.quote({ className: 'ico' })} Copiar trecho
              </button>
            )}
            <button className="icon-btn" onClick={onClose} title="Fechar">
              {Icon.close({ className: 'ico' })}
            </button>
          </div>
        </header>

        {(evidence || quote) && (
          <blockquote className="source-quote">
            {evidence?.text || quote}
            {quote && !evidence && (
              <span className="quote-warn">Trecho não localizado na camada de texto.</span>
            )}
          </blockquote>
        )}

        <div className="pdf-scroll" ref={scrollRef}>
          {error ? (
            <p className="msg-error">Não foi possível renderizar o PDF: {error}</p>
          ) : (
            <div className="pdf-page" style={dims ? { width: dims.w, height: dims.h } : undefined}>
              <canvas ref={canvasRef} />
              {dims &&
                rects.map((rect, index) => {
                  const box = convert(rect, dims.viewport)
                  return (
                    <span
                      key={`e${index}`}
                      className="pdf-hl"
                      data-evidence={evidence.id}
                      style={box}
                    />
                  )
                })}
              {dims &&
                !rects.length &&
                legacy.map((block, index) => (
                  <span
                    key={`l${index}`}
                    className="pdf-hl fallback"
                    style={{
                      left: block.x * zoom,
                      top: block.y * zoom,
                      width: block.w * zoom,
                      height: block.h * zoom,
                    }}
                  />
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Retângulo do PDF (origem embaixo) → posição na página renderizada. */
function convert([x0, y0, x1, y1], viewport) {
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
