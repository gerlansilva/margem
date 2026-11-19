import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const CITE = /^\[D(\d+)[,\s]+p\.?\s*(\d+)(?:\s*[-–]\s*\d+)?\]$/

function CitationText({ text, onCite }) {
  const parts = String(text).split(/(\[D\d+[,\s]+p\.?\s*\d+(?:\s*[-–]\s*\d+)?\])/g)
  return parts.map((part, index) => {
    const match = part.match(CITE)
    if (!match) return part
    const label = `D${match[1]} p.${match[2]}`
    return (
      <button
        key={`${label}-${index}`}
        className="cite"
        title="Abrir o trecho no PDF"
        onClick={() => onCite?.(Number(match[1]), Number(match[2]))}
      >
        {label}
      </button>
    )
  })
}

function withCitations(children, onCite) {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') return <CitationText text={child} onCite={onCite} />
    return child
  })
}

export function Markdown({ children, onCite }) {
  const components = onCite
    ? {
        p: ({ children }) => <p>{withCitations(children, onCite)}</p>,
        li: ({ children }) => <li>{withCitations(children, onCite)}</li>,
        td: ({ children }) => <td>{withCitations(children, onCite)}</td>,
      }
    : {}
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children || ''}
      </ReactMarkdown>
    </div>
  )
}
