import { getDb } from '../../../utils/db'
import { toHttpError, updateStoryNode, type StoryNodePatch } from '../../../utils/story'

/** Partial update - fields left out stay as they are */
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!id) {
    throw createError({ statusCode: 400, message: 'Node ID is required' })
  }
  const body = await readBody<StoryNodePatch>(event)
  try {
    return updateStoryNode(getDb(), id, body ?? {})
  }
  catch (error) {
    toHttpError(error)
  }
})
