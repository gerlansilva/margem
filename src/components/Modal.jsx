import { useEffect, useRef } from 'react'

const stack = []
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Diálogo acessível: role=dialog, Esc fecha (só o de cima), foco preso dentro
 * e devolvido ao elemento anterior ao fechar. Clique no fundo fecha, mas só se
 * o clique COMEÇOU no fundo (selecionar texto e soltar fora não fecha).
 */
export function Modal({ onClose, labelledBy, className = '', children }) {
  const ref = useRef(null)
  const down = useRef(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement
    const node = ref.current
    const token = {}
    stack.push(token)
    const first = node.querySelector('[data-autofocus]') || node.querySelector(FOCUSABLE) || node
    first.focus({ preventScroll: true })

    const onKey = (event) => {
      if (stack[stack.length - 1] !== token) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current?.()
      } else if (event.key === 'Tab') {
        const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null)
        if (!items.length) return event.preventDefault()
        const a = items[0]
        const z = items[items.length - 1]
        if (event.shiftKey && (document.activeElement === a || !node.contains(document.activeElement))) {
          event.preventDefault()
          z.focus()
        } else if (!event.shiftKey && document.activeElement === z) {
          event.preventDefault()
          a.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      stack.splice(stack.indexOf(token), 1)
      if (previous && document.contains(previous)) previous.focus?.({ preventScroll: true })
    }
  }, [])

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        down.current = event.target === event.currentTarget
      }}
      onMouseUp={(event) => {
        if (down.current && event.target === event.currentTarget) onClose?.()
        down.current = false
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`modal ${className}`}
      >
        {children}
      </div>
    </div>
  )
}
