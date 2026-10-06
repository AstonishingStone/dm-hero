/**
 * Entity mentions inside plain-text fields (e.g. descriptions).
 * Same formats as server/utils/extract-mentions.ts:
 * - {{type:id}}          (current format, e.g. written by the importer)
 * - [Name](type:id)      (legacy format, keeps its own label)
 */

export type MentionSegment
  = | { kind: 'text', text: string }
    | { kind: 'mention', type: string, id: number, label: string | null, raw: string }

const MENTION_PATTERN = /\{\{(\w+):(\d+)\}\}|\[([^\]]+)\]\((\w+):(\d+)\)/g

/** Split text into plain-text and mention segments, in order */
export function splitMentions(text: string | null | undefined): MentionSegment[] {
  if (!text) return []

  const segments: MentionSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, index) })
    }

    if (match[1]) {
      segments.push({ kind: 'mention', type: match[1], id: Number(match[2]), label: null, raw: match[0] })
    }
    else {
      segments.push({ kind: 'mention', type: match[4]!, id: Number(match[5]), label: match[3]!, raw: match[0] })
    }

    lastIndex = index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) })
  }

  return segments
}
