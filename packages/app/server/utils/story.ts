import type Database from 'better-sqlite3'
import { syncStoryNodeMentions } from './extract-mentions'
import { sanitizeMusicLinks } from './music-links'
import {
  normalizeStoryMetadata,
  STORY_NODE_KINDS,
  STORY_NODE_STATUSES,
  STORY_NODE_TEXT_FIELDS,
  type StoryNode,
  type StoryNodeKind,
  type StoryNodeLinkedEncounter,
  type StoryNodeLinkedMap,
  type StoryNodeLinkedSession,
  type StoryNodeLinks,
  type StoryNodeListItem,
  type StoryNodeMention,
  type StoryNodeMetadata,
  type StoryNodeStatus,
} from '~~/types/story'

// The campaign manager's tree: story nodes are entities of type StoryNode,
// nested via parent_entity_id and ordered among siblings via sort_order.

export class StoryError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}

/** Id of the StoryNode entity type. */
export function getStoryTypeId(db: Database.Database): number {
  const row = db.prepare('SELECT id FROM entity_types WHERE name = ?').get('StoryNode') as { id: number } | undefined
  if (!row) throw new StoryError(500, 'StoryNode entity type not found')
  return row.id
}

interface NodeRow {
  id: number
  campaign_id: number
  name: string
  description: string | null
  parent_entity_id: number | null
  sort_order: number
  metadata: string | null
  created_at: string
  updated_at: string
}

/** Parse stored metadata, with defaults for kind/status (bad JSON counts as empty). */
function parseMetadata(raw: string | null) {
  try {
    return normalizeStoryMetadata(raw ? JSON.parse(raw) : null)
  }
  catch {
    return normalizeStoryMetadata(null)
  }
}

/** A live story node row; 404 if it does not exist or is deleted. */
function getNodeRow(db: Database.Database, id: number): NodeRow {
  const row = db.prepare(`
    SELECT id, campaign_id, name, description, parent_entity_id, sort_order, metadata, created_at, updated_at
    FROM entities WHERE id = ? AND type_id = ? AND deleted_at IS NULL
  `).get(id, getStoryTypeId(db)) as NodeRow | undefined
  if (!row) throw new StoryError(404, 'Story node not found')
  return row
}

/** Everything a node's mentions are read from: body + prep texts */
function mentionSource(description: string | null, metadata: StoryNodeMetadata): string {
  return [description, ...STORY_NODE_TEXT_FIELDS.map(f => metadata[f])].filter(Boolean).join('\n')
}

/** The whole tree of a campaign as a flat list, ordered for display */
export function listStoryNodes(db: Database.Database, campaignId: number): StoryNodeListItem[] {
  const rows = db.prepare(`
    SELECT e.id, e.name, e.parent_entity_id, e.sort_order, e.metadata,
      (SELECT COUNT(*) FROM story_node_sessions s JOIN sessions ss ON ss.id = s.session_id AND ss.deleted_at IS NULL WHERE s.node_id = e.id) AS session_count,
      (SELECT COUNT(*) FROM story_node_encounters x JOIN encounters ce ON ce.id = x.encounter_id AND ce.deleted_at IS NULL WHERE x.node_id = e.id) AS encounter_count,
      (SELECT COUNT(*) FROM story_node_maps m JOIN campaign_maps cm ON cm.id = m.map_id AND cm.deleted_at IS NULL WHERE m.node_id = e.id) AS map_count
    FROM entities e
    WHERE e.campaign_id = ? AND e.type_id = ? AND e.deleted_at IS NULL
    ORDER BY e.sort_order, e.id
  `).all(campaignId, getStoryTypeId(db)) as Array<Omit<NodeRow, 'campaign_id' | 'description' | 'created_at' | 'updated_at'> & {
    session_count: number
    encounter_count: number
    map_count: number
  }>

  return rows.map((r) => {
    const meta = parseMetadata(r.metadata)
    return {
      id: r.id,
      name: r.name,
      parent_id: r.parent_entity_id,
      sort_order: r.sort_order,
      kind: meta.kind,
      status: meta.status,
      session_count: r.session_count,
      encounter_count: r.encounter_count,
      map_count: r.map_count,
    }
  })
}

