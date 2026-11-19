import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
import { api, errorText, listen } from '../api'
import { shortcut } from '../lib/platform'
import { Icon } from './Icons'
import { stripTruncatedNotice } from '../lib/citations'
import { Markdown } from './Markdown'

const SUGGESTIONS = [
  'Resuma as contribuições principais do artigo.',
  'Qual é a metodologia e qual o tamanho da amostra?',
  'Quais são as limitações declaradas pelos autores?',
  'Que resultados numéricos o artigo reporta?',
]

const MAX_HISTORY = 12

let counter = 0
const newId = () => `m${Date.now().toString(36)}${(counter += 1)}`

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    area.remove()
    return ok
  }
}

export function ChatPanel({
  docs,
  scopeIds,
  setScopeIds,
  hasKey,
  onOpenSettings,
  onSource,
  onNotify,
  onExport,
  seed,
  onSeedClear,
  focusNonce,
  hidden,
}) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [active, setActive] = useState(null)
  const [selection, setSelection] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const endRef = useRef(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const stick = useRef(true)
  const cancelled = useRef(new Set())
  const activeRef = useRef(null)
  const scopeKey = scopeIds.join(',')

  const scopeDocs = useMemo(
    () => scopeIds.map((id) => docs.find((d) => d.id === id)).filter(Boolean),
    [scopeIds, docs],
  )

  activeRef.current = active

  // Troca de escopo: cancela o que estiver em andamento e carrega a conversa guardada.
  useEffect(() => {
    let dead = false
    if (activeRef.current) {
      cancelled.current.add(activeRef.current)
      api.cancelChat(activeRef.current).catch(() => {})
      setActive(null)
    }
    setLoaded(false)
    setMessages([])
    setSelection(null)
    stick.current = true
    api
      .getChat(scopeKey)
      .then((saved) => {
        if (dead) return
        // Resposta que ficou "escrevendo" quando o app fechou vira interrompida.
        setMessages(
          (saved || []).map((m) => (m.pending ? { ...m, pending: false, stopped: true } : m)),
        )
        setLoaded(true)
      })
      .catch(() => !dead && setLoaded(true))
    return () => {
      dead = true
    }
  }, [scopeKey])

  // Guarda a conversa (sem o que ainda está chegando).
  useEffect(() => {
    if (!loaded) return undefined
    const timer = setTimeout(() => {
      const stable = messages.filter((m) => !m.pending)
      if (stable.length || messages.length === 0) api.saveChat(scopeKey, stable).catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [messages, loaded, scopeKey])

  useEffect(() => {
    if (seed) {
      setSelection({ text: seed.text, page: seed.page })
      inputRef.current?.focus()
    }
  }, [seed])

  useEffect(() => {
    if (focusNonce) inputRef.current?.focus()
  }, [focusNonce])

  useEffect(() => {
    if (!stick.current) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
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
      if (!data || !data.id) return
      const stopped = cancelled.current.has(data.id)
      setMessages((prev) =>
        prev.map((message) => {
          if (message.requestId !== data.id) return message
          // Aviso passageiro do backend ("Nova tentativa em 2 s…"); some quando o texto chega.
          if (data.type === 'status') return stopped ? message : { ...message, status: data.message || '' }
          if (data.type === 'token')
            return stopped ? message : { ...message, status: '', content: message.content + data.t }
          if (data.type === 'done') {
            const done = {
              ...message,
              pending: false,
              status: '',
              content: stopped ? message.content : message.content || data.answer || '',
              citations: Array.isArray(data.citations) ? data.citations : message.citations,
              truncated: !!data.truncated,
            }
            if (data.cancelled || stopped) done.stopped = true
            return done
          }
          // Em erro só vem `error`, sem `done`: a bolha fecha aqui.
          if (data.type === 'error') {
            return stopped
              ? { ...message, pending: false, status: '' }
              : { ...message, pending: false, status: '', error: data.message }
          }
          return message
        }),
      )
      if (data.type === 'done' || data.type === 'error') {
        cancelled.current.delete(data.id)
        setActive((current) => (current === data.id ? null : current))
      }
    })
      .then((unlisten) => {
        // Em StrictMode o efeito monta duas vezes: se já desmontou, remove na hora,
        // senão cada token seria recebido por dois listeners.
        if (dead) unlisten()
        else dispose = unlisten
      })
      .catch((error) => onNotify?.(`Não foi possível ouvir o assistente: ${errorText(error)}`))
    return () => {
      dead = true
      dispose?.()
    }
  }, [onNotify])

  const send = useCallback(
    async (text) => {
      const question = (text ?? input).trim()
      if (!question || !scopeIds.length || activeRef.current || !loaded) return
      if (!hasKey) {
        onOpenSettings()
        return
      }
      const requestId =
        globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const picked = selection?.text || null
      const history = [
        ...messages
          .filter((m) => !m.error && !m.stopped && m.content.trim())
          .map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: question },
      ].slice(-MAX_HISTORY)
      const snapshot = scopeIds.slice()
      stick.current = true
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: 'user', content: question, selection: picked },
        {
          id: newId(),
          role: 'assistant',
          content: '',
          pending: true,
          requestId,
          docs: snapshot,
          selection: picked,
        },
      ])
      setInput('')
      setSelection(null)
      onSeedClear?.()
      setActive(requestId)
      try {
        await api.chat({ requestId, docIds: snapshot, history, selection: picked })
      } catch (error) {
        setMessages((prev) =>
          prev.map((m) =>
            m.requestId === requestId ? { ...m, pending: false, error: errorText(error) } : m,
          ),
        )
        setActive((current) => (current === requestId ? null : current))
      }
    },
    [input, scopeIds, hasKey, loaded, selection, messages, onOpenSettings, onSeedClear],
  )

  function stop() {
    const id = activeRef.current
    if (!id) return
    cancelled.current.add(id)
    api.cancelChat(id).catch(() => {})
    // Fecha a bolha na hora: o backend só percebe o cancelamento no próximo trecho.
    setMessages((prev) => prev.map((m) => (m.requestId === id ? { ...m, pending: false, stopped: true } : m)))
    setActive(null)
  }

  function retry(index) {
    const question = messages[index - 1]?.content
    if (!question) return
    setMessages((prev) => prev.filter((_, i) => i !== index && i !== index - 1))
    setTimeout(() => send(question), 0)
  }

  async function clearConversation() {
    if (!messages.length) return
    const ok = await confirmDialog('Apagar esta conversa?', { title: 'Nova conversa', kind: 'warning' }).catch(
      () => false,
    )
    if (!ok) return
    if (activeRef.current) stop()
    setMessages([])
    api.clearChat(scopeKey).catch(() => {})
  }

  function cite(message, docNumber, page, quote) {
    const docId = message.docs?.[docNumber - 1]
    const doc = docs.find((d) => d.id === docId)
    if (!doc) {
      onNotify?.(`O documento D${docNumber} desta resposta não está mais na biblioteca.`)
      return
    }
    onSource({ doc, page, quote: quote || '' })
  }

  const others = docs.filter((d) => !scopeIds.includes(d.id) && d.page_count > 0)
  const busy = !!active

  return (
    <aside className="chat" hidden={hidden} aria-label="Assistente">
      <div className="chat-head">
        <div>
          <h3>Assistente</h3>
          <p>{scopeDocs.length === 1 ? scopeDocs[0].name : `${scopeDocs.length} documentos no escopo`}</p>
        </div>
        <div className="chat-head-actions">
          <button
            className="icon-btn"
            title="Exportar a conversa (Markdown)"
            aria-label="Exportar a conversa em Markdown"
            disabled={!messages.some((m) => m.content)}
            onClick={() => onExport(scopeDocs, messages)}
          >
            {Icon.download({ className: 'ico' })}
          </button>
          <button
            className="icon-btn"
            title="Nova conversa"
            aria-label="Apagar a conversa e começar outra"
            disabled={!messages.length}
            onClick={clearConversation}
          >
            {Icon.trash({ className: 'ico' })}
          </button>
          <button className="icon-btn" title={`Configurações (${shortcut(',')})`} aria-label="Configurações" onClick={onOpenSettings}>
            {Icon.gear({ className: 'ico' })}
          </button>
        </div>
      </div>

      <div className="scope">
        {scopeDocs.map((doc, index) => (
          <span className="scope-chip" key={doc.id}>
            <b>D{index + 1}</b> {doc.name.length > 28 ? `${doc.name.slice(0, 28)}…` : doc.name}
            {scopeIds.length > 1 && (
              <button
                className="chip-x"
                title="Remover do escopo"
                aria-label={`Remover ${doc.name} do escopo`}
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
            aria-label="Comparar com outro documento"
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
        <div className="banner" role="status">
          Configure a chave da DeepSeek para conversar com o PDF.
          <button className="link" onClick={onOpenSettings}>
            Abrir configurações
          </button>
        </div>
      )}

      <div
        className="messages"
        ref={listRef}
        role="log"
        aria-label="Conversa"
        onScroll={(event) => {
          const el = event.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
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
                <button key={item} className="starter" onClick={() => send(item)} disabled={!hasKey || busy}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) => (
          <div key={message.id || index} className={`msg ${message.role}`}>
            <span className="sr-only">
              {message.role === 'user' ? 'Sua pergunta' : 'Resposta do assistente'}
            </span>
            {message.role === 'assistant' ? (
              <>
                {message.selection && (
                  <p className="msg-quote">
                    Trecho: “{message.selection.slice(0, 160)}
                    {message.selection.length > 160 ? '…' : ''}”
                  </p>
                )}
                <Markdown
                  citations={message.citations}
                  onCite={(n, page, quote) => cite(message, n, page, quote)}
                >
                  {message.truncated ? stripTruncatedNotice(message.content) : message.content}
                </Markdown>
                {message.pending && message.status && (
                  <p className="msg-status" role="status" data-testid="chat-status">
                    {message.status}
                  </p>
                )}
                {message.pending && <span className="typing" role="status" aria-label="Escrevendo" />}
                {message.truncated && (
                  <p className="msg-warn" role="note" data-testid="truncated-note">
                    Resposta cortada pelo limite de tamanho do modelo. Peça para continuar ou faça uma pergunta mais específica.
                  </p>
                )}
                {message.citations?.some((c) => c.valid === false) && (
                  <p className="msg-warn" role="note" data-testid="invalid-cite-note">
                    Há citações não verificadas (páginas que o modelo não recebeu): estão tracejadas. Confira no PDF.
                  </p>
                )}
                {message.stopped && <p className="msg-note">Resposta interrompida.</p>}
                {message.error && (
                  <p className="msg-error" role="alert">
                    {message.error}
                    <button className="link-btn" onClick={() => retry(index)}>
                      Tentar de novo
                    </button>
                  </p>
                )}
                {!message.pending && message.content && (
                  <div className="msg-tools">
                    <button
                      className="icon-btn subtle"
                      title="Copiar resposta"
                      aria-label="Copiar resposta"
                      onClick={async () =>
                        onNotify?.((await copyText(message.content)) ? 'Resposta copiada.' : 'Não foi possível copiar.')
                      }
                    >
                      {Icon.copy({ className: 'ico' })}
                    </button>
                  </div>
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
              aria-label="Remover o trecho da pergunta"
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
              // Enter dentro de composição (IME) confirma a palavra, não envia.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                if (!busy) send()
              } else if (event.key === 'Escape' && busy) {
                event.stopPropagation()
                stop()
              }
            }}
          />
          {busy ? (
            <button className="send-btn stop" onClick={stop} title="Parar (Esc)" aria-label="Parar a resposta">
              {Icon.stop({ className: 'ico' })}
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={() => send()}
              disabled={!input.trim() || !hasKey}
              title="Enviar (Enter)"
              aria-label="Enviar pergunta"
            >
              {Icon.send({ className: 'ico' })}
            </button>
          )}
        </div>
        <div className="composer-actions">
          <span className="hint">
            Enter envia · Shift+Enter quebra linha · {shortcut('K')} foca aqui
          </span>
          {busy && (
            <button className="btn tiny" onClick={stop}>
              {Icon.stop({ className: 'ico' })} Parar
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
