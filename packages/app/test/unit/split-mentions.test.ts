import { describe, it, expect } from 'vitest'
import { splitMentions } from '../../app/utils/mentions'

/**
 * Tests for splitting plain-text fields (descriptions) into text and entity mentions.
 * Used to render {{type:id}} links as entity names instead of raw tokens.
 */

describe('splitMentions', () => {
  it('should return no segments for empty input', () => {
    expect(splitMentions(null)).toEqual([])
    expect(splitMentions(undefined)).toEqual([])
    expect(splitMentions('')).toEqual([])
  })

  it('should keep text without mentions as a single segment', () => {
    expect(splitMentions('Just an innkeeper.')).toEqual([{ kind: 'text', text: 'Just an innkeeper.' }])
  })

  it('should split {{type:id}} mentions in order', () => {
    const segments = splitMentions('Innkeeper of {{location:27}}. Noticed {{npc:19}} paying in silver.')

    expect(segments).toEqual([
      { kind: 'text', text: 'Innkeeper of ' },
      { kind: 'mention', type: 'location', id: 27, label: null, raw: '{{location:27}}' },
      { kind: 'text', text: '. Noticed ' },
      { kind: 'mention', type: 'npc', id: 19, label: null, raw: '{{npc:19}}' },
      { kind: 'text', text: ' paying in silver.' },
    ])
  })

  it('should handle mentions at the start, end and next to each other', () => {
    const segments = splitMentions('{{npc:1}}{{npc:2}}')

    expect(segments).toHaveLength(2)
    expect(segments.every(s => s.kind === 'mention')).toBe(true)
  })

  it('should keep the label of legacy [Name](type:id) links', () => {
    expect(splitMentions('Ask [Gandalf](npc:12).')).toEqual([
      { kind: 'text', text: 'Ask ' },
      { kind: 'mention', type: 'npc', id: 12, label: 'Gandalf', raw: '[Gandalf](npc:12)' },
      { kind: 'text', text: '.' },
    ])
  })

  it('should leave malformed tokens as text', () => {
    expect(splitMentions('{{npc:abc}} and {npc:1}')).toEqual([{ kind: 'text', text: '{{npc:abc}} and {npc:1}' }])
  })

  it('should give the same result when called twice (no shared regex state)', () => {
    const text = 'At {{location:3}}'
    expect(splitMentions(text)).toEqual(splitMentions(text))
  })
})