/** A node with its texts, linked sessions/encounters/maps (deleted ones left out) and mentions. */
export function getStoryNode(db: Database.Database, id: number): StoryNode {
  const row = getNodeRow(db, id)
  const sessions = db.prepare(`
    SELECT s.id, s.title, s.session_number, s.date FROM story_node_sessions l
    JOIN sessions s ON s.id = l.session_id AND s.deleted_at IS NULL
    WHERE l.node_id = ? ORDER BY s.session_number, s.date, s.id
  `).all(id) as StoryNodeLinkedSession[]
  const encounters = db.prepare(`
    SELECT x.id, x.name, x.status FROM story_node_encounters l
    JOIN encounters x ON x.id = l.encounter_id AND x.deleted_at IS NULL
    WHERE l.node_id = ? ORDER BY x.name
  `).all(id) as StoryNodeLinkedEncounter[]
  const maps = db.prepare(`
    SELECT m.id, m.name FROM story_node_maps l
    JOIN campaign_maps m ON m.id = l.map_id AND m.deleted_at IS NULL
    WHERE l.node_id = ? ORDER BY m.name
  `).all(id) as StoryNodeLinkedMap[]
  const mentions = db.prepare(`
    SELECT e.id, e.name, m.context AS type FROM story_node_mentions m
    JOIN entities e ON e.id = m.entity_id AND e.deleted_at IS NULL
    WHERE m.node_id = ? ORDER BY m.context, e.name
  `).all(id) as StoryNodeMention[]

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    parent_id: row.parent_entity_id,
    sort_order: row.sort_order,
    metadata: parseMetadata(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    sessions,
    encounters,
    maps,
    mentions,
  }
}

/** Check that a parent exists and belongs to the same campaign (null = top level). */
function assertParent(db: Database.Database, campaignId: number, parentId: number | null) {
  if (parentId === null) return
  const parent = getNodeRow(db, parentId)
  if (parent.campaign_id !== campaignId) throw new StoryError(400, 'Parent belongs to another campaign')
}

/** Sort order that appends a node after its last sibling. */
function nextSortOrder(db: Database.Database, campaignId: number, parentId: number | null): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM entities
    WHERE campaign_id = ? AND type_id = ? AND deleted_at IS NULL AND parent_entity_id IS ?
  `).get(campaignId, getStoryTypeId(db), parentId) as { next: number }
  return row.next
}

/** Create a node (kind defaults to scene, status to idea) as the last child of parentId. */
export function createStoryNode(
  db: Database.Database,
  input: { campaignId: number, name: string, kind?: StoryNodeKind, parentId?: number | null },
): StoryNode {
  const name = input.name?.trim()
  if (!name || !input.campaignId) throw new StoryError(400, 'Name and Campaign ID are required')
  const parentId = input.parentId ?? null
  const kind = STORY_NODE_KINDS.includes(input.kind as StoryNodeKind) ? input.kind! : 'scene'

  const id = db.transaction(() => {
    assertParent(db, input.campaignId, parentId)
    const metadata: StoryNodeMetadata = { kind, status: 'idea' }
    const result = db.prepare(`
      INSERT INTO entities (type_id, campaign_id, name, parent_entity_id, sort_order, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(getStoryTypeId(db), input.campaignId, name, parentId, nextSortOrder(db, input.campaignId, parentId), JSON.stringify(metadata))
    return Number(result.lastInsertRowid)
  })()

  return getStoryNode(db, id)
}

export interface StoryNodePatch {
  name?: string
  description?: string | null
  kind?: StoryNodeKind
  status?: StoryNodeStatus
  hook?: string
  readAloud?: string
  secrets?: string
  outcomes?: string
  musicLinks?: unknown
}

