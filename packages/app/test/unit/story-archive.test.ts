import { describe, it, expect, beforeAll, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getTestDb } from '../utils/test-db'
import { createStoryNode } from '../../server/utils/story'

// Scenario entries have no archive: the generic entity route must not touch them
let db: Database.Database

vi.mock('../../server/utils/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/utils/db')>()
  return { ...original, getDb: () => db }
})

let id: number
beforeAll(() => {
  db = getTestDb()
  const g = globalThis as Record<string, unknown>
  g.defineEventHandler = (handler: unknown) => handler
  g.getRouterParam = () => String(id)
  g.readBody = async () => ({ archive: true })
  g.createError = (o: { statusCode: number, message: string }) => Object.assign(new Error(o.message), { statusCode: o.statusCode })
})

const archive = async () => ((await import('../../server/api/entities/[id]/archive.patch')).default as (e: unknown) => Promise<unknown>)({})
const archivedAt = () => (db.prepare('SELECT archived_at FROM entities WHERE id = ?').get(id) as { archived_at: string | null }).archived_at

describe('archiving through the generic entity route', () => {
  it('refuses a scenario entry', async () => {
    const campaignId = Number(db.prepare('INSERT INTO campaigns (name) VALUES (?)').run('Story').lastInsertRowid)
    id = createStoryNode(db, { campaignId, name: 'Scene' }).id

    await expect(archive()).rejects.toMatchObject({ statusCode: 400 })
    expect(archivedAt()).toBeNull()
  })

  it('still archives other entities', async () => {
    id = (db.prepare('SELECT e.id FROM entities e JOIN entity_types t ON t.id = e.type_id WHERE t.name = ? LIMIT 1').get('NPC') as { id: number }).id

    await archive()
    expect(archivedAt()).not.toBeNull()
  })
})
