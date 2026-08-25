import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    redis: Redis
  }
}

const healthResponseSchema = {
  type: 'object',
  required: ['status', 'timestamp'],
  properties: {
    status: { type: 'string', const: 'ok' },
    timestamp: { type: 'string', format: 'date-time' },
  },
} as const

const readyResponseSchema = {
  type: 'object',
  required: ['status', 'checks'],
  properties: {
    status: { type: 'string', enum: ['ready', 'not ready'] },
    checks: {
      type: 'object',
      required: ['database', 'redis'],
      properties: {
        database: { type: 'boolean' },
        redis: { type: 'boolean' },
      },
    },
  },
} as const

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/health', {
    schema: {
      response: {
        200: healthResponseSchema,
      },
    },
  }, async () => ({ status: 'ok' as const, timestamp: new Date().toISOString() }))

  app.get('/health/ready', {
    schema: {
      response: {
        200: readyResponseSchema,
        503: readyResponseSchema,
      },
    },
  }, async (req, reply) => {
    const checks = { database: false, redis: false }
    try { await app.prisma.$queryRaw`SELECT 1`; checks.database = true } catch { /* ignore */ }
    try { await app.redis.ping(); checks.redis = true } catch { /* ignore */ }
    const ready = checks.database && checks.redis
    reply.code(ready ? 200 : 503)
    return { status: ready ? 'ready' as const : 'not ready' as const, checks }
  })
}