/** Partial update: only the given fields change */
export function updateStoryNode(db: Database.Database, id: number, patch: StoryNodePatch): StoryNode {
  db.transaction(() => {
    const row = getNodeRow(db, id)
    const metadata = parseMetadata(row.metadata)

    if (patch.kind !== undefined) {
      if (!STORY_NODE_KINDS.includes(patch.kind)) throw new StoryError(400, 'Invalid kind')
      metadata.kind = patch.kind
    }
    if (patch.status !== undefined) {
      if (!STORY_NODE_STATUSES.includes(patch.status)) throw new StoryError(400, 'Invalid status')
      metadata.status = patch.status
    }
    for (const field of STORY_NODE_TEXT_FIELDS) {
      if (patch[field] !== undefined) metadata[field] = String(patch[field] ?? '')
    }
    if (patch.musicLinks !== undefined) metadata.musicLinks = sanitizeMusicLinks(patch.musicLinks)

    let name = row.name
    if (patch.name !== undefined) {
      name = String(patch.name).trim()
      if (!name) throw new StoryError(400, 'Name must not be empty')
    }
    const description = patch.description !== undefined ? patch.description : row.description

    db.prepare(`
      UPDATE entities SET name = ?, description = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, description, JSON.stringify(metadata), id)

    syncStoryNodeMentions(db, id, mentionSource(description, metadata))
  })()

  return getStoryNode(db, id)
}

/** The node and all its descendants (ids) */
function subtreeIds(db: Database.Database, id: number): number[] {
  return (db.prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT ?
      UNION
      SELECT e.id FROM entities e JOIN tree t ON e.parent_entity_id = t.id
      WHERE e.deleted_at IS NULL
    )
    SELECT id FROM tree
  `).all(id) as Array<{ id: number }>).map(r => r.id)
}

/** Soft-delete a node with everything below it; returns the deleted ids */
export function deleteStoryNode(db: Database.Database, id: number): number[] {
  return db.transaction(() => {
    getNodeRow(db, id)
    const ids = subtreeIds(db, id)
    const placeholders = ids.map(() => '?').join(',')
    db.prepare(`UPDATE entities SET deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders}) AND deleted_at IS NULL`).run(...ids)
    return ids
  })()
}

/** Put a node under parentId (null = top level) at position index among its new siblings */
export function moveStoryNode(db: Database.Database, id: number, parentId: number | null, index: number): StoryNodeListItem[] {
  return db.transaction(() => {
    const row = getNodeRow(db, id)
    assertParent(db, row.campaign_id, parentId)
    if (parentId !== null && subtreeIds(db, id).includes(parentId)) {
      throw new StoryError(400, 'A node cannot be moved into itself or its descendants')
    }

    const typeId = getStoryTypeId(db)
    const siblings = (db.prepare(`
      SELECT id FROM entities
      WHERE campaign_id = ? AND type_id = ? AND deleted_at IS NULL AND parent_entity_id IS ? AND id != ?
      ORDER BY sort_order, id
    `).all(row.campaign_id, typeId, parentId, id) as Array<{ id: number }>).map(r => r.id)

    const position = Math.max(0, Math.min(Math.trunc(index) || 0, siblings.length))
    siblings.splice(position, 0, id)

    db.prepare('UPDATE entities SET parent_entity_id = ? WHERE id = ?').run(parentId, id)
    const setOrder = db.prepare('UPDATE entities SET sort_order = ? WHERE id = ?')
    siblings.forEach((siblingId, i) => setOrder.run(i, siblingId))

    // Close the gap the node left behind
    if (row.parent_entity_id !== parentId) {
      const old = db.prepare(`
        SELECT id FROM entities
        WHERE campaign_id = ? AND type_id = ? AND deleted_at IS NULL AND parent_entity_id IS ?
        ORDER BY sort_order, id
      `).all(row.campaign_id, typeId, row.parent_entity_id) as Array<{ id: number }>
      old.forEach((r, i) => setOrder.run(i, r.id))
    }

    return listStoryNodes(db, row.campaign_id)
  })()
}

/** Replace the linked sessions / encounters / maps (each list only if given) */
export function setStoryNodeLinks(db: Database.Database, id: number, links: StoryNodeLinks): StoryNode {
  const junctions = [
    { ids: links.sessionIds, table: 'story_node_sessions', column: 'session_id', target: 'sessions', alive: 'AND deleted_at IS NULL' },
    { ids: links.encounterIds, table: 'story_node_encounters', column: 'encounter_id', target: 'encounters', alive: 'AND deleted_at IS NULL' },
    { ids: links.mapIds, table: 'story_node_maps', column: 'map_id', target: 'campaign_maps', alive: 'AND deleted_at IS NULL' },
  ] as const

  db.transaction(() => {
    const row = getNodeRow(db, id)
    for (const j of junctions) {
      if (j.ids === undefined) continue
      if (!Array.isArray(j.ids)) throw new StoryError(400, `${j.column} list must be an array`)
      const wanted = [...new Set(j.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))]
      // Only targets of the same campaign
      const valid = wanted.length
        ? (db.prepare(`SELECT id FROM ${j.target} WHERE id IN (${wanted.map(() => '?').join(',')}) AND campaign_id = ? ${j.alive}`)
            .all(...wanted, row.campaign_id) as Array<{ id: number }>).map(r => r.id)
        : []
      db.prepare(`DELETE FROM ${j.table} WHERE node_id = ?`).run(id)
      const insert = db.prepare(`INSERT INTO ${j.table} (node_id, ${j.column}) VALUES (?, ?)`)
      for (const targetId of valid) insert.run(id, targetId)
    }
  })()

  return getStoryNode(db, id)
}

