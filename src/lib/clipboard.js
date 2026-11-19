// Copia texto (e HTML, quando houver) para a área de transferência.
// ClipboardItem primeiro; writeText e execCommand como reserva.

export async function copyRich({ text, html }) {
  try {
    if (html && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ])
      return true
    }
  } catch {
    /* cai para a reserva */
  }
  try {
    if (!html && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* cai para a reserva */
  }
  return legacyCopy({ text, html })
}

function legacyCopy({ text, html }) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
  document.body.appendChild(area)
  area.select()
  const onCopy = (event) => {
    event.preventDefault()
    event.clipboardData.setData('text/plain', text)
    if (html) event.clipboardData.setData('text/html', html)
  }
  document.addEventListener('copy', onCopy)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.removeEventListener('copy', onCopy)
  area.remove()
  return ok
}
