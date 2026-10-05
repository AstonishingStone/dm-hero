import { getDb } from '../../../utils/db'
import { storyNodesBySession } from '../../../utils/story'

/** Story nodes played in a session */
export default defineEventHandler((event) => {
  const sessionId = Number(getRouterParam(event, 'sessionId'))
  if (!sessionId) {
    throw createError({ statusCode: 400, message: 'Session ID is required' })
  }
  return storyNodesBySession(getDb(), sessionId)
})