/** Nodes played in a session (for the session view) */
export function storyNodesBySession(db: Database.Database, sessionId: number): StoryNodeListItem[] {
  const row = db.prepare('SELECT campaign_id FROM sessions WHERE id = ?').get(sessionId) as { campaign_id: number } | undefined
  if (!row) return []
  const linked = new Set((db.prepare('SELECT node_id FROM story_node_sessions WHERE session_id = ?')
    .all(sessionId) as Array<{ node_id: number }>).map(r => r.node_id))
  return listStoryNodes(db, row.campaign_id).filter(n => linked.has(n.id))
}

/** Replace the nodes linked to a session (the session side of story_node_sessions) */
export function setSessionStoryNodes(db: Database.Database, sessionId: number, nodeIds: number[]): StoryNodeListItem[] {
  db.transaction(() => {
    const session = db.prepare('SELECT campaign_id FROM sessions WHERE id = ? AND deleted_at IS NULL').get(sessionId) as { campaign_id: number } | undefined
    if (!session) throw new StoryError(404, 'Session not found')
    const wanted = [...new Set(nodeIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
    const valid = wanted.length
      ? (db.prepare(`SELECT id FROM entities WHERE id IN (${wanted.map(() => '?').join(',')}) AND campaign_id = ? AND type_id = ? AND deleted_at IS NULL`)
          .all(...wanted, session.campaign_id, getStoryTypeId(db)) as Array<{ id: number }>).map(r => r.id)
      : []
    db.prepare('DELETE FROM story_node_sessions WHERE session_id = ?').run(sessionId)
    const insert = db.prepare('INSERT INTO story_node_sessions (node_id, session_id) VALUES (?, ?)')
    for (const nodeId of valid) insert.run(nodeId, sessionId)
  })()
  return storyNodesBySession(db, sessionId)
}

export interface StoryOutlineInput {
  name: string
  kind?: StoryNodeKind
  status?: StoryNodeStatus
  description?: string
  hook?: string
  readAloud?: string
  secrets?: string
  outcomes?: string
  children?: StoryOutlineInput[]
}

export interface StoryOutlineResult {
  id: number | null // null in a dry run
  name: string
  kind: StoryNodeKind
  status: StoryNodeStatus
  children: StoryOutlineResult[]
}

export const MAX_OUTLINE_NODES = 500
export const MAX_OUTLINE_DEPTH = 8

/** Without an explicit kind: arc, chapter, then scenes - counted from the top of the tree. */
const kindForDepth = (depth: number): StoryNodeKind => (['arc', 'chapter'] as const)[depth] ?? 'scene'

/**
 * Create a whole nested outline under parentId (null = top level), all or nothing.
 * dryRun validates and returns the resolved outline without writing.
 */
export function createStoryOutline(
  db: Database.Database,
  input: { campaignId: number, parentId?: number | null, nodes: StoryOutlineInput[], dryRun?: boolean },
): { created: number, outline: StoryOutlineResult[] } {
  const { campaignId, dryRun = false } = input
  const parentId = input.parentId ?? null
  if (!campaignId) throw new StoryError(400, 'Campaign ID is required')
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) throw new StoryError(400, 'nodes must be a non-empty array')

  // Validate everything up front so nothing is half-created
  const errors: string[] = []
  let count = 0
  /** Collect validation errors of a level and its children. */
  const check = (nodes: unknown, path: string, depth: number) => {
    if (!Array.isArray(nodes)) {
      errors.push(`${path}: children must be an array`)
      return
    }
    if (depth > MAX_OUTLINE_DEPTH) errors.push(`${path}: nested deeper than ${MAX_OUTLINE_DEPTH} levels`)
    nodes.forEach((raw, i) => {
      const n = raw as StoryOutlineInput
      const at = `${path}[${i}]`
      count++
      if (!n || typeof n.name !== 'string' || !n.name.trim()) errors.push(`${at}: name is required`)
      if (n?.kind !== undefined && !STORY_NODE_KINDS.includes(n.kind)) errors.push(`${at}: invalid kind "${n.kind}" (${STORY_NODE_KINDS.join(', ')})`)
      if (n?.status !== undefined && !STORY_NODE_STATUSES.includes(n.status)) errors.push(`${at}: invalid status "${n.status}" (${STORY_NODE_STATUSES.join(', ')})`)
      for (const f of ['description', ...STORY_NODE_TEXT_FIELDS] as const) {
        if (n?.[f] !== undefined && typeof n[f] !== 'string') errors.push(`${at}: ${f} must be a string`)
      }
      if (n?.children !== undefined) check(n.children, `${at}.children`, depth + 1)
    })
  }
  check(input.nodes, 'nodes', 1)
  if (count > MAX_OUTLINE_NODES) errors.push(`too many entries (${count}, max ${MAX_OUTLINE_NODES} per call)`)
  if (errors.length) throw new StoryError(400, `Invalid outline: ${errors.slice(0, 20).join('; ')}`)

  /** Create (or in a dry run only resolve) the whole outline. */
  const run = () => {
    assertParent(db, campaignId, parentId)
    const startDepth = parentId === null ? 0 : ancestorCount(db, parentId) + 1
    let created = 0
    /** Create one level and recurse into its children. */
    const build = (nodes: StoryOutlineInput[], parent: number | null, depth: number): StoryOutlineResult[] =>
      nodes.map((n) => {
        const kind = n.kind ?? kindForDepth(depth)
        const status = n.status ?? 'idea'
        let id: number | null = null
        if (!dryRun) {
          id = createStoryNode(db, { campaignId, name: n.name, kind, parentId: parent }).id
          const texts = Object.fromEntries((['description', ...STORY_NODE_TEXT_FIELDS] as const)
            .filter(f => n[f]?.trim()).map(f => [f, n[f]]))
          if (status !== 'idea' || Object.keys(texts).length) updateStoryNode(db, id, { ...texts, status })
          created++
        }
        return { id, name: n.name.trim(), kind, status, children: build(n.children ?? [], id, depth + 1) }
      })
    const outline = build(input.nodes, parentId, startDepth)
    return { created, outline }
  }

  return dryRun ? run() : db.transaction(run)()
}

/** Number of ancestors of a node (its depth, 0 at the top). */
function ancestorCount(db: Database.Database, id: number): number {
  const row = db.prepare(`
    WITH RECURSIVE up(id, parent, depth) AS (
      SELECT id, parent_entity_id, 0 FROM entities WHERE id = ?
      UNION ALL
      SELECT e.id, e.parent_entity_id, up.depth + 1 FROM entities e JOIN up ON e.id = up.parent
    )
    SELECT MAX(depth) AS depth FROM up
  `).get(id) as { depth: number | null }
  return row.depth ?? 0
}

/** Turn a StoryError into an HTTP error, rethrow anything else */
export function toHttpError(error: unknown): never {
  if (error instanceof StoryError) {
    throw createError({ statusCode: error.statusCode, message: error.message })
  }
  throw error
}
