import { useEffect, useMemo, useRef, useState } from 'react'
import { api, listen } from '../api'
import { Icon } from './Icons'
import { Markdown } from './Markdown'

const SUGGESTIONS = [
  'Resuma as contribuições principais do artigo.',
  'Qual é a metodologia e qual o tamanho da amostra?',
  'Quais são as limitações declaradas pelos autores?',
  'Que resultados numéricos o artigo reporta?',
]

let demoSent = false

function quoteBefore(content, docNumber, page) {
  const pattern = new RegExp(
    `"([^"]{20,300})"\\s*\\[D${docNumber}[,\\s]+p\\.?\\s*${page}\\]`,
  )
  const match = content.match(pattern)
  return match ? match[1] : ''
}

export function ChatPanel({
  docs,
  scopeIds,
  setScopeIds,
  currentId,
  hasKey,
  onOpenSettings,
  onSource,
  seed,
  onSeedClear,
}) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [active, setActive] = useState(null)
  const [selection, setSelection] = useState(null)
  const endRef = useRef(null)
  const inputRef = useRef(null)
  const scopeKey = scopeIds.join(',')

  const scopeDocs = useMemo(
    () => scopeIds.map((id) => docs.find((d) => d.id === id)).filter(Boolean),
    [scopeIds, docs],
  )

  useEffect(() => {
    setMessages([])
    setActive(null)
  }, [scopeKey])

  useEffect(() => {
    if (seed) setSelection({ text: seed.text, page: seed.page })
  }, [seed])

  useEffect(() => {
    const demo = import.meta.env.VITE_DEMO_QUESTION
    if (!demo || !import.meta.env.DEV || demoSent || !hasKey || !scopeIds.length) return
    const timer = setTimeout(() => {
      if (demoSent) return
      demoSent = true
      send(demo)
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey, scopeKey])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [input])

  useEffect(() => {
    let dead = false
    let dispose = null
    listen('ai', (event) => {
      const data = event.payload
      setMessages((prev) =>
        prev.map((message) => {
          if (message.requestId !== data.id) return message
          if (data.type === 'token') return { ...message, content: message.content + data.t }
          if (data.type === 'done') return { ...message, pending: false }
          if (data.type === 'error') return { ...message, pending: false, error: data.message }
          return message
        }),
      )
      if (data.type === 'done' || data.type === 'error') {
        setActive((current) => (current === data.id ? null : current))
      }
    }).then((unlisten) => {
      // Em StrictMode o efeito monta duas vezes: se já desmontou, remove na hora,
      // senão cada token seria recebido por dois listeners.
      if (dead) unlisten()
      else dispose = unlisten
    })
    return () => {
      dead = true
      dispose?.()
    }
  }, [])

  async function send(text) {
    const question = (text ?? input).trim()
    if (!question || !scopeIds.length) return
    if (!hasKey) {
      onOpenSettings()
      return
    }
    const requestId =
      globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const history = [
      ...messages
        .filter((m) => !m.error && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: question },
    ]
    const snapshot = scopeIds.slice()
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: question },
      {
        role: 'assistant',
        content: '',
        pending: true,
        requestId,
        docs: snapshot,
        selection: selection?.text || null,
      },
    ])
    setInput('')
    setSelection(null)
    onSeedClear?.()
    setActive(requestId)
    try {
      await api.chat({
        requestId,
        docIds: snapshot,
        history,
        selection: selection?.text || null,
      })
    } catch (error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.requestId === requestId ? { ...m, pending: false, error: String(error) } : m,
        ),
      )
      setActive(null)
    }
  }

  function stop() {
    if (active) api.cancelChat(active)
    setActive(null)
  }

  function cite(message, docNumber, page) {
    const docId = message.docs?.[docNumber - 1]
    const doc = docs.find((d) => d.id === docId)
    if (!doc) return
    onSource({
      doc,
      page,
      quote: quoteBefore(message.content, docNumber, page),
    })
  }

  const others = docs.filter((d) => !scopeIds.includes(d.id) && d.page_count > 0)

  return (
    <aside className="chat">
      <div className="chat-head">
        <div>
          <h3>Assistente</h3>
          <p>{scopeDocs.length === 1 ? scopeDocs[0].name : `${scopeDocs.length} documentos no escopo`}</p>
        </div>
        <button className="icon-btn" title="Configurações" onClick={onOpenSettings}>
          {Icon.gear({ className: 'ico' })}
        </button>
      </div>

      <div className="scope">
        {scopeDocs.map((doc, index) => (
          <span className="scope-chip" key={doc.id}>
            <b>D{index + 1}</b> {doc.name.slice(0, 28)}
            {scopeIds.length > 1 && (
              <button
                className="chip-x"
                title="Remover do escopo"
                onClick={() => setScopeIds(scopeIds.filter((id) => id !== doc.id))}
              >
                {Icon.close({ className: 'ico' })}
              </button>
            )}
          </span>
        ))}
        {others.length > 0 && (
          <select
            className="scope-add"
            value=""
            onChange={(event) => {
              if (event.target.value) setScopeIds([...scopeIds, event.target.value])
            }}
          >
            <option value="">+ comparar com…</option>
            {others.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {!hasKey && (
        <div className="banner">
          Configure a chave da DeepSeek para conversar com o PDF.
          <button className="link" onClick={onOpenSettings}>
            Abrir configurações
          </button>
        </div>
      )}

      <div className="messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <span className="chat-empty-mark">{Icon.comment({ className: 'ico' })}</span>
            <h4>Pergunte a este artigo</h4>
            <p>
              Cada resposta cita a página e o trecho de onde saiu. Selecione um trecho na leitura para
              perguntar sobre ele.
            </p>
            <div className="starters">
              {SUGGESTIONS.map((item) => (
                <button key={item} className="starter" onClick={() => send(item)} disabled={!hasKey}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) => (
          <div key={index} className={`msg ${message.role}`}>
            <span className="sr-only">
              {message.role === 'user' ? 'Sua pergunta' : 'Resposta do assistente'}
            </span>
            {message.role === 'assistant' ? (
              <>
                <Markdown onCite={(n, page) => cite(message, n, page)}>{message.content}</Markdown>
                {message.pending && <span className="typing" aria-label="Escrevendo" />}
                {message.error && <p className="msg-error">{message.error}</p>}
                {message.selection && !message.content && (
                  <p className="msg-quote">Trecho: “{message.selection.slice(0, 160)}…”</p>
                )}
              </>
            ) : (
              <div className="bubble">
                <p className="user-text">{message.content}</p>
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="composer">
        {selection && (
          <div className="selection-chip">
            <span>Trecho · p.{selection.page}</span>
            <button
              className="chip-x"
              onClick={() => {
                setSelection(null)
                onSeedClear?.()
              }}
            >
              {Icon.close({ className: 'ico' })}
            </button>
            <p>{selection.text.slice(0, 180)}</p>
          </div>
        )}
        <div className="composer-box">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="Pergunte algo sobre o documento…"
            aria-label="Pergunta"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
          />
          <button
            className="send-btn"
            onClick={() => send()}
            disabled={!input.trim() || !hasKey}
            title="Enviar"
            aria-label="Enviar pergunta"
          >
            {Icon.send({ className: 'ico' })}
          </button>
        </div>
        <div className="composer-actions">
          <span className="hint">Enter envia · Shift+Enter quebra linha</span>
          {active && (
            <button className="btn tiny" onClick={stop}>
              {Icon.stop({ className: 'ico' })} Parar
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
