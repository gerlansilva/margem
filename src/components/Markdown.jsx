import React, { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { citationLabel, isInvalidRef, quoteBefore, splitCitations } from '../lib/citations'
import { openExternal } from '../lib/links'

const REMARK = [remarkGfm]

function CitationText({ text, onCite, citations }) {
  const parts = splitCitations(text)
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].value
  return parts.map((part, index) => {
    if (part.type === 'text') return part.value
    return (
      <React.Fragment key={`${part.index}-${index}`}>
        {part.refs.map((ref, i) => {
          const label = citationLabel(ref)
          const invalid = isInvalidRef(citations, ref)
          return (
            <button
              key={`${label}-${i}`}
              type="button"
              className={invalid ? 'cite invalid' : 'cite'}
              data-valid={invalid ? 'false' : 'true'}
              title={
                invalid
                  ? 'Citação não verificada: essa página não foi enviada ao modelo. Confira no PDF.'
                  : 'Abrir o trecho no PDF'
              }
              aria-label={invalid ? `Abrir ${label} no PDF (citação não verificada)` : `Abrir ${label} no PDF`}
              onClick={() => onCite?.(ref.doc, ref.page, quoteBefore(text, part.index))}
            >
              {label}
            </button>
          )
        })}
      </React.Fragment>
    )
  })
}

/** Aplica citações em qualquer profundidade (negrito, itálico, links…). */
function withCitations(children, onCite, citations) {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') return <CitationText text={child} onCite={onCite} citations={citations} />
    if (React.isValidElement(child) && child.props?.children && child.type !== 'code' && child.type !== 'pre') {
      // Não mexe em botões de citação já criados nem em blocos de código.
      return React.cloneElement(child, undefined, withCitations(child.props.children, onCite, citations))
    }
    return child
  })
}

function Link({ href, children, ...rest }) {
  return (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        // Dentro do app, um <a> normal navegaria a janela inteira para fora do Margem.
        event.preventDefault()
        if (href) openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

export const Markdown = memo(function Markdown({ children, onCite, citations }) {
  const components = { a: Link }
  if (onCite) {
    components.p = ({ children: c }) => <p>{withCitations(c, onCite, citations)}</p>
    components.li = ({ children: c }) => <li>{withCitations(c, onCite, citations)}</li>
    components.td = ({ children: c }) => <td>{withCitations(c, onCite, citations)}</td>
    components.th = ({ children: c }) => <th>{withCitations(c, onCite, citations)}</th>
    components.blockquote = ({ children: c }) => <blockquote>{withCitations(c, onCite, citations)}</blockquote>
    components.h1 = ({ children: c }) => <h1>{withCitations(c, onCite, citations)}</h1>
    components.h2 = ({ children: c }) => <h2>{withCitations(c, onCite, citations)}</h2>
    components.h3 = ({ children: c }) => <h3>{withCitations(c, onCite, citations)}</h3>
  }
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK} components={components}>
        {children || ''}
      </ReactMarkdown>
    </div>
  )
})
