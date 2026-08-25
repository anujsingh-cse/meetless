import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { config } from '@meetless/shared/config'

export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorate('auth', {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async verify(token: string) {
      if (!config.CLERK_SECRET_KEY) return { userId: 'dev-user', email: 'dev@local' }
      throw new Error('Clerk not configured')
    }
  })

  app.addHook('preHandler', async (req) => {
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      try {
        req.user = await app.auth.verify(authHeader.slice(7))
      } catch { /* ignore */ }
    }
  })
}, { name: 'auth', dependencies: ['redis'] })

declare module 'fastify' {
  interface FastifyRequest {
    user?: { userId: string; email: string }
  }
  interface FastifyInstance {
    auth: {
      verify(token: string): Promise<{ userId: string; email: string }>
    }
  }
}
