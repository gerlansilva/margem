import { useEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import { Icon } from './Icons'
import { convertFileSrc } from '../api'

export function Reader({ data, onAsk, onSource, onReprocess }) {
  const [float, setFloat] = useState(null)
  const readerRef = useRef(null)

  useEffect(() => {
    const hide = () => setFloat(null)
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [])

  useEffect(() => {
    const target = Number(import.meta.env.VITE_READ_PAGE)
    if (!import.meta.env.DEV || !target) return
    const timer = setTimeout(() => {
      const section = readerRef.current?.querySelector(`[data-page="${target}"]`)
      section?.scrollIntoView({ block: 'start' })
    }, 350)
    return () => clearTimeout(timer)
  }, [data?.doc?.id])

  if (!data) {
    return (
      <div className="empty">
        <div className="empty-art">{Icon.book({ className: 'ico big' })}</div>
        <h2>Abra um PDF para começar</h2>
        <p>
          O texto é convertido em uma página de leitura com âncoras por página. Selecione um trecho para
          perguntar, ou use o painel ao lado.
        </p>
      </div>
    )
  }

  const { doc, pages } = data

  function onMouseUp() {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return setFloat(null)
    const text = selection.toString().trim()
    if (text.length < 8) return setFloat(null)
    const node = selection.anchorNode
    const section = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('[data-page]')
    if (!section) return setFloat(null)
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    setFloat({ text, page: Number(section.dataset.page), x: rect.left + rect.width / 2, y: rect.top })
  }

  return (
    <div className="reader" ref={readerRef} onMouseUp={onMouseUp}>
      <div className="doc-head">
        <h1>{doc.name}</h1>
        <span className="pill">{doc.page_count} páginas</span>
        <button className="btn tiny" onClick={onReprocess} title="Converter o texto novamente">
          Reprocessar
        </button>
      </div>

      {pages.map((page) => (
        <section className="page" id={`page-${page.n}`} data-page={page.n} key={page.n}>
          <div className="page-gutter">{page.n}</div>
          <Markdown>{page.md}</Markdown>
          {page.figures?.length > 0 && (
            <div className="page-figures">
              {page.figures.map((figure) => (
                <button
                  key={figure.index}
                  className="figure"
                  title={`Ver a página ${page.n} no PDF`}
                  onClick={() => onSource({ doc, page: page.n, blocks: page.blocks })}
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
          <button className="page-pdf" onClick={() => onSource({ doc, page: page.n, blocks: page.blocks })}>
            Ver esta página no PDF
          </button>
        </section>
      ))}

      {float && (
        <div className="float-ask" style={{ left: float.x, top: Math.max(80, float.y - 46) }}>
          <button
            className="btn accent"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onAsk(float.text, float.page)
              window.getSelection()?.removeAllRanges()
              setFloat(null)
            }}
          >
            {Icon.quote({ className: 'ico' })}
            Perguntar sobre o trecho
          </button>
        </div>
      )}
    </div>
  )
}
