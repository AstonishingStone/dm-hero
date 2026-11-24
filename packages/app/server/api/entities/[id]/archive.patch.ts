import { getDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const db = getDb()
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody(event)
  const archive = body.archive !== false // default: archive

  if (isNaN(id)) {
    throw createError({ statusCode: 400, message: 'Invalid entity ID' })
  }

  const entity = db.prepare(`
    SELECT e.id, et.name AS type FROM entities e
    JOIN entity_types et ON et.id = e.type_id
    WHERE e.id = ? AND e.deleted_at IS NULL
  `).get(id) as { id: number, type: string } | undefined

  if (!entity) {
    throw createError({ statusCode: 404, message: 'Entity not found' })
  }
  // The scenario tree has no archive, an archived entry would stay visible there
  if (entity.type === 'StoryNode') {
    throw createError({ statusCode: 400, message: 'Scenario entries cannot be archived' })
  }

  // Transaction: find descendants + update atomically
  const archiveTransaction = db.transaction(() => {
    const descendants = db.prepare(`
      WITH RECURSIVE children AS (
        SELECT id FROM entities WHERE parent_entity_id = ? AND deleted_at IS NULL
        UNION ALL
        SELECT e.id FROM entities e INNER JOIN children c ON e.parent_entity_id = c.id WHERE e.deleted_at IS NULL
      )
      SELECT id FROM children
    `).all(id) as Array<{ id: number }>

    const allIds = [id, ...descendants.map(d => d.id)]
    const placeholders = allIds.map(() => '?').join(',')

    if (archive) {
      db.prepare(`UPDATE entities SET archived_at = datetime('now') WHERE id IN (${placeholders}) AND deleted_at IS NULL`).run(...allIds)
    }
    else {
      db.prepare(`UPDATE entities SET archived_at = NULL WHERE id IN (${placeholders}) AND deleted_at IS NULL`).run(...allIds)
    }

    return allIds
  })

  const affectedIds = archiveTransaction()

  return { success: true, archived: archive, affectedIds }
})
