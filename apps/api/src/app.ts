import Fastify from 'fastify'
import { config } from '@meetless/shared/config'
import { prismaPlugin } from './plugins/prisma.js'
import { redisPlugin } from './plugins/redis.js'
import { authPlugin } from './plugins/auth.js'
import { wsPlugin } from './plugins/websocket.js'
import { healthRoutes } from './routes/health.js'
import { eventRoutes } from './routes/events.js'

export async function buildApp() {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } })
  await app.register(prismaPlugin)
  await app.register(redisPlugin)
  await app.register(authPlugin)
  await app.register(wsPlugin)
  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(eventRoutes, { prefix: '/api' })
  return app
}