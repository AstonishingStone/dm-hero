import { getDb } from '../../utils/db'
import { createStoryNode, toHttpError } from '../../utils/story'
import type { StoryNodeKind } from '~~/types/story'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ campaignId: number, name: string, kind?: StoryNodeKind, parentId?: number | null }>(event)
  try {
    return createStoryNode(getDb(), body ?? {})
  }
  catch (error) {
    toHttpError(error)
  }
})
