import { describe, expect, it } from 'vitest'
import { hasMod, isTyping, shortcut } from '../platform'

describe('platform', () => {
  it('em Node/Linux o modificador é Ctrl', () => {
    expect(hasMod({ ctrlKey: true, metaKey: false })).toBe(true)
    expect(hasMod({ ctrlKey: false, metaKey: true })).toBe(false)
    expect(shortcut('F')).toBe('Ctrl+F')
  })
  it('detecta campos de texto', () => {
    expect(isTyping({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTyping({ tagName: 'DIV' })).toBe(false)
    expect(isTyping(null)).toBe(false)
  })
})
