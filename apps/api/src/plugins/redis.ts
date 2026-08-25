import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import Redis from 'ioredis'
import { config } from '@meetless/shared/config'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

export const redisPlugin: FastifyPluginAsync = fp(async (app) => {
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 50, 2000)
  })
  redis.on('error', (err) => app.log.error({ err }, 'Redis connection error'))
  app.decorate('redis', redis)
  app.addHook('onClose', async (app) => { await app.redis.quit() })
}, { name: 'redis', dependencies: ['prisma'] })