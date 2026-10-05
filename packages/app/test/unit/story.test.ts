import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { getTestDb } from '../utils/test-db'
import {
  createStoryNode,
  createStoryOutline,
  deleteStoryNode,
  getStoryNode,
  listStoryNodes,
  moveStoryNode,
  setSessionStoryNodes,
  setStoryNodeLinks,
  storyNodesBySession,
  StoryError,
  updateStoryNode,
} from '../../server/utils/story'
import { syncSessionMentions } from '../../server/utils/extract-mentions'

let db: Database.Database
let campaignId: number
let otherCampaignId: number

beforeAll(() => {
  db = getTestDb()
})

beforeEach(() => {
  campaignId = Number(db.prepare('INSERT INTO campaigns (name) VALUES (?)').run('Story').lastInsertRowid)
  otherCampaignId = Number(db.prepare('INSERT INTO campaigns (name) VALUES (?)').run('Other').lastInsertRowid)
})

function npc(name: string, campaign = campaignId): number {
  const typeId = (db.prepare('SELECT id FROM entity_types WHERE name = ?').get('NPC') as { id: number }).id
  return Number(db.prepare('INSERT INTO entities (type_id, campaign_id, name) VALUES (?, ?, ?)').run(typeId, campaign, name).lastInsertRowid)
}

function session(title: string, campaign = campaignId): number {
  return Number(db.prepare('INSERT INTO sessions (campaign_id, title) VALUES (?, ?)').run(campaign, title).lastInsertRowid)
}

const order = (parentId: number | null) =>
  listStoryNodes(db, campaignId).filter(n => n.parent_id === parentId).map(n => n.name)

describe('story nodes', () => {
  it('creates nodes appended to their siblings with defaults', () => {
    const arc = createStoryNode(db, { campaignId, name: 'Arc 1', kind: 'arc' })
    createStoryNode(db, { campaignId, name: 'Scene A', parentId: arc.id })
    createStoryNode(db, { campaignId, name: 'Scene B', parentId: arc.id })

    expect(arc.metadata).toMatchObject({ kind: 'arc', status: 'idea' })
    expect(order(arc.id)).toEqual(['Scene A', 'Scene B'])
    expect(listStoryNodes(db, campaignId).find(n => n.name === 'Scene A')!.kind).toBe('scene')
  })

  it('rejects a parent from another campaign', () => {
    const foreign = createStoryNode(db, { campaignId: otherCampaignId, name: 'Elsewhere' })
    expect(() => createStoryNode(db, { campaignId, name: 'X', parentId: foreign.id })).toThrow(StoryError)
  })

  it('patches only the given fields', () => {
    const node = createStoryNode(db, { campaignId, name: 'Scene' })
    updateStoryNode(db, node.id, { description: 'Body', hook: 'Hook', status: 'ready' })
    const updated = updateStoryNode(db, node.id, { secrets: 'Secret' })

    expect(updated.description).toBe('Body')
    expect(updated.metadata).toMatchObject({ hook: 'Hook', secrets: 'Secret', status: 'ready', kind: 'scene' })
    expect(() => updateStoryNode(db, node.id, { name: '  ' })).toThrow(StoryError)
    expect(() => updateStoryNode(db, node.id, { status: 'bogus' as never })).toThrow(StoryError)
  })

  it('sanitizes music links', () => {
    const node = createStoryNode(db, { campaignId, name: 'Scene' })
    const updated = updateStoryNode(db, node.id, {
      musicLinks: [{ label: 'Tavern', url: 'https://youtube.com/x' }, { label: 'Bad', url: 'javascript:alert(1)' }],
    })
    expect(updated.metadata.musicLinks).toEqual([{ label: 'Tavern', url: 'https://youtube.com/x' }])
  })

  it('syncs mentions from body and prep texts, type-checked', () => {
    const villain = npc('Villain')
    const ally = npc('Ally')
    const node = createStoryNode(db, { campaignId, name: 'Scene' })
    updateStoryNode(db, node.id, { description: `{{npc:${villain}}}`, secrets: `{{npc:${ally}}} {{location:${ally}}}` })

    const mentioned = (db.prepare('SELECT entity_id FROM story_node_mentions WHERE node_id = ? ORDER BY entity_id')
      .all(node.id) as Array<{ entity_id: number }>).map(r => r.entity_id)
    expect(mentioned).toEqual([villain, ally].sort((a, b) => a - b))

    updateStoryNode(db, node.id, { secrets: '' })
    expect(db.prepare('SELECT COUNT(*) AS c FROM story_node_mentions WHERE node_id = ?').get(node.id)).toEqual({ c: 1 })
  })

  it('soft-deletes a node with its whole subtree', () => {
    const arc = createStoryNode(db, { campaignId, name: 'Arc' })
    const chapter = createStoryNode(db, { campaignId, name: 'Chapter', parentId: arc.id })
    createStoryNode(db, { campaignId, name: 'Scene', parentId: chapter.id })
    createStoryNode(db, { campaignId, name: 'Keep' })

    expect(deleteStoryNode(db, arc.id)).toHaveLength(3)
    expect(listStoryNodes(db, campaignId).map(n => n.name)).toEqual(['Keep'])
    expect(() => getStoryNode(db, chapter.id)).toThrow(StoryError)
  })
})

