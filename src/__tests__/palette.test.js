import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COLORS } from '../lib/annotations'

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

describe('paleta única, tema claro', () => {
  it('não tem tema escuro nem seleção de paleta', () => {
    expect(css).not.toMatch(/prefers-color-scheme|data-theme|data-palette|color-scheme:\s*dark/)
    expect(css).toMatch(/:root\s*{\s*color-scheme:\s*light;/)
  })

  it('cores de destaque são variáveis definidas no CSS, sem seletores por hex', () => {
    expect(css).not.toMatch(/\[style\*=/)
    for (const color of COLORS) {
      expect(color.hex).toBe(`var(--hl-${color.id})`)
      expect(css).toContain(`--hl-${color.id}:`)
    }
  })
})
