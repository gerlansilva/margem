// Abre links no navegador do sistema. Em Tauri usa o plugin opener (exige a
// permissão opener:allow-open-url nas capabilities); fora dele (navegador de
// teste, ou permissão ausente) cai em window.open e, por último, na área de
// transferência.
import { openUrl } from '@tauri-apps/plugin-opener'

const SAFE = /^(https?:|mailto:)/i

export async function openExternal(url) {
  if (!SAFE.test(url)) return false
  try {
    await openUrl(url)
    return true
  } catch {
    const win = window.open(url, '_blank', 'noopener,noreferrer')
    if (win) return true
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      /* sem área de transferência */
    }
    return false
  }
}