describe('moveStoryNode', () => {
  it('reorders among siblings', () => {
    const a = createStoryNode(db, { campaignId, name: 'A' })
    createStoryNode(db, { campaignId, name: 'B' })
    createStoryNode(db, { campaignId, name: 'C' })

    moveStoryNode(db, a.id, null, 2)
    expect(order(null)).toEqual(['B', 'C', 'A'])
    moveStoryNode(db, a.id, null, 0)
    expect(order(null)).toEqual(['A', 'B', 'C'])
  })

  it('reparents and renumbers both sides', () => {
    const arc1 = createStoryNode(db, { campaignId, name: 'Arc1' })
    const arc2 = createStoryNode(db, { campaignId, name: 'Arc2' })
    const s1 = createStoryNode(db, { campaignId, name: 'S1', parentId: arc1.id })
    createStoryNode(db, { campaignId, name: 'S2', parentId: arc1.id })
    createStoryNode(db, { campaignId, name: 'T1', parentId: arc2.id })

    moveStoryNode(db, s1.id, arc2.id, 1)
    expect(order(arc2.id)).toEqual(['T1', 'S1'])
    expect(order(arc1.id)).toEqual(['S2'])
    expect(listStoryNodes(db, campaignId).find(n => n.name === 'S2')!.sort_order).toBe(0)
  })

  it('rejects moving a node into itself or a descendant', () => {
    const arc = createStoryNode(db, { campaignId, name: 'Arc' })
    const chapter = createStoryNode(db, { campaignId, name: 'Chapter', parentId: arc.id })
    expect(() => moveStoryNode(db, arc.id, arc.id, 0)).toThrow(StoryError)
    expect(() => moveStoryNode(db, arc.id, chapter.id, 0)).toThrow(StoryError)
  })
})

describe('links', () => {
  it('replaces links per list, ignoring other campaigns', () => {
    const node = createStoryNode(db, { campaignId, name: 'Scene' })
    const s1 = session('S1')
    const s2 = session('S2')
    const foreign = session('Foreign', otherCampaignId)

    let result = setStoryNodeLinks(db, node.id, { sessionIds: [s1, s2, foreign] })
    expect(result.sessions.map(s => s.id)).toEqual([s1, s2])

    result = setStoryNodeLinks(db, node.id, { mapIds: [] })
    expect(result.sessions).toHaveLength(2) // untouched

    result = setStoryNodeLinks(db, node.id, { sessionIds: [s2] })
    expect(result.sessions.map(s => s.id)).toEqual([s2])
    expect(listStoryNodes(db, campaignId)[0]!.session_count).toBe(1)
  })

  it('links from the session side', () => {
    const a = createStoryNode(db, { campaignId, name: 'A' })
    const b = createStoryNode(db, { campaignId, name: 'B' })
    const s = session('S')

    expect(setSessionStoryNodes(db, s, [a.id, b.id]).map(n => n.name)).toEqual(['A', 'B'])
    expect(setSessionStoryNodes(db, s, [b.id]).map(n => n.name)).toEqual(['B'])
    expect(storyNodesBySession(db, s).map(n => n.id)).toEqual([b.id])
  })
})

describe('session mention type check', () => {
  it('does not store {{session:id}} as a mention of the entity with that id', () => {
    const someNpc = npc('Coincidence')
    const s = session('S')
    syncSessionMentions(db, s, `{{session:${someNpc}}}`)
    expect(db.prepare('SELECT COUNT(*) AS c FROM session_mentions WHERE session_id = ?').get(s)).toEqual({ c: 0 })

    syncSessionMentions(db, s, `{{location:${someNpc}}}`)
    expect(db.prepare('SELECT COUNT(*) AS c FROM session_mentions WHERE session_id = ?').get(s)).toEqual({ c: 0 })
  })
})

describe('createStoryOutline', () => {
  const outline = () => [{
    name: 'The Haunted House',
    children: [{
      name: 'Arrival',
      children: [
        { name: 'Meeting the harbormaster', status: 'ready' as const, readAloud: 'Fog rolls in.', secrets: `{{npc:${npc('Elra')}}} lies` },
        { name: 'Handout', kind: 'note' as const },
      ],
    }],
  }]

  it('creates the nested tree with kinds from depth, texts and mentions', () => {
    const result = createStoryOutline(db, { campaignId, nodes: outline() })
    expect(result.created).toBe(4)

    const arc = result.outline[0]!
    expect(arc.kind).toBe('arc')
    expect(arc.children[0]!.kind).toBe('chapter')
    expect(arc.children[0]!.children.map(n => [n.name, n.kind])).toEqual([['Meeting the harbormaster', 'scene'], ['Handout', 'note']])

    const scene = getStoryNode(db, arc.children[0]!.children[0]!.id!)
    expect(scene.metadata).toMatchObject({ status: 'ready', readAloud: 'Fog rolls in.' })
    expect(scene.mentions.map(m => m.name)).toEqual(['Elra'])
    expect(order(arc.children[0]!.id)).toEqual(['Meeting the harbormaster', 'Handout'])
  })

  it('dry run resolves without writing', () => {
    const result = createStoryOutline(db, { campaignId, nodes: outline(), dryRun: true })
    expect(result.created).toBe(0)
    expect(result.outline[0]!.id).toBeNull()
    expect(listStoryNodes(db, campaignId)).toHaveLength(0)
  })

  it('validates everything before writing anything', () => {
    expect(() => createStoryOutline(db, {
      campaignId,
      nodes: [{ name: 'Fine', children: [{ name: '' }, { name: 'Bad', kind: 'saga' as never }] }],
    })).toThrow(/name is required.*invalid kind "saga"/)
    expect(listStoryNodes(db, campaignId)).toHaveLength(0)
  })

  it('nests under an existing node, counting its depth', () => {
    const arc = createStoryNode(db, { campaignId, name: 'Arc', kind: 'arc' })
    const result = createStoryOutline(db, { campaignId, parentId: arc.id, nodes: [{ name: 'Chapter', children: [{ name: 'Scene' }] }] })
    expect(result.outline[0]!.kind).toBe('chapter')
    expect(result.outline[0]!.children[0]!.kind).toBe('scene')
    expect(order(arc.id)).toEqual(['Chapter'])
  })
})